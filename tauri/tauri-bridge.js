// Tauri implementation of the `window.plume` API. Lets the existing renderer
// (built for Electron's contextBridge) run unchanged in WKWebView. Core file
// surface is wired to Rust commands; the rest are safe stubs pending the full
// port (see src-tauri/MIGRATION.md).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let onOpenFile = null;
let onExternalChange = null;
let onFolderOpen = null;
let currentPath = null;

listen("file-opened", (e) => {
  currentPath = e.payload.filePath;
  if (onOpenFile) onOpenFile(e.payload);
});
listen("file-changed", (e) => { if (onExternalChange) onExternalChange(e.payload); });
listen("folder-opened", (e) => { if (onFolderOpen) onFolderOpen(e.payload); });

const noop = () => {};
const asyncNull = async () => null;
const asyncArr = async () => [];

window.plume = {
  // events
  onOpenFile: (cb) => { onOpenFile = cb; },
  onExternalChange: (cb) => { onExternalChange = cb; },
  onFolderOpen: (cb) => { onFolderOpen = cb; },
  onMenu: noop, // TODO: Tauri menu → emit menu events

  // core file surface (ported)
  openInThisWindow: async (filePath, gotoLine) => {
    try {
      const content = await invoke("read_path", { path: filePath });
      currentPath = filePath;
      if (onOpenFile) onOpenFile({ filePath, content, gotoLine });
    } catch (e) { /* ignore */ }
  },
  save: async (content) => {
    try { return await invoke("write_file", { path: currentPath, content }); }
    catch { return null; }
  },
  listDir: async (dir, depth) => {
    try { return await invoke("list_dir", { dir, depth: depth || 3 }); }
    catch { return []; }
  },
  openExternal: (url) => { invoke("open_external", { url }).catch(noop); },

  // pending full port (stubbed so the renderer loads cleanly)
  openDialog: asyncNull,        // TODO: tauri-plugin-dialog
  saveAs: asyncNull,            // TODO: save dialog
  resolveLink: asyncNull,       // TODO: relative-link resolution
  openInNewWindow: asyncNull,   // TODO: multi-window
  exportDoc: asyncNull,         // TODO: PDF (no printToPDF — needs wkpdf/headless) + DOCX
  publishGoogle: asyncNull,     // TODO: reuse gdocs.js via a sidecar or rust http
  saveImage: asyncNull,
  pickImage: asyncNull,
  linkPreview: asyncNull,       // TODO: rust reqwest unfurl
  searchFiles: asyncArr,
  listSessions: asyncArr,
  searchSessions: asyncArr,
  listContext: asyncArr,
  loadAnnotations: asyncArr,
  saveAnnotations: async () => true,
  setDirty: noop,
  snapshot: noop,
  discardRecovery: noop,
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
