"use strict";

const { app, Menu, BrowserWindow, shell } = require("electron");

function send(channel, ...args) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.send(channel, ...args);
}

function buildMenu({ createWindow }) {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => send("menu:open") },
        {
          role: "recentDocuments",
          submenu: [{ label: "Clear Menu", role: "clearRecentDocuments" }],
        },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("menu:save") },
        { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => send("menu:saveAs") },
        { type: "separator" },
        { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Find…", accelerator: "CmdOrCtrl+F", click: () => send("menu:find") },
        { label: "Find & Replace…", accelerator: "CmdOrCtrl+Alt+F", click: () => send("menu:replace") },
      ],
    },
    {
      label: "Format",
      submenu: [
        { label: "Bold", accelerator: "CmdOrCtrl+B", click: () => send("menu:format", "bold") },
        { label: "Italic", accelerator: "CmdOrCtrl+I", click: () => send("menu:format", "italic") },
        { label: "Inline Code", accelerator: "CmdOrCtrl+E", click: () => send("menu:format", "code") },
        { label: "Strikethrough", accelerator: "CmdOrCtrl+Shift+X", click: () => send("menu:format", "strike") },
        { label: "Link", accelerator: "CmdOrCtrl+K", click: () => send("menu:format", "link") },
        { type: "separator" },
        { label: "Heading 1", accelerator: "CmdOrCtrl+1", click: () => send("menu:heading", 1) },
        { label: "Heading 2", accelerator: "CmdOrCtrl+2", click: () => send("menu:heading", 2) },
        { label: "Heading 3", accelerator: "CmdOrCtrl+3", click: () => send("menu:heading", 3) },
        { label: "Body Text", accelerator: "CmdOrCtrl+0", click: () => send("menu:heading", 0) },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Outline", accelerator: "CmdOrCtrl+Shift+O", click: () => send("menu:toggleOutline") },
        { label: "Toggle Source / Preview", accelerator: "CmdOrCtrl+/", click: () => send("menu:toggleMode") },
        { type: "separator" },
        { label: "Appearance: System", click: () => send("menu:theme", "system") },
        { label: "Appearance: Light", click: () => send("menu:theme", "light") },
        { label: "Appearance: Dark", click: () => send("menu:theme", "dark") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      role: "window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Markdown Guide",
          click: () => shell.openExternal("https://www.markdownguide.org/basic-syntax/"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
