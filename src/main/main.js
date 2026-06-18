"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { watch } = require("node:fs");
const crypto = require("node:crypto");
const { buildMenu } = require("./menu");
const { startControlServer, stopControlServer } = require("./control");
const { publishToGoogleDocs } = require("./gdocs");

let controlServer = null;

// Single instance: one process owns the control socket + all windows. A second
// `open`/launch forwards its file args to the primary via `second-instance`.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const p = argv.slice(1).find((a) => looksLikeOpenableFile(a) && path.isAbsolute(a));
    if (p) routeOpen(p, {});
    else focusFront();
  });
}

// Deep links: plume://open?path=/abs/file.md&line=12[&new=1]
app.setAsDefaultProtocolClient("plume");
function handlePlumeUrl(url) {
  try {
    const u = new URL(url);
    if (u.host !== "open" && !u.pathname.includes("open")) return;
    const p = u.searchParams.get("path");
    if (!p) return;
    const abs = decodeURIComponent(p);
    const line = parseInt(u.searchParams.get("line"), 10) || undefined;
    const newWindow = u.searchParams.get("new") === "1";
    if (appReady) routeOpen(abs, { line, newWindow });
    else pendingPaths.push(abs);
  } catch { /* ignore malformed */ }
}
app.on("open-url", (event, url) => { event.preventDefault(); handlePlumeUrl(url); });

function recoveryFileFor(filePath) {
  const dir = path.join(app.getPath("userData"), "recovery");
  const key = crypto.createHash("sha1").update(filePath).digest("hex");
  return { dir, file: path.join(dir, key + ".json") };
}

async function clearRecovery(filePath) {
  if (!filePath) return;
  try { await fs.unlink(recoveryFileFor(filePath).file); } catch { /* none */ }
}

// Steer-loop annotations live in a sidecar so the .md stays clean:
//   /dir/foo.md  ->  /dir/.plume/foo.md.notes.json
function annotationsFileFor(filePath) {
  const dir = path.join(path.dirname(filePath), ".plume");
  return { dir, file: path.join(dir, path.basename(filePath) + ".notes.json") };
}
async function readAnnotations(filePath) {
  if (!filePath) return [];
  try { return JSON.parse(await fs.readFile(annotationsFileFor(filePath).file, "utf8")); }
  catch { return []; }
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

function createWindow(filePath = null, gotoLine = undefined) {
  let pendingGoto = gotoLine;
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
    if (target) { await openInWindow(win, target, pendingGoto); pendingGoto = undefined; }
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

/** Bring a window (or the app) to the foreground — used when opened from the CLI. */
function focusFront(win) {
  const w = win || BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  try { app.focus({ steal: true }); } catch { /* not always available */ }
}

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

/** Evaluate an expression against the focused window's agent surface (main world). */
async function askRenderer(expr) {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return null;
  try { return await win.webContents.executeJavaScript(`(window.__plumeAgent ? ${expr} : null)`); }
  catch { return null; }
}

/** Route an incoming path to a sensible window: focus if already open, reuse a blank one, else new. */
function routeOpen(filePath, { line, newWindow } = {}) {
  if (newWindow) { focusFront(createWindow(filePath, line)); return; }
  // Already open somewhere → focus it (and re-jump to the line if given).
  for (const win of BrowserWindow.getAllWindows()) {
    const st = windowState.get(win.id);
    if (st && st.filePath === filePath) {
      if (line) openInWindow(win, filePath, line);
      focusFront(win);
      return;
    }
  }
  // Reuse a blank, clean, focused window if there is one.
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    const state = windowState.get(focused.id);
    if (state && !state.filePath && !state.dirty) {
      openInWindow(focused, filePath, line);
      focusFront(focused);
      return;
    }
  }
  focusFront(createWindow(filePath, line));
}

/** Open a folder in the sidebar (no file loaded) — backs `plume .`. */
function openFolder(dir) {
  const focused = BrowserWindow.getFocusedWindow();
  let win, fresh = false;
  if (focused) {
    const st = windowState.get(focused.id);
    if (st && !st.filePath && !st.dirty) win = focused;
  }
  if (!win) { win = createWindow(); fresh = true; }
  const send = () => { if (!win.isDestroyed()) win.webContents.send("folder:open", { dir }); };
  if (fresh) win.webContents.once("did-finish-load", send);
  else send();
  focusFront(win);
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

// ---------- Claude Code sessions + project context ----------
const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");
// Claude Code dashifies the project's absolute path: both "/" and "." become "-".
function dashify(dir) { return dir.replace(/[/.]/g, "-"); }
const CONTEXT_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", "README.md", "TODO.md"];

async function projectDirsFor(dir) {
  if (dir) { const d = path.join(CLAUDE_PROJECTS, dashify(dir)); if (await isDir(d)) return [d]; }
  try {
    const entries = await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(CLAUDE_PROJECTS, e.name));
  } catch { return []; }
}

async function sessionMeta(file) {
  let title = "(empty session)", ts = 0;
  try {
    const stat = await fs.stat(file); ts = stat.mtimeMs;
    const fh = await fs.open(file, "r");
    const buf = Buffer.alloc(32768);
    const { bytesRead } = await fh.read(buf, 0, 32768, 0);
    await fh.close();
    for (const ln of buf.toString("utf8", 0, bytesRead).split("\n")) {
      if (!ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.type === "user") {
        const c = o.message?.content;
        let t = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text || "").join(" ") : "";
        t = t.trim();
        if (t && !t.startsWith("<") && !t.startsWith("Caveat")) { title = t.slice(0, 90); break; }
      }
    }
  } catch { /* skip */ }
  return { path: file, title, ts };
}

