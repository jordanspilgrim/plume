// Tauri implementation of the `window.plume` API. Lets the existing renderer
// (built for Electron's contextBridge) run unchanged in WKWebView. See
// src-tauri/MIGRATION.md for what's ported vs remaining.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

let onOpenFile = null;
let onExternalChange = null;
let onCloseRequested = null;
let onMenuCb = null;
let currentPath = null;

// file-changed is per-window: the native side emits { path, content } only to
// the window whose document changed on disk. (The legacy "file-opened" /
// "folder-opened" channels were never emitted by the Tauri side — removed.)
listen("file-changed", (e) => { if (onExternalChange) onExternalChange(e.payload); });
// Native side held a close because this window's untitled buffer has unsaved
// edits — the renderer prompts, then saves/materializes or calls confirmClose().
listen("close-requested", () => { if (onCloseRequested) onCloseRequested(); });
// Native side (CLI / double-click / File>Open) asks THIS window to open a path.
// Route through smartOpen so an empty window is reused and anything else opens a new
// window on top — instead of the old global broadcast that hit every window.
listen("open-file", (e) => {
  const { path, line } = e.payload || {};
  if (path && window.__plume && window.__plume.smartOpen) window.__plume.smartOpen(path, line);
});
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
  onFolderOpen: () => {}, // legacy Electron channel — never emitted by the Tauri side
  onCloseRequested: (cb) => { onCloseRequested = cb; },
  onMenu: (cb) => { onMenuCb = cb; },

  // Push the renderer's recents list so the native File > Open Recent menu reflects it.
  setRecentFiles: (paths) => invoke("set_recent_files", { paths }).catch(() => {}),

  // files
  openDialog: () => invoke("open_dialog").catch(() => null),
  openInThisWindow: async (filePath, gotoLine) => {
    try {
      const r = await invoke("read_path", { path: filePath });
      currentPath = filePath;
      if (onOpenFile) onOpenFile({ filePath, content: r.content, recovery: r.recovery, gotoLine });
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
  materializeDoc: async (dir, name, content) => {
    const p = await invoke("materialize_doc", { dir, name, content }).catch(() => null);
    if (p) currentPath = p;
    return p;
  },
  renameFile: async (newName) => {
    if (!currentPath) return null;
    const p = await invoke("rename_file", { oldPath: currentPath, newName }).catch(() => null);
    if (p) currentPath = p;
    return p;
  },
  pickFolder: () => invoke("pick_folder").catch(() => null),
  defaultDocsDir: () => invoke("default_docs_dir").catch(() => null),
  pushToAgent: (projectKey, name, content) => invoke("push_attachment", { projectKey, name, content }).catch(() => null),
  listSessionTargets: () => invoke("list_session_targets").catch(() => []),
  // Begin an OS window drag (used for click-or-drag on the title name, which is
  // no-drag so it can be clicked to rename). Needs core:window:allow-start-dragging.
  startWindowDrag: () => getCurrentWindow().startDragging().catch(() => {}),
  resolveLink: (href) => invoke("resolve_link", { href, base: currentPath }).catch(() => null),
  listDir: (dir, depth) => invoke("list_dir", { dir, depth: depth || 3 }).catch(() => []),
  searchFiles: (dir, query) => invoke("search_files", { dir, query }).catch(() => []),
  openExternal: (url) => { invoke("open_external", { url }).catch(noop); },

  // annotations + recovery
  loadAnnotations: (filePath) => invoke("load_annotations", { path: filePath }).catch(() => []),
  saveAnnotations: (filePath, annotations) =>
    invoke("save_annotations", { path: filePath, annotations }).catch(() => false),
  // snapshot works for untitled buffers too — the native side files those under
  // a per-window untitled slot, surfaced at next launch via untitledRecovery().
  snapshot: (content) => { invoke("snapshot", { content }).catch(noop); },
  discardRecovery: () => { invoke("discard_recovery").catch(noop); },
  untitledRecovery: () => invoke("untitled_recovery").catch(() => null),
  discardUntitledRecovery: (key) => { invoke("discard_untitled_recovery", { key }).catch(noop); },
  // Complete a close the native side held for an unsaved untitled buffer.
  confirmClose: () => { invoke("close_window_now").catch(noop); },

  // Claude Code sessions + context
  listSessions: (dir) => invoke("list_sessions", { dir }).catch(() => []),
  searchSessions: (query, dir) => invoke("search_sessions", { query, dir }).catch(() => []),
  listContext: (dir) => invoke("list_context", { dir }).catch(() => []),
  readSession: (filePath) => invoke("session_read", { path: filePath }).catch(() => ""),

  // images + link unfurl (ported)
  saveImage: (bytes, ext) => invoke("save_image", { bytes: Array.from(bytes), ext }).catch(() => null),
  // Local images can't load via file:// from the tauri://localhost origin — route
  // them through Tauri's asset protocol so WKWebView/WebView2/WebKitGTK can render them.
  toAssetUrl: (absPath) => convertFileSrc(absPath),
  pickImage: () => invoke("pick_image").catch(() => null),
  linkPreview: (url) => invoke("link_preview", { url }).catch(() => null),

  openInNewWindow: (filePath) => invoke("open_in_new_window", { filePath }).catch(() => null),
  exportDoc: (format, html, defaultName) =>
    (format === "pdf"
      ? invoke("export_pdf", { html, defaultName })
      : invoke("export_doc", { format, html, defaultName })
    ).catch(() => null),

  publishGoogle: async (content, defaultName) => {
    const r = await invoke("publish_google", { markdown: content, defaultName }).catch(() => null);
    if (r && r.ok && r.url) invoke("open_external", { url: r.url }).catch(noop);
    return r;
  },

  // Lazy app-local Node runtime for docx/gdocs export (#8). PDF/HTML are
  // native and never need this. Contract consumed by the renderer's
  // ensureExportRuntime() flow.
  nodeStatus: () => invoke("node_status").catch(() => ({ available: false, managed: false })),
  installNode: () =>
    invoke("install_node").catch((e) => ({ ok: false, error: String(e), code: "DOWNLOAD_FAILED" })),
  onNodeInstallProgress: (cb) => { listen("node-install-progress", (e) => cb(e.payload)); },
  // Report dirty state up to the native side so write_document refuses to clobber
  // a buffer with unsaved edits (P1-4). Keyed by the window's current file; a
  // null path flags this window's UNTITLED buffer so close can prompt (#4).
  setDirty: (dirty) => { invoke("set_doc_dirty", { path: currentPath, dirty }).catch(noop); },
};

// Pull the launch file once the renderer has registered its handler.
invoke("initial_file")
  .then((f) => {
    if (f && f.path) {
      currentPath = f.path;
      const fire = () => { if (onOpenFile) onOpenFile({ filePath: f.path, content: f.content, recovery: f.recovery }); };
      if (onOpenFile) fire(); else setTimeout(fire, 0);
    }
  })
  .catch(noop);
