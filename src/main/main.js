"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { watch } = require("node:fs");
const crypto = require("node:crypto");
const { buildMenu } = require("./menu");

function recoveryFileFor(filePath) {
  const dir = path.join(app.getPath("userData"), "recovery");
  const key = crypto.createHash("sha1").update(filePath).digest("hex");
  return { dir, file: path.join(dir, key + ".json") };
}

async function clearRecovery(filePath) {
  if (!filePath) return;
  try { await fs.unlink(recoveryFileFor(filePath).file); } catch { /* none */ }
}

/** @type {Map<number, { filePath: string|null, dirty: boolean }>} */
const windowState = new Map();

/** Files queued by macOS `open-file` before the app is ready. */
const pendingPaths = [];
let appReady = false;

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdown", ".mkd", ".mdx", ".text", ".txt",
  ".json", ".jsonc", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml",
  ".env", ".ini", ".diff", ".patch", ".log", ".csv", ".tsv", ".mmd",
  ".xml", ".sh", ".bash", ".zsh", ".js", ".ts", ".py", ".rs", ".go",
]);

function looksLikeOpenableFile(p) {
  if (!p || typeof p !== "string") return false;
  if (p === ".") return false;
  const ext = path.extname(p).toLowerCase();
  // Allow extension-less files too (many READMEs / notes); reject obvious non-files.
  return ext === "" || TEXT_EXTENSIONS.has(ext);
}

function createWindow(filePath = null) {
  const win = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    title: "Plume",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1c1c1e",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  windowState.set(win.id, { filePath: null, dirty: false });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Re-open on every load (not just the first) so a reload or renderer crash
  // restores the document instead of dropping back to an empty window.
  win.webContents.on("did-finish-load", async () => {
    const state = windowState.get(win.id);
    const target = state?.filePath || filePath;
    if (target) await openInWindow(win, target);
  });

  win.on("closed", () => {
    const state = windowState.get(win.id);
    if (state?.watcher) { try { state.watcher.close(); } catch { /* ignore */ } }
    windowState.delete(win.id);
  });

  // Intercept the red-button close when there are unsaved changes.
  win.on("close", (e) => {
    const state = windowState.get(win.id);
    if (state && state.dirty) {
      const choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Save", "Don't Save", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        message: "Save changes before closing?",
        detail: state.filePath
          ? path.basename(state.filePath)
          : "Untitled document",
      });
      if (choice === 2) {
        e.preventDefault();
      } else if (choice === 0) {
        e.preventDefault();
        win.webContents.send("menu:save", { thenClose: true });
      }
      // choice === 1 → fall through and close without saving
    }
  });

  return win;
}

async function openInWindow(win, filePath, gotoLine) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const state = windowState.get(win.id);
    if (state) {
      state.filePath = filePath;
      state.dirty = false;
      state.knownContent = content;
    }
    win.setRepresentedFilename(filePath);
    win.setTitle(path.basename(filePath));
    win.setDocumentEdited(false);
    app.addRecentDocument(filePath);

    // Surface a crash-recovery snapshot if one is newer than the file on disk.
    let recovery = null;
    try {
      const snap = JSON.parse(await fs.readFile(recoveryFileFor(filePath).file, "utf8"));
      const stat = await fs.stat(filePath);
      if (snap.content !== content && snap.ts > stat.mtimeMs) recovery = snap.content;
    } catch { /* no recovery */ }

    win.webContents.send("file:opened", { filePath, content, recovery, gotoLine });
    setupWatcher(win, filePath);
  } catch (err) {
    dialog.showMessageBox(win, {
      type: "error",
      message: "Couldn't open file",
      detail: `${filePath}\n\n${err.message}`,
    });
  }
}

/**
 * Watch the open file's directory and push external changes to the renderer.
 * Watching the directory (not the file) survives atomic writes (temp + rename),
 * which is how editors and agents commonly write. Self-writes are ignored by
 * comparing against the content we last delivered/saved (state.knownContent).
 */