ipcMain.handle("sessions:list", async (_e, { dir }) => {
  const out = [];
  for (const pd of await projectDirsFor(dir)) {
    let files; try { files = (await fs.readdir(pd)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) out.push(await sessionMeta(path.join(pd, f)));
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, 80);
});

ipcMain.handle("sessions:search", async (_e, { query, dir }) => {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const results = []; let scanned = 0;
  for (const pd of await projectDirsFor(dir)) {
    let files; try { files = (await fs.readdir(pd)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      if (results.length >= 40 || scanned > 500) break;
      scanned++;
      const full = path.join(pd, f);
      // Cap per-file reads at 4 MB so searching across many large transcripts stays responsive.
      let txt;
      try {
        const fh = await fs.open(full, "r");
        const buf = Buffer.alloc(4 * 1024 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        await fh.close();
        txt = buf.toString("utf8", 0, bytesRead);
      } catch { continue; }
      const idx = txt.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const snippet = txt.slice(Math.max(0, idx - 40), idx + 90).replace(/\s+/g, " ").trim();
        results.push({ ...(await sessionMeta(full)), snippet });
      }
    }
  }
  results.sort((a, b) => b.ts - a.ts);
  return results;
});

ipcMain.handle("context:list", async (_e, { dir }) => {
  if (!dir) return [];
  const out = [];
  for (const name of CONTEXT_FILES) {
    const full = path.join(dir, name);
    try { if ((await fs.stat(full)).isFile()) out.push({ name, path: full }); } catch { /* absent */ }
  }
  return out;
});

// Read a file for inline insertion. Claude Code `.jsonl` transcripts are distilled
// to readable markdown (user/assistant prose only); other files insert as-is.
ipcMain.handle("session:read", async (_e, { filePath }) => {
  if (!filePath) return "";
  let raw;
  try { raw = await fs.readFile(filePath, "utf8"); } catch { return ""; }
  if (!filePath.endsWith(".jsonl")) return raw;
  const out = [];
  let budget = 40000;
  for (const line of raw.split("\n")) {
    if (budget <= 0) break;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj.message || obj;
    const role = msg.role || obj.type;
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    const c = msg.content;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n");
    }
    text = text.trim();
    if (!text) continue;
    const chunk = `${role === "assistant" ? "**Claude:**" : "**You:**"}\n\n${text}\n`;
    out.push(chunk.slice(0, budget));
    budget -= chunk.length;
  }
  return out.join("\n");
});

ipcMain.handle("annotations:load", async (_e, { filePath }) => readAnnotations(filePath));

ipcMain.handle("annotations:save", async (_e, { filePath, annotations }) => {
  if (!filePath) return false;
  try {
    const { dir, file } = annotationsFileFor(filePath);
    if (Array.isArray(annotations) && annotations.length === 0) { await fs.unlink(file).catch(() => {}); return true; }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(annotations, null, 2), "utf8");
    return true;
  } catch { return false; }
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

ipcMain.handle("image:pick", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = windowState.get(win.id);
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tiff"] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  if (!state?.filePath) return { error: "unsaved" };
  try {
    const src = res.filePaths[0];
    const dir = path.join(path.dirname(state.filePath), "assets");
    await fs.mkdir(dir, { recursive: true });
    const name = `image-${Date.now()}${path.extname(src) || ".png"}`;
    await fs.copyFile(src, path.join(dir, name));
    return { rel: `assets/${name}` };
  } catch (err) {
    dialog.showMessageBox(win, { type: "error", message: "Couldn't add image", detail: err.message });
    return null;
  }
});

function decodeEntities(s) {
  return (s || "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
      if (named[e]) return named[e];
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    });
}

