"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("plume", {
  // Push events from main → renderer
  onOpenFile: (cb) =>
    ipcRenderer.on("file:opened", (_e, payload) => cb(payload)),
  onMenu: (cb) => {
    const channels = [
      "menu:open", "menu:save", "menu:saveAs", "menu:find", "menu:replace",
      "menu:format", "menu:heading", "menu:toggleOutline", "menu:toggleMode",
      "menu:theme",
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

  // Fire-and-forget renderer → main
  setDirty: (dirty) => ipcRenderer.send("doc:dirty", dirty),
  openExternal: (url) => ipcRenderer.send("file:openExternal", url),
});
