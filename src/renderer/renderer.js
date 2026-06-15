import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, drawSelection, dropCursor, highlightActiveLine,
  rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  search, searchKeymap, openSearchPanel,
} from "@codemirror/search";
import { syntaxTree } from "@codemirror/language";
import { livePreview } from "./editor/livePreview.js";

/* ---------- State ---------- */
let savedText = "";
let currentPath = null;
const appEl = document.getElementById("app");
const titlebar = document.getElementById("titlebar");
const titlebarName = document.getElementById("titlebar-name");
const outlineEl = document.getElementById("outline");

/* ---------- Editor ---------- */
const updateListener = EditorView.updateListener.of((u) => {
  if (u.docChanged) {
    scheduleSideEffects();
  }
});

const view = new EditorView({
  parent: document.getElementById("editor-host"),
  state: EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage, extensions: [GFM], addKeymap: true }),
      livePreview,
      search({ top: true }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      updateListener,
    ],
  }),
});
view.focus();

/* ---------- Debounced side effects (dirty + outline) ---------- */
let sideTimer = null;
function scheduleSideEffects() {
  if (sideTimer) clearTimeout(sideTimer);
  sideTimer = setTimeout(() => {
    const text = view.state.doc.toString();
    setDirty(text !== savedText);
    renderOutline();
  }, 120);
}

function setDirty(dirty) {
  titlebar.classList.toggle("dirty", dirty);
  window.plume.setDirty(dirty);
}

/* ---------- Title ---------- */
function setTitle(pathOrNull) {
  currentPath = pathOrNull;
  const name = pathOrNull ? pathOrNull.split("/").pop() : "Untitled";
  titlebarName.textContent = name;
  document.title = name;
}

/* ---------- File I/O ---------- */
function loadDocument(content, filePath) {
  savedText = content;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: { anchor: 0 },
  });
  setTitle(filePath);
  setDirty(false);
  renderOutline();
  view.focus();
}

async function save(thenClose = false) {
  const content = view.state.doc.toString();
  const result = await window.plume.save(content);
  if (result) {
    savedText = content;
    setTitle(result);
    setDirty(false);
    if (thenClose) window.close();
  }
}

async function saveAs() {
  const content = view.state.doc.toString();
  const result = await window.plume.saveAs(content);
  if (result) {
    savedText = content;
    setTitle(result);
    setDirty(false);
  }
}

/* ---------- Outline ---------- */
function renderOutline() {
  if (outlineEl.classList.contains("hidden")) return;
  const tree = syntaxTree(view.state);
  const items = [];
  tree.iterate({
    enter: (node) => {
      const m = /^ATXHeading([1-6])$/.exec(node.name) || /^SetextHeading([1-2])$/.exec(node.name);
      if (m) {
        const line = view.state.doc.lineAt(node.from);
        const text = line.text.replace(/^#{1,6}\s*/, "").replace(/\s*#*\s*$/, "").trim();
        if (text) items.push({ level: Number(m[1]), text, pos: node.from });
      }
    },
  });
  outlineEl.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "outline-empty";
    empty.textContent = "No headings";
    outlineEl.appendChild(empty);
    return;
  }
  for (const it of items) {
    const el = document.createElement("div");
    el.className = `outline-item h${it.level}`;
    el.textContent = it.text;
    el.title = it.text;
    el.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: it.pos },
        effects: EditorView.scrollIntoView(it.pos, { y: "start", yMargin: 40 }),
      });
      view.focus();
    });
    outlineEl.appendChild(el);
  }
}

function toggleOutline() {
  outlineEl.classList.toggle("hidden");
  renderOutline();
}

/* ---------- Theme ---------- */
function applyTheme(theme) {
  appEl.dataset.theme = theme;
  localStorage.setItem("plume-theme", theme);
}
applyTheme(localStorage.getItem("plume-theme") || "system");

/* ---------- Formatting commands ---------- */
function wrapSelection(before, after = before) {
  const changes = [];
  const sel = view.state.selection;
  const newRanges = [];
  for (const r of sel.ranges) {
    const text = view.state.doc.sliceString(r.from, r.to);
    const outer = view.state.doc.sliceString(
      Math.max(0, r.from - before.length),
      Math.min(view.state.doc.length, r.to + after.length)
    );
    const already =
      outer.startsWith(before) && outer.endsWith(after) && r.from >= before.length;
    if (already) {
      changes.push(
        { from: r.from - before.length, to: r.from, insert: "" },
        { from: r.to, to: r.to + after.length, insert: "" }
      );
      newRanges.push({ from: r.from - before.length, to: r.to - before.length });
    } else {
      changes.push(
        { from: r.from, insert: before },
        { from: r.to, insert: after }
      );
      newRanges.push({
        from: r.from + before.length,
        to: r.to + before.length + (r.empty ? 0 : 0),
      });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

function applyFormat(kind) {
  switch (kind) {
    case "bold": return wrapSelection("**");
    case "italic": return wrapSelection("*");
    case "code": return wrapSelection("`");
    case "strike": return wrapSelection("~~");
    case "link": return insertLink();
  }
}

function insertLink() {
  const r = view.state.selection.main;
  const text = view.state.doc.sliceString(r.from, r.to) || "text";
  const snippet = `[${text}](url)`;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: snippet },
    selection: { anchor: r.from + snippet.length - 4, head: r.from + snippet.length - 1 },
  });
  view.focus();
}

function setHeading(level) {
  const changes = [];
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    const stripped = line.text.replace(/^#{1,6}\s+/, "");
    const prefix = level === 0 ? "" : "#".repeat(level) + " ";
    changes.push({ from: line.from, to: line.to, insert: prefix + stripped });
  }
  view.dispatch({ changes });
  view.focus();
}

/* ---------- Menu + IPC wiring ---------- */
window.plume.onOpenFile(({ filePath, content }) => loadDocument(content, filePath));

window.plume.onMenu((channel, ...args) => {
  switch (channel) {
    case "menu:open": window.plume.openDialog(); break;
    case "menu:save": save(Boolean(args[0]?.thenClose)); break;
    case "menu:saveAs": saveAs(); break;
    case "menu:find": openSearchPanel(view); break;
    case "menu:replace": openSearchPanel(view); break;
    case "menu:format": applyFormat(args[0]); break;
    case "menu:heading": setHeading(args[0]); break;
    case "menu:toggleOutline": toggleOutline(); break;
    case "menu:toggleMode": appEl.classList.toggle("source-mode"); break;
    case "menu:theme": applyTheme(args[0]); break;
  }
});

setTitle(null);
