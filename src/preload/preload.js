"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("plume", {
  // Push events from main → renderer
  onOpenFile: (cb) =>
    ipcRenderer.on("file:opened", (_e, payload) => cb(payload)),
  onExternalChange: (cb) =>
    ipcRenderer.on("file:externalChange", (_e, payload) => cb(payload)),
  onMenu: (cb) => {
    const channels = [
      "menu:open", "menu:save", "menu:saveAs", "menu:find", "menu:replace",
      "menu:format", "menu:heading", "menu:toggleOutline", "menu:toggleMode",
      "menu:theme", "menu:toggleToolbar", "menu:toggleReveal", "menu:formatDoc",
      "menu:copyRich", "menu:copyHtml", "menu:export",
    ];
    channels.forEach((ch) =>
      ipcRenderer.on(ch, (_e, ...args) => cb(ch, ...args))
    );
  },

  // Request/response renderer → main
  openDialog: () => ipcRenderer.invoke("file:openDialog"),
  save: (content) => ipcRenderer.invoke("file:save", { content }),
  saveAs: (content) => ipcRenderer.invoke("file:saveAs", { content }),
  resolveLink: (href) => ipcRenderer.invoke("file:resolveLink", { href }),
  openInNewWindow: (filePath) =>
    ipcRenderer.invoke("file:openInNewWindow", { filePath }),
  exportDoc: (format, html, defaultName) =>
    ipcRenderer.invoke("doc:export", { format, html, defaultName }),

  // Fire-and-forget renderer → main
  setDirty: (dirty) => ipcRenderer.send("doc:dirty", dirty),
  openExternal: (url) => ipcRenderer.send("file:openExternal", url),
  snapshot: (content) => ipcRenderer.send("doc:snapshot", { content }),
  discardRecovery: () => ipcRenderer.send("recovery:discard"),
});
