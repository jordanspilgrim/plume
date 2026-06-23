"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("plume", {
  // Push events from main → renderer
  onOpenFile: (cb) =>
    ipcRenderer.on("file:opened", (_e, payload) => cb(payload)),
  onExternalChange: (cb) =>
    ipcRenderer.on("file:externalChange", (_e, payload) => cb(payload)),
  onFolderOpen: (cb) =>
    ipcRenderer.on("folder:open", (_e, payload) => cb(payload)),
  onMenu: (cb) => {
    const channels = [
      "menu:open", "menu:save", "menu:saveAs", "menu:find", "menu:replace",
      "menu:format", "menu:heading", "menu:toggleOutline", "menu:toggleMode",
      "menu:theme", "menu:toggleToolbar", "menu:toggleReveal", "menu:formatDoc",
      "menu:copyRich", "menu:copyHtml", "menu:export", "menu:publishGoogle",
      "menu:toggleSidebar", "menu:palette", "menu:searchFolder", "menu:toggleFocus",
      "menu:workspace",
    ];
    channels.forEach((ch) =>
      ipcRenderer.on(ch, (_e, ...args) => cb(ch, ...args))
    );
  },

  // Request/response renderer → main
  openDialog: () => ipcRenderer.invoke("file:openDialog"),
  save: (content) => ipcRenderer.invoke("file:save", { content }),
  saveAs: (content) => ipcRenderer.invoke("file:saveAs", { content }),
  materializeDoc: (dir, name, content) => ipcRenderer.invoke("file:materialize", { dir, name, content }),
  renameFile: (newName) => ipcRenderer.invoke("file:rename", { newName }),
  pickFolder: () => ipcRenderer.invoke("file:pickFolder"),
  defaultDocsDir: () => ipcRenderer.invoke("file:defaultDocsDir"),
  pushToAgent: (projectKey, name, content) => ipcRenderer.invoke("attachment:push", { projectKey, name, content }),
  listSessionTargets: () => ipcRenderer.invoke("sessions:targets"),
  startWindowDrag: () => {}, // Electron drags via CSS app-region; no-op here
  setRecentFiles: () => {}, // Electron uses native recentDocuments (menu.js role + app.addRecentDocument)

  resolveLink: (href) => ipcRenderer.invoke("file:resolveLink", { href }),
  openInNewWindow: (filePath) =>
    ipcRenderer.invoke("file:openInNewWindow", { filePath }),
  exportDoc: (format, html, defaultName) =>
    ipcRenderer.invoke("doc:export", { format, html, defaultName }),
  publishGoogle: (content, defaultName) =>
    ipcRenderer.invoke("doc:publishGoogle", { content, defaultName }),
  saveImage: (bytes, ext) => ipcRenderer.invoke("image:save", { bytes, ext }),
  // Electron loads file:// fine from the app origin; mirror the Tauri bridge's API.
  toAssetUrl: (absPath) => "file://" + absPath.split("/").map(encodeURIComponent).join("/"),
  pickImage: () => ipcRenderer.invoke("image:pick"),
  linkPreview: (url) => ipcRenderer.invoke("link:preview", { url }),
  listDir: (dir, depth) => ipcRenderer.invoke("dir:list", { dir, depth }),
  searchFiles: (dir, query) => ipcRenderer.invoke("search:files", { dir, query }),
  listSessions: (dir) => ipcRenderer.invoke("sessions:list", { dir }),
  searchSessions: (query, dir) => ipcRenderer.invoke("sessions:search", { query, dir }),
  listContext: (dir) => ipcRenderer.invoke("context:list", { dir }),
  readSession: (filePath) => ipcRenderer.invoke("session:read", { filePath }),
  openInThisWindow: (filePath, gotoLine) =>
    ipcRenderer.invoke("file:openInThisWindow", { filePath, gotoLine }),
  loadAnnotations: (filePath) => ipcRenderer.invoke("annotations:load", { filePath }),
  saveAnnotations: (filePath, annotations) =>
    ipcRenderer.invoke("annotations:save", { filePath, annotations }),

  // Fire-and-forget renderer → main
  setDirty: (dirty) => ipcRenderer.send("doc:dirty", dirty),
  openExternal: (url) => ipcRenderer.send("file:openExternal", url),
  snapshot: (content) => ipcRenderer.send("doc:snapshot", { content }),
  discardRecovery: () => ipcRenderer.send("recovery:discard"),
});