function setupWatcher(win, filePath) {
  const state = windowState.get(win.id);
  if (!state) return;
  if (state.watcher) { try { state.watcher.close(); } catch { /* ignore */ } state.watcher = null; }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let timer = null;
  try {
    state.watcher = watch(dir, (_event, changed) => {
      if (changed && changed !== base) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (win.isDestroyed()) return;
        const cur = windowState.get(win.id);
        if (!cur || cur.filePath !== filePath) return;
        let content;
        try { content = await fs.readFile(filePath, "utf8"); } catch { return; }
        if (content === cur.knownContent) return; // our own write, or no real change
        cur.knownContent = content;
        win.webContents.send("file:externalChange", { content });
      }, 120);
    });
  } catch { /* directory may be unwatchable; skip */ }
}

/** Route an incoming path to a sensible window: reuse a blank/focused one or make a new one. */
function openPath(filePath) {
  const focused = BrowserWindow.getFocusedWindow();
  // If the focused window is empty and clean, load into it; otherwise new window.
  if (focused) {
    const state = windowState.get(focused.id);
    if (state && !state.filePath && !state.dirty) {
      openInWindow(focused, filePath);
      return;
    }
  }
  createWindow(filePath);
}

// ---------- IPC ----------

ipcMain.handle("file:openDialog", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx"] },
      { name: "Text", extensions: ["txt", "text"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  await openInWindow(win, res.filePaths[0]);
  return res.filePaths[0];
});

ipcMain.handle("file:save", async (event, { content }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = windowState.get(win.id);
  let target = state?.filePath;
  if (!target) {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: "Untitled.md",
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  await fs.writeFile(target, content, "utf8");
  if (state) {
    state.filePath = target;
    state.dirty = false;
    state.knownContent = content;
  }
  win.setRepresentedFilename(target);
  win.setTitle(path.basename(target));
  win.setDocumentEdited(false);
  app.addRecentDocument(target);
  await clearRecovery(target);
  setupWatcher(win, target);
  return target;
});

ipcMain.handle("file:saveAs", async (event, { content }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = windowState.get(win.id);
  const res = await dialog.showSaveDialog(win, {
    defaultPath: state?.filePath || "Untitled.md",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, content, "utf8");
  if (state) {
    state.filePath = res.filePath;
    state.dirty = false;
    state.knownContent = content;
  }
  win.setRepresentedFilename(res.filePath);
  win.setTitle(path.basename(res.filePath));
  win.setDocumentEdited(false);
  app.addRecentDocument(res.filePath);
  await clearRecovery(res.filePath);
  setupWatcher(win, res.filePath);
  return res.filePath;
});

ipcMain.on("doc:snapshot", async (event, { content }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = windowState.get(win?.id);
  if (!state?.filePath) return; // only path-backed docs are recovered in v1
  try {
    const { dir, file } = recoveryFileFor(state.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ filePath: state.filePath, content, ts: Date.now() }), "utf8");
  } catch { /* best effort */ }
});

ipcMain.on("recovery:discard", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = windowState.get(win?.id);
  clearRecovery(state?.filePath);
});

ipcMain.on("doc:dirty", (event, dirty) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const state = windowState.get(win.id);
  if (state) state.dirty = dirty;
  win.setDocumentEdited(dirty);
});

ipcMain.on("file:openExternal", (event, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle("file:resolveLink", async (event, { href }) => {
  // Resolve a relative link target against the current document's directory.
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = windowState.get(win.id);
  if (!state?.filePath) return null;
  const dir = path.dirname(state.filePath);
  let target = path.resolve(dir, decodeURIComponent(href));
  const candidates = [target];
  if (!path.extname(target)) candidates.push(`${target}.md`, `${target}.markdown`);
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isFile()) return c;
    } catch { /* keep trying */ }
  }
  return null;
});

ipcMain.handle("file:openInNewWindow", async (event, { filePath }) => {
  createWindow(filePath);
});

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "release", ".cache", "__pycache__", ".next", ".venv", "assets",
]);

