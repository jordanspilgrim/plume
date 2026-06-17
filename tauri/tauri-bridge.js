// Tauri implementation of the `window.plume` API. Lets the existing renderer
// (built for Electron's contextBridge) run unchanged in WKWebView. See
// src-tauri/MIGRATION.md for what's ported vs remaining.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let onOpenFile = null;
let onExternalChange = null;
let onFolderOpen = null;
let onMenuCb = null;
let currentPath = null;

listen("file-opened", (e) => {
  currentPath = e.payload.filePath;
  if (onOpenFile) onOpenFile(e.payload);
});
listen("file-changed", (e) => { if (onExternalChange) onExternalChange(e.payload); });
listen("folder-opened", (e) => { if (onFolderOpen) onFolderOpen(e.payload); });
listen("menu", (e) => { if (onMenuCb) onMenuCb(e.payload.channel, e.payload.arg); });

// Agent round-trip: the control socket asks the renderer for live state.
listen("agent-request", (e) => {
  const { id, kind } = e.payload;
  let data = null;
  try {
    if (window.__plumeAgent && typeof window.__plumeAgent[kind] === "function") {
      data = window.__plumeAgent[kind]();
    }
  } catch (err) { /* ignore */ }
  invoke("agent_reply", { id, data });
});

const noop = () => {};

window.plume = {
  // events
  onOpenFile: (cb) => { onOpenFile = cb; },
  onExternalChange: (cb) => { onExternalChange = cb; },
  onFolderOpen: (cb) => { onFolderOpen = cb; },
  onMenu: (cb) => { onMenuCb = cb; },

  // files
  openDialog: () => invoke("open_dialog").catch(() => null),
  openInThisWindow: async (filePath, gotoLine) => {
    try {
      const content = await invoke("read_path", { path: filePath });
      currentPath = filePath;
      if (onOpenFile) onOpenFile({ filePath, content, gotoLine });
    } catch { /* ignore */ }
  },
  save: async (content) => {
    try { return await invoke("write_file", { path: currentPath, content }); }
    catch { return null; }
  },
  saveAs: async (content) => {
    const p = await invoke("save_dialog", { content }).catch(() => null);
    if (p) currentPath = p;
    return p;
  },
  resolveLink: (href) => invoke("resolve_link", { href, base: currentPath }).catch(() => null),
  listDir: (dir, depth) => invoke("list_dir", { dir, depth: depth || 3 }).catch(() => []),
  searchFiles: (dir, query) => invoke("search_files", { dir, query }).catch(() => []),
  openExternal: (url) => { invoke("open_external", { url }).catch(noop); },

  // annotations + recovery
  loadAnnotations: (filePath) => invoke("load_annotations", { path: filePath }).catch(() => []),
  saveAnnotations: (filePath, annotations) =>
    invoke("save_annotations", { path: filePath, annotations }).catch(() => false),
  snapshot: (content) => { invoke("snapshot", { content }).catch(noop); },
  discardRecovery: noop,

  // Claude Code sessions + context
  listSessions: (dir) => invoke("list_sessions", { dir }).catch(() => []),
  searchSessions: (query, dir) => invoke("search_sessions", { query, dir }).catch(() => []),
  listContext: (dir) => invoke("list_context", { dir }).catch(() => []),

  // still pending the full port (stubbed)
  openInNewWindow: async () => null, // TODO: multi-window
  exportDoc: async () => null,       // TODO: PDF (WKWebView createPDF) + DOCX
  publishGoogle: async () => null,   // TODO: gdocs via sidecar
  saveImage: async () => null,       // TODO
  pickImage: async () => null,       // TODO: dialog image pick
  linkPreview: async () => null,     // TODO: rust unfurl
  setDirty: noop,                    // window edited indicator (cosmetic)
};

// Pull the launch file once the renderer has registered its handler.
invoke("initial_file")
  .then((f) => {
    if (f && f.path) {
      currentPath = f.path;
      const fire = () => { if (onOpenFile) onOpenFile({ filePath: f.path, content: f.content }); };
      if (onOpenFile) fire(); else setTimeout(fire, 0);
    }
  })
  .catch(noop);