const previewCache = new Map();
ipcMain.handle("link:preview", async (_e, { url }) => {
  if (!/^https?:\/\//i.test(url)) return null;
  if (previewCache.has(url)) return previewCache.get(url);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Plume/1.0", accept: "text/html,*/*" },
      signal: AbortSignal.timeout(6000),
    });
    const host = new URL(res.url || url).hostname.replace(/^www\./, "");
    const ct = res.headers.get("content-type") || "";
    const cache = (r) => { if (previewCache.size > 300) previewCache.clear(); previewCache.set(url, r); return r; };
    if (ct.startsWith("image/")) return cache({ isImage: true, image: res.url || url, title: host, site: host });
    if (!ct.includes("html")) return cache({ title: host, description: "", image: "", site: host });
    const html = (await res.text()).slice(0, 600000);
    const meta = (prop) => {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
      const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
      const m = html.match(re) || html.match(re2);
      return m ? decodeEntities(m[1]) : "";
    };
    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
    let image = meta("og:image") || meta("twitter:image");
    if (image && !/^https?:/i.test(image)) { try { image = new URL(image, res.url || url).href; } catch { image = ""; } }
    return cache({
      title: meta("og:title") || decodeEntities(titleTag).trim() || host,
      description: meta("og:description") || meta("description") || "",
      image,
      site: meta("og:site_name") || host,
    });
  } catch {
    return null;
  }
});

ipcMain.handle("doc:publishGoogle", async (event, { content, defaultName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  try {
    const url = await publishToGoogleDocs(content, defaultName, (u) => shell.openExternal(u));
    const choice = dialog.showMessageBoxSync(win, {
      type: "info", message: "Published to Google Docs", detail: url,
      buttons: ["Open in Browser", "Copy Link", "Done"], defaultId: 0, cancelId: 2,
    });
    if (choice === 0) shell.openExternal(url);
    else if (choice === 1) clipboard.writeText(url);
    return url;
  } catch (e) {
    if (e.code === "NO_CREDS") {
      dialog.showMessageBox(win, {
        type: "info", message: "Connect Plume to Google Docs (one-time setup)",
        detail:
          "Google requires your own OAuth client (Plume can't ship one).\n\n" +
          "1. console.cloud.google.com → enable the Google Docs API.\n" +
          "2. APIs & Services → Credentials → Create OAuth client ID → type \"Desktop app\".\n" +
          "3. Save it to ~/.plume/google.json:\n     { \"client_id\": \"…\", \"client_secret\": \"…\" }\n" +
          "4. Publish again — a browser tab will ask you to authorize.\n\n" +
          "Details in docs/agent-setup.md.",
      });
      return null;
    }
    if (e.code === "EMPTY") { dialog.showMessageBox(win, { type: "warning", message: "Nothing to publish" }); return null; }
    dialog.showMessageBox(win, { type: "error", message: "Publish to Google Docs failed", detail: String(e.message || e) });
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
  if (appReady) routeOpen(filePath, {});
  else pendingPaths.push(filePath);
});

app.whenReady().then(() => {
  appReady = true;
  buildMenu({ createWindow, installCli });

  // The control socket: the `plume` CLI and the MCP server talk to us here.
  controlServer = startControlServer({
    ping: () => ({ ok: true, version: app.getVersion() }),
    focus: () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); focusFront(); return { ok: true }; },
    open: async (req) => {
      const target = req.path;
      if (req.dir || (target && (await isDir(target)))) { openFolder(req.dir || target); return { ok: true }; }
      if (!target) { focusFront(); return { ok: false, error: "no path" }; }
      routeOpen(target, { line: req.line, newWindow: req.newWindow });
      return { ok: true };
    },
    // ---- Agent surface (MCP) ----
    getActiveDocument: async () => {
      const data = await askRenderer("window.__plumeAgent.getActiveDocument()");
      return data ? { ok: true, ...data } : { ok: false, error: "no active document" };
    },
    getSelection: async () => {
      const data = await askRenderer("window.__plumeAgent.getSelection()");
      return data ? { ok: true, ...data } : { ok: false, error: "no active document" };
    },
    listOpenFiles: () => {
      const focused = BrowserWindow.getFocusedWindow();
      const files = BrowserWindow.getAllWindows().map((w) => {
        const st = windowState.get(w.id);
        return { path: st?.filePath || null, dirty: !!st?.dirty, focused: w === focused };
      });
      return { ok: true, files };
    },
    getAnnotations: async (req) => {
      let p = req.path;
      if (!p) { const data = await askRenderer("window.__plumeAgent.getActiveDocument()"); p = data?.path; }
      if (!p) return { ok: false, error: "no path" };
      return { ok: true, path: p, annotations: await readAnnotations(p) };
    },
    writeDocument: async (req) => {
      if (!req.path || typeof req.content !== "string") return { ok: false, error: "path and content required" };
      try { await fs.writeFile(req.path, req.content, "utf8"); return { ok: true, path: req.path }; }
      catch (err) { return { ok: false, error: String(err.message || err) }; }
    },
  });

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

app.on("will-quit", () => stopControlServer(controlServer));

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * Install the `plume` CLI onto PATH (the VS Code `code` pattern). Copies the
 * bundled bin/plume.js to the first writable bin dir and marks it executable.
 */
async function installCli() {
  const bins = [
    { src: path.join(app.getAppPath(), "bin", "plume.js"), name: "plume" },
    { src: path.join(app.getAppPath(), "bin", "plume-mcp.js"), name: "plume-mcp" },
  ];
  const targets = ["/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  for (const dir of targets) {
    try {
      await fs.mkdir(dir, { recursive: true });
      for (const b of bins) {
        const script = await fs.readFile(b.src, "utf8");
        const dest = path.join(dir, b.name);
        await fs.writeFile(dest, script, "utf8");
        fsSync.chmodSync(dest, 0o755);
      }
      const onPath = (process.env.PATH || "").split(":").includes(dir);
      await dialog.showMessageBox({
        type: "info",
        message: "Installed 'plume' and 'plume-mcp'",
        detail:
          `Wrote them to ${dir}.` +
          (onPath ? "" : `\n\n${dir} isn't on your PATH yet — add it first.`) +
          `\n\nOpen files:    plume <file.md>` +
          `\nConnect agent: claude mcp add plume -- plume-mcp`,
      });
      return;
    } catch { /* try next dir */ }
  }
  dialog.showMessageBox({
    type: "warning",
    message: "Couldn't write the commands automatically",
    detail: `Run this in a terminal instead:\n\nsudo cp "${bins[0].src}" /usr/local/bin/plume && sudo cp "${bins[1].src}" /usr/local/bin/plume-mcp && sudo chmod 755 /usr/local/bin/plume /usr/local/bin/plume-mcp`,
  });
}
