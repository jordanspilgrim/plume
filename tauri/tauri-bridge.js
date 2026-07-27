// Tauri implementation of the `window.plume` API.
//
// STATELESS since the Cluster A remediation (adversarial review P1-A): the
// bridge holds NO document path of its own. The renderer's tab model is the
// single source of truth for what this window is showing; every call that
// needs a path receives it explicitly, and the native binding (watcher, doc
// map, agent scope) is managed only through bindDoc()/detachDoc(). The old
// private `currentPath` here could desync from the active tab and route a
// save into the wrong file — that whole class is gone by construction.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

let onOpenFile = null;
let onExternalChange = null;
let onCloseRequested = null;
let onMenuCb = null;

// file-changed is per-window: the native side emits { path, content } only to
// the window whose document changed on disk.
listen("file-changed", (e) => { if (onExternalChange) onExternalChange(e.payload); });
// Native side ALWAYS holds a close and emits this (renderer-authoritative
// close): the renderer prompts per dirty tab, then confirmClose() or
// cancelClose(). The immediate close_prompt_ack is the liveness signal — if it
// doesn't arrive within 1.5s the native side treats the webview as dead and
// destroys the window; after the ack it waits indefinitely for the user.
listen("close-requested", () => {
  invoke("close_prompt_ack").catch(noop);
  if (onCloseRequested) onCloseRequested();
});
// Native side (CLI / double-click / File>Open) asks THIS window to open a path.
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

  // ---- document binding (Cluster A contract) ----
  // Atomically read + bind `path` as this window's document (doc map, watcher,
  // agent scope). Returns { content, recovery } or null on a failed read — the
  // renderer then DROPS the binding and the next save forces Save As.
  // Fallback: until the native bind_doc command lands, read_path provides the
  // same read+bind semantics (its binding side effect is removed in A-native).
  bindDoc: (path) =>
    invoke("bind_doc", { path })
      .catch(() => invoke("read_path", { path }))
      .then((r) => (r && typeof r.content === "string" ? { content: r.content, recovery: r.recovery ?? null } : null))
      .catch(() => null),
  // Clear this window's binding (doc map entry, watcher, per-window state).
  detachDoc: () => { invoke("detach_doc").catch(noop); },
  // Full tab path-set for this window — feeds the agent write scope and
  // listOpenFiles, so background tabs stay agent-writable/visible.
  setOpenPaths: (paths) => { invoke("set_open_paths", { paths }).catch(noop); },

  // Push the renderer's recents list so the native File > Open Recent menu reflects it.
  setRecentFiles: (paths) => invoke("set_recent_files", { paths }).catch(() => {}),

  // files — every path is explicit; native write_file additionally refuses a
  // path that isn't this window's current binding (wrong-file-write guard).
  openDialog: () => invoke("open_dialog").catch(() => null),
  save: async (path, content) => {
    try { return await invoke("write_file", { path, content }); }
    catch { return null; }
  },
  // save_dialog / rename_file write AND rebind atomically on the native side.
  saveAs: (content) => invoke("save_dialog", { content }).catch(() => null),
  renameFile: (oldPath, newName) => {
    if (!oldPath) return Promise.resolve(null);
    return invoke("rename_file", { oldPath, newName }).catch(() => null);
  },
  pickFolder: () => invoke("pick_folder").catch(() => null),
  defaultDocsDir: () => invoke("default_docs_dir").catch(() => null),
  pushToAgent: (projectKey, name, content) => invoke("push_attachment", { projectKey, name, content }).catch(() => null),
  listSessionTargets: () => invoke("list_session_targets").catch(() => []),
  // Begin an OS window drag (used for click-or-drag on the title name, which is
  // no-drag so it can be clicked to rename). Needs core:window:allow-start-dragging.
  startWindowDrag: () => getCurrentWindow().startDragging().catch(() => {}),
  resolveLink: (href, base) => invoke("resolve_link", { href, base: base ?? null }).catch(() => null),
  listDir: (dir, depth) => invoke("list_dir", { dir, depth: depth || 3 }).catch(() => []),
  searchFiles: (dir, query) => invoke("search_files", { dir, query }).catch(() => []),
  openExternal: (url) => { invoke("open_external", { url }).catch(noop); },

  // annotations + recovery
  loadAnnotations: (filePath) => invoke("load_annotations", { path: filePath }).catch(() => []),
  saveAnnotations: (filePath, annotations) =>
    invoke("save_annotations", { path: filePath, annotations }).catch(() => false),
  // snapshot routes by this window's current binding; unbound/untitled buffers
  // go to the per-window untitled slot (surfaced via untitledRecovery()).
  snapshot: (content) => { invoke("snapshot", { content }).catch(noop); },
  // Optional path (Cluster A): under tabs, the doc being discarded isn't
  // necessarily this window's binding — Don't-Save of a path-backed tab passes
  // its path so the recovery snapshot can't resurrect it. No-arg = current binding.
  discardRecovery: (path) => { invoke("discard_recovery", { path: path ?? null }).catch(noop); },
  untitledRecovery: () => invoke("untitled_recovery").catch(() => null),
  discardUntitledRecovery: (key) => { invoke("discard_untitled_recovery", { key }).catch(noop); },
  // Renderer-authoritative close: complete the held close, or abandon it
  // (clears the native pending-close marker so the dead-webview valve doesn't
  // misread a healthy Cancel).
  confirmClose: () => { invoke("close_window_now").catch(noop); },
  cancelClose: () => { invoke("cancel_close").catch(noop); },

  // Claude Code sessions + context
  listSessions: (dir) => invoke("list_sessions", { dir }).catch(() => []),
  searchSessions: (query, dir) => invoke("search_sessions", { query, dir }).catch(() => []),
  listContext: (dir) => invoke("list_context", { dir }).catch(() => []),
  readSession: (filePath) => invoke("session_read", { path: filePath }).catch(() => ""),

  // images + link unfurl
  saveImage: (bytes, ext) => invoke("save_image", { bytes: Array.from(bytes), ext }).catch(() => null),
  // Local images can't load via file:// from the tauri://localhost origin — route
  // them through Tauri's asset protocol so WKWebView/WebView2/WebKitGTK can render them.
  toAssetUrl: (absPath) => convertFileSrc(absPath),
  pickImage: () => invoke("pick_image").catch(() => null),
  linkPreview: (url) => invoke("link_preview", { url }).catch(() => null),

  openInNewWindow: (filePath) => invoke("open_in_new_window", { filePath }).catch(() => null),
  // Normalized export result (F2): { ok, path?, error?, cancelled? }.
  // pdf/html stay native; export_pdf still returns a bare path where null means
  // cancelled-or-failed (indistinguishable), so it maps to a silent cancel —
  // same visible behavior as before, no false error flashes on dialog cancel.
  exportDoc: async (format, html, defaultName) => {
    if (format === "pdf") {
      const p = await invoke("export_pdf", { html, defaultName }).catch(() => null);
      return p ? { ok: true, path: p } : { ok: false, cancelled: true };
    }
    const r = await invoke("export_doc", { format, html, defaultName })
      .catch((e) => ({ ok: false, error: String(e) }));
    return r && typeof r === "object" ? r : { ok: false, error: "no result from export" };
  },

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
  // Per-PATH dirty flag; feeds ONLY the agent write_document guard (refuse to
  // clobber unsaved edits). The renderer is the single writer, pushing per tab
  // on every transition and clearing on save / tab close / close resolution.
  setDocDirty: (path, dirty) => { if (path) invoke("set_doc_dirty", { path, dirty }).catch(noop); },
};

// Pull the launch file once the renderer has registered its handler. The
// native side binds the launch file itself (initial_file IS the bootstrap
// bindDoc); the renderer records the path in its tab model.
invoke("initial_file")
  .then((f) => {
    if (f && f.path) {
      const fire = () => { if (onOpenFile) onOpenFile({ filePath: f.path, content: f.content, recovery: f.recovery }); };
      if (onOpenFile) fire(); else setTimeout(fire, 0);
    }
  })
  .catch(noop);
