"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
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
  ".md", ".markdown", ".mdown", ".mkd", ".mdx", ".text", ".txt", ".",
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

  win.on("closed", () => windowState.delete(win.id));

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

async function openInWindow(win, filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const state = windowState.get(win.id);
    if (state) {
      state.filePath = filePath;
      state.dirty = false;
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

    win.webContents.send("file:opened", { filePath, content, recovery });
  } catch (err) {
    dialog.showMessageBox(win, {
      type: "error",
      message: "Couldn't open file",
      detail: `${filePath}\n\n${err.message}`,
    });
  }
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
  }
  win.setRepresentedFilename(target);
  win.setTitle(path.basename(target));
  win.setDocumentEdited(false);
  app.addRecentDocument(target);
  await clearRecovery(target);
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
  }
  win.setRepresentedFilename(res.filePath);
  win.setTitle(path.basename(res.filePath));
  win.setDocumentEdited(false);
  app.addRecentDocument(res.filePath);
  await clearRecovery(res.filePath);
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