async function listTree(dir, depth) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  entries = entries.filter((e) => !e.name.startsWith(".") && !IGNORE_DIRS.has(e.name));
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
  );
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: full, type: "dir", children: depth > 0 ? await listTree(full, depth - 1) : [] });
    } else {
      out.push({ name: e.name, path: full, type: "file" });
    }
  }
  return out;
}

ipcMain.handle("dir:list", async (_e, { dir, depth = 3 }) => (dir ? listTree(dir, depth) : []));

ipcMain.handle("search:files", async (_e, { dir, query }) => {
  if (!dir || !query || query.length < 2) return [];
  const q = query.toLowerCase();
  const results = [];
  let scanned = 0;
  async function walk(d, depth) {
    if (depth < 0 || results.length >= 200 || scanned > 2000) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      if (en.name.startsWith(".") || IGNORE_DIRS.has(en.name)) continue;
      const full = path.join(d, en.name);
      if (en.isDirectory()) { await walk(full, depth - 1); continue; }
      const ext = path.extname(en.name).toLowerCase();
      if (ext && !TEXT_EXTENSIONS.has(ext)) continue;
      scanned++;
      try {
        const st = await fs.stat(full);
        if (st.size > 1024 * 1024) continue;
        const lines = (await fs.readFile(full, "utf8")).split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            results.push({ path: full, name: en.name, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (results.length >= 200) return;
          }
        }
      } catch { /* skip */ }
    }
  }
  await walk(dir, 4);
  return results;
});

ipcMain.handle("file:openInThisWindow", async (event, { filePath, gotoLine }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) await openInWindow(win, filePath, gotoLine);
});

ipcMain.handle("image:save", async (event, { bytes, ext }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = windowState.get(win.id);
  if (!state?.filePath) return null; // need a saved file to anchor the relative path
  try {
    const dir = path.join(path.dirname(state.filePath), "assets");
    await fs.mkdir(dir, { recursive: true });
    const name = `image-${Date.now()}.${(ext || "png").replace(/[^a-z0-9]/gi, "")}`;
    await fs.writeFile(path.join(dir, name), Buffer.from(bytes));
    return `assets/${name}`;
  } catch (err) {
    dialog.showMessageBox(win, { type: "error", message: "Couldn't save image", detail: err.message });
    return null;
  }
});

ipcMain.handle("doc:export", async (event, { format, html, defaultName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ext = format === "pdf" ? "pdf" : format === "docx" ? "docx" : "html";
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `${defaultName || "document"}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  const target = res.filePath;
  try {
    if (format === "pdf") {
      const tmp = path.join(app.getPath("temp"), `plume-export-${Date.now()}.html`);
      await fs.writeFile(tmp, html, "utf8");
      const pdfWin = new BrowserWindow({ show: false });
      await pdfWin.loadFile(tmp);
      const data = await pdfWin.webContents.printToPDF({
        printBackground: true,
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      });
      await fs.writeFile(target, data);
      pdfWin.destroy();
      fs.unlink(tmp).catch(() => {});
    } else if (format === "docx") {
      const htmlToDocx = require("html-to-docx");
      const buf = await htmlToDocx(html);
      await fs.writeFile(target, Buffer.from(buf));
    } else {
      await fs.writeFile(target, html, "utf8");
    }
    return target;
  } catch (err) {
    dialog.showMessageBox(win, { type: "error", message: "Export failed", detail: err.message });
    return null;
  }
});

// ---------- App lifecycle ----------

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (appReady) openPath(filePath);
  else pendingPaths.push(filePath);
});

app.whenReady().then(() => {
  appReady = true;
  buildMenu({ createWindow });

  // CLI arg (e.g. `electron . note.md`)
  const argPath = process.argv
    .slice(app.isPackaged ? 1 : 2)
    .find((a) => looksLikeOpenableFile(a) && path.isAbsolute(a));

  if (pendingPaths.length > 0) {
    pendingPaths.forEach((p) => createWindow(p));
  } else if (argPath) {
    createWindow(argPath);
  } else {
    createWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
