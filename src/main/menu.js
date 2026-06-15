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
        {
          label: "Export",
          submenu: [
            { label: "HTML…", click: () => send("menu:export", "html") },
            { label: "PDF…", click: () => send("menu:export", "pdf") },
            { label: "Word (.docx)…", click: () => send("menu:export", "docx") },
          ],
        },
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
        { label: "Copy as Rich Text", accelerator: "CmdOrCtrl+Shift+C", click: () => send("menu:copyRich") },
        { label: "Copy as HTML", click: () => send("menu:copyHtml") },
        { type: "separator" },
        { label: "Find…", accelerator: "CmdOrCtrl+F", click: () => send("menu:find") },
        { label: "Find & Replace…", accelerator: "CmdOrCtrl+Alt+F", click: () => send("menu:replace") },
        { type: "separator" },
        { label: "Format Document", accelerator: "Shift+Alt+F", click: () => send("menu:formatDoc") },
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
        { label: "Toggle Files Sidebar", accelerator: "CmdOrCtrl+Shift+E", click: () => send("menu:toggleSidebar") },
        { label: "Toggle Toolbar", accelerator: "CmdOrCtrl+Shift+T", click: () => send("menu:toggleToolbar") },
        { label: "Toggle Outline", accelerator: "CmdOrCtrl+Shift+O", click: () => send("menu:toggleOutline") },
        { label: "Reveal Markdown Marks While Editing", accelerator: "CmdOrCtrl+Shift+M", click: () => send("menu:toggleReveal") },
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
      label: "Go",
      submenu: [
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: () => send("menu:palette") },
        { label: "Search in Folder…", accelerator: "CmdOrCtrl+Shift+F", click: () => send("menu:searchFolder") },
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
