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
import { syntaxTree, syntaxHighlighting } from "@codemirror/language";
import { codeLanguages, codeHighlightStyle } from "./editor/highlight.js";
import { livePreview, setDocPath, setMermaidTheme, setRevealMarks, setFocusMode, refreshEffect, renderMermaidInto, Highlight } from "./editor/livePreview.js";
import { modeForPath, languageForExt, codeFeatures, extOf, baseName } from "./editor/modes.js";
import { diffDecorations, logDecorations } from "./editor/decorators.js";
import { renderJsonl, renderCsv } from "./editor/viewers.js";
import { mdToHtml, fullHtmlDocument } from "./editor/export.js";
import "katex/dist/katex.min.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

/* ---------- State ---------- */
let savedText = "";
let currentPath = null;
const appEl = document.getElementById("app");
const titlebar = document.getElementById("titlebar");
const titlebarName = document.getElementById("titlebar-name");
const outlineEl = document.getElementById("outline");
const statusEl = document.getElementById("statusbar");

function updateStatus() {
  const sel = view.state.selection.main;
  const scope = sel.empty ? view.state.doc.toString() : view.state.doc.sliceString(sel.from, sel.to);
  const parts = [];
  if (currentMode === "markdown") {
    const words = (scope.match(/\S+/g) || []).length;
    if (!sel.empty) parts.push("selection");
    parts.push(`${words.toLocaleString()} word${words === 1 ? "" : "s"}`);
    parts.push(`~${Math.max(1, Math.round(words / 200))} min read`);
  } else {
    parts.push(`${view.state.doc.lines.toLocaleString()} lines`);
    parts.push(`${view.state.doc.length.toLocaleString()} chars`);
  }
  statusEl.textContent = parts.join("  ·  ");
}

/* ---------- Editor ---------- */
// Compartments let us swap language + features per file type without rebuilding the editor.
const langConf = new Compartment();
const previewConf = new Compartment();
const codeConf = new Compartment();

function markdownLang() {
  return markdown({ base: markdownLanguage, extensions: [GFM, Highlight], codeLanguages, addKeymap: true });
}

const updateListener = EditorView.updateListener.of((u) => {
  if (u.docChanged) { scheduleSideEffects(); updateWelcome(); }
  if (u.selectionSet) updateStatus();
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
      // Override CodeMirror's default monospace content font with the themeable body font.
      EditorView.theme({
        "&": { fontFamily: "var(--font-body)" },
        ".cm-content": { fontFamily: "var(--font-body)" },
        ".cm-scroller": { fontFamily: "var(--font-body)" },
      }),
      langConf.of(markdownLang()),
      previewConf.of(livePreview),
      codeConf.of([]),
      syntaxHighlighting(codeHighlightStyle),
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
let snapshotTimer = null;
let autosaveTimer = null;
function scheduleSideEffects() {
  if (sideTimer) clearTimeout(sideTimer);
  sideTimer = setTimeout(() => {
    const text = view.state.doc.toString();
    setDirty(text !== savedText);
    renderOutline();
    updateStatus();
  }, 120);

  // Crash-recovery snapshot (path-backed docs only; main ignores untitled).
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => window.plume.snapshot(view.state.doc.toString()), 700);

  // Autosave the open file after a short idle.
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 1300);
}

async function autosave() {
  if (!currentPath) return; // never auto-create files for untitled docs
  const text = view.state.doc.toString();
  if (text === savedText) return;
  const result = await window.plume.save(text);
  if (result) { savedText = text; setTitle(result); setDirty(false); }
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

/* ---------- 8-bit welcome / empty state ---------- */
const WELCOME_ART = [
  "██████╗ ██╗     ██╗   ██╗███╗   ███╗███████╗",
  "██╔══██╗██║     ██║   ██║████╗ ████║██╔════╝",
  "██████╔╝██║     ██║   ██║██╔████╔██║█████╗  ",
  "██╔═══╝ ██║     ██║   ██║██║╚██╔╝██║██╔══╝  ",
  "██║     ███████╗╚██████╔╝██║ ╚═╝ ██║███████╗",
  "╚═╝     ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝",
].join("\n");
const welcomeEl = document.getElementById("welcome");
function buildWelcome() {
  if (welcomeEl.dataset.built) return;
  welcomeEl.dataset.built = "1";
  const art = document.createElement("pre");
  art.className = "welcome-art";
  art.textContent = WELCOME_ART;
  const tag = document.createElement("div");
  tag.className = "welcome-tag";
  tag.textContent = "single-surface markdown — the human pane for agentic coding";
  const hints = document.createElement("div");
  hints.className = "welcome-hints";
  for (const [k, label] of [["⌘O", "OPEN FILE"], ["⌘N", "NEW DOC"], ["⌘P", "COMMAND PALETTE"]]) {
    const chip = document.createElement("span");
    const key = document.createElement("b");
    key.textContent = k;
    chip.append(key, document.createTextNode(" " + label));
    hints.appendChild(chip);
  }
  const blink = document.createElement("div");
  blink.className = "welcome-blink";
  blink.textContent = "▮ TYPE TO START";
  welcomeEl.append(art, tag, hints, blink);
}
function updateWelcome() {
  const empty = view.state.doc.length === 0 && !currentPath && currentMode === "markdown";
  welcomeEl.classList.toggle("hidden", !empty);
}

/* ---------- Mode dispatch ---------- */
const RENDER_MODES = new Set(["jsonl", "csv", "mermaid"]);
const editorHost = document.getElementById("editor-host");
const renderHost = document.getElementById("render-host");
const viewToggle = document.getElementById("view-toggle");
let currentMode = "markdown";
let showSource = false;

function isRenderMode() { return RENDER_MODES.has(currentMode); }

function updateHosts() {
  const render = isRenderMode();
  viewToggle.classList.toggle("hidden", !render);
  viewToggle.textContent = showSource ? "Rendered" : "Source";
  const showRendered = render && !showSource;
  editorHost.classList.toggle("hidden", showRendered);
  renderHost.classList.toggle("hidden", !showRendered);
}

function renderCurrent() {
  if (!isRenderMode()) return;
  const text = view.state.doc.toString();
  renderHost.innerHTML = "";
  const body = document.createElement("div");
  body.className = "render-body mode-" + currentMode;
  renderHost.appendChild(body);
  if (currentMode === "jsonl") renderJsonl(body, text);
  else if (currentMode === "csv") renderCsv(body, text, extOf(currentPath) === "tsv");
  else if (currentMode === "mermaid") {
    const d = document.createElement("div");
    d.className = "render-mermaid";
    body.appendChild(d);
    renderMermaidInto(d, text);
  }
}

function toggleSourceView() {
  if (!isRenderMode()) return;
  showSource = !showSource;
  updateHosts();
  if (showSource) view.focus();
  else renderCurrent();
}

function applyMode(filePath) {
  const mode = modeForPath(filePath);
  currentMode = mode;
  showSource = false;
  appEl.dataset.mode = mode;
  if (mode === "markdown") {
    view.dispatch({ effects: [
      langConf.reconfigure(markdownLang()),
      previewConf.reconfigure(livePreview),
      codeConf.reconfigure([]),
    ]});
  } else if (mode === "diff") {
    view.dispatch({ effects: [
      langConf.reconfigure([]),
      previewConf.reconfigure(diffDecorations),
      codeConf.reconfigure([]),
    ]});
  } else if (mode === "log") {
    view.dispatch({ effects: [
      langConf.reconfigure([]),
      previewConf.reconfigure(logDecorations),
      codeConf.reconfigure([]),
    ]});
  } else {
    // Code/config (and, for now, jsonl/csv/mermaid until their richer modes
    // land) open as plain, foldable, syntax-highlighted text.
    const lang = languageForExt(extOf(filePath), baseName(filePath));
    view.dispatch({ effects: [
      langConf.reconfigure(lang || []),
      previewConf.reconfigure([]),
      codeConf.reconfigure(codeFeatures),
    ]});
  }
  // Markdown-only chrome.
  document.getElementById("toolbar").classList.toggle("mode-hidden", mode !== "markdown");
  if (mode !== "markdown") outlineEl.classList.add("hidden");
  updateHosts();
}

function formatDocument() {
  const ext = extOf(currentPath || "");
  if (ext === "json" || ext === "jsonc" || ext === "json5") {
    try {
      const pretty = JSON.stringify(JSON.parse(view.state.doc.toString()), null, 2);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: pretty } });
      view.focus();
    } catch (e) {
      flashMessage("Can't format: " + e.message);
    }
  } else {
    flashMessage("Format is available for JSON files.");
  }
}

function flashMessage(text) {
  bannerEl.className = "";
  bannerEl.innerHTML = "";
  const msg = document.createElement("span");
  msg.textContent = text;
  const ok = document.createElement("button");
  ok.textContent = "OK";
  ok.className = "ghost";
  ok.onclick = () => { clearBanner(); view.focus(); };
  bannerEl.append(msg, ok);
}

/* ---------- Share-out: copy as / export ---------- */
function docBaseName() {
  return currentPath ? currentPath.split("/").pop().replace(/\.[^.]+$/, "") : "Untitled";
}
function selectionOrDoc() {
  const r = view.state.selection.main;
  return r.empty ? view.state.doc.toString() : view.state.doc.sliceString(r.from, r.to);
}
async function copyAsRichText() {
  const src = selectionOrDoc();
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([mdToHtml(src)], { type: "text/html" }),
        "text/plain": new Blob([src], { type: "text/plain" }),
      }),
    ]);
    flashMessage("Copied as rich text — paste into Mail, Slack, Docs…");
  } catch (e) { flashMessage("Copy failed: " + e.message); }
}
async function copyAsHtml() {
  try {
    await navigator.clipboard.writeText(mdToHtml(selectionOrDoc()));
    flashMessage("Copied HTML source");
  } catch (e) { flashMessage("Copy failed: " + e.message); }
}
async function exportAs(format) {
  const html = fullHtmlDocument(mdToHtml(view.state.doc.toString()), docBaseName());
  const result = await window.plume.exportDoc(format, html, docBaseName());
  if (result) flashMessage("Exported " + result.split("/").pop());
}

/* ---------- File I/O ---------- */
function loadDocument(content, filePath, recovery, gotoLine) {
  applyMode(filePath);
  savedText = content;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: { anchor: 0 },
  });
  setDocPath(view, filePath);
  setTitle(filePath);
  setDirty(false);
  renderOutline();
  updateStatus();
  if (isRenderMode()) renderCurrent();
  updateWelcome();
  if (recovery != null) showRecoveryBanner(recovery);
  else clearBanner();
  if (gotoLine) {
    const ln = view.state.doc.line(Math.max(1, Math.min(gotoLine, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: "center" }) });
  }
  refreshSidebar();
  view.focus();
}

/* ---------- Recovery banner ---------- */
const bannerEl = document.getElementById("banner");
function clearBanner() { bannerEl.className = "hidden"; bannerEl.innerHTML = ""; }
function showRecoveryBanner(recoveryContent) {
  bannerEl.className = "";
  bannerEl.innerHTML = "";
  const msg = document.createElement("span");
  msg.textContent = "Plume recovered unsaved changes from a previous session.";
  const restore = document.createElement("button");
  restore.textContent = "Restore";
  restore.onclick = () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: recoveryContent } });
    setDirty(true);
    clearBanner();
    view.focus();
  };
  const discard = document.createElement("button");
  discard.textContent = "Discard";
  discard.className = "ghost";
  discard.onclick = () => { window.plume.discardRecovery(); clearBanner(); view.focus(); };
  bannerEl.append(msg, restore, discard);
}

/* ---------- Live auto-reload (file changed on disk) ---------- */
function setDoc(content, { bottom = false } = {}) {
  const scrollTop = view.scrollDOM.scrollTop;
  const anchor = Math.min(view.state.selection.main.anchor, content.length);
  savedText = content;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor } });
  // Log files tail-follow to the newest line; everything else holds position.
  view.scrollDOM.scrollTop = bottom ? view.scrollDOM.scrollHeight : scrollTop;
  setDirty(false);
  renderOutline();
}

function applyExternalChange(content) {
  if (content === view.state.doc.toString()) { savedText = content; setDirty(false); return; }
  // Don't clobber unsaved edits — let the user choose.
  if (titlebar.classList.contains("dirty")) { showDiskChangedBanner(content); return; }
  setDoc(content, { bottom: currentMode === "log" });
  if (isRenderMode() && !showSource) renderCurrent();
  clearBanner();
}

function showDiskChangedBanner(content) {
  bannerEl.className = "";
  bannerEl.innerHTML = "";
  const msg = document.createElement("span");
  msg.textContent = "This file changed on disk.";
  const reload = document.createElement("button");
  reload.textContent = "Reload";
  reload.onclick = () => { setDoc(content); clearBanner(); view.focus(); };
  const keep = document.createElement("button");
  keep.textContent = "Keep mine";
  keep.className = "ghost";
  keep.onclick = () => { clearBanner(); view.focus(); };
  bannerEl.append(msg, reload, keep);
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
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  setMermaidTheme(dark ? "dark" : "default");
  view.dispatch({ effects: refreshEffect.of(null) });
}
applyTheme(localStorage.getItem("plume-theme") || "system");

/* ---------- Formatting commands ---------- */
function wrapSelection(before, after = before) {
  const changes = [];
  for (const r of view.state.selection.ranges) {
    let from = r.from;
    let to = r.to;
    const text = view.state.doc.sliceString(from, to);
    // Trim surrounding whitespace so the marks hug the content, not a trailing newline.
    if (text.length) {
      from += text.length - text.trimStart().length;
      to -= text.length - text.trimEnd().length;
      if (to < from) { from = r.from; to = r.from; }
    }
    const outer = view.state.doc.sliceString(
      Math.max(0, from - before.length),
      Math.min(view.state.doc.length, to + after.length)
    );
    const already =
      text.trim().length > 0 &&
      outer.startsWith(before) && outer.endsWith(after) && from >= before.length;
    if (already) {
      changes.push(
        { from: from - before.length, to: from, insert: "" },
        { from: to, to: to + after.length, insert: "" }
      );
    } else {
      changes.push({ from, insert: before }, { from: to, insert: after });
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

/* ---------- Line-oriented commands ---------- */
function toggleLinePrefix(test, makePrefix) {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);
  const lines = [];
  for (let n = startLine.number; n <= endLine.number; n++) lines.push(view.state.doc.line(n));
  const allHave = lines.every((l) => test.test(l.text));
  const changes = [];
  lines.forEach((l, i) => {
    if (allHave) {
      const m = l.text.match(test);
      changes.push({ from: l.from, to: l.from + m[0].length, insert: "" });
    } else {
      changes.push({ from: l.from, insert: makePrefix(i) });
    }
  });
  view.dispatch({ changes });
  view.focus();
}

function freshLinePrefix(from) {
  if (from === 0) return "";
  const line = view.state.doc.lineAt(from);
  return view.state.doc.sliceString(line.from, from).trim() === "" ? "" : "\n\n";
}

function insertCodeBlock() {
  const sel = view.state.selection.main;
  const selected = view.state.doc.sliceString(sel.from, sel.to);
  const pre = freshLinePrefix(sel.from);
  const block = pre + "```\n" + selected + "\n```\n";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: block },
    selection: { anchor: sel.from + pre.length + 3 },
  });
  view.focus();
}

function insertTable() {
  const sel = view.state.selection.main;
  const pre = freshLinePrefix(sel.from);
  const snippet = pre + "| Column | Column |\n| --- | --- |\n| Cell | Cell |\n";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: snippet },
    selection: { anchor: sel.from + pre.length + 2 },
  });
  view.focus();
}

function insertHR() {
  const sel = view.state.selection.main;
  const pre = freshLinePrefix(sel.from);
  const snippet = pre + "---\n";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: snippet },
    selection: { anchor: sel.from + snippet.length },
  });
  view.focus();
}

// Edit (or add) an image's alt text. If the cursor's line already has an image,
// select its alt so you can type; otherwise insert a new image template.
function editImageAlt() {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /!\[([^\]]*)\]\([^)]*\)/.exec(line.text);
  if (m) {
    const altFrom = line.from + m.index + 2;
    const altTo = altFrom + m[1].length;
    view.dispatch({ selection: { anchor: altFrom, head: altTo } });
    view.focus();
    flashMessage(m[1] ? "Editing alt text — type to replace it" : "Type the image's alt text (for accessibility)");
    return;
  }
  insertImageViaPicker();
}

async function insertImageViaPicker() {
  if (!currentPath) { flashMessage("Save the file first to add images."); return; }
  const res = await window.plume.pickImage();
  if (res?.error === "unsaved") { flashMessage("Save the file first to add images."); return; }
  if (res?.rel) {
    const r = view.state.selection.main;
    const snippet = `![](${res.rel})`;
    view.dispatch({ changes: { from: r.from, to: r.to, insert: snippet }, selection: { anchor: r.from + 2 } });
    view.focus();
    flashMessage("Inserted " + res.rel);
  }
}

// Copy the document (or selection) as rich text, ready to paste into a Google Doc.
async function copyForGoogleDocs() {
  const src = selectionOrDoc();
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([mdToHtml(src)], { type: "text/html" }),
        "text/plain": new Blob([src], { type: "text/plain" }),
      }),
    ]);
    flashMessage("Copied — open a Google Doc and paste (⌘V)");
  } catch (e) { flashMessage("Copy failed: " + e.message); }
}

/* ---------- Toolbar ---------- */
const ICONS = {
  code: '<svg viewBox="0 0 16 16"><path d="M5.5 4 2.5 8l3 4M10.5 4l3 4-3 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  link: '<svg viewBox="0 0 16 16"><path d="M6.3 9.7 9.7 6.3M7 4.6l1-1a2.7 2.7 0 0 1 3.8 3.8l-1 1M9 11.4l-1 1a2.7 2.7 0 0 1-3.8-3.8l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  bullet: '<svg viewBox="0 0 16 16"><circle cx="3" cy="4.5" r="1.1" fill="currentColor"/><circle cx="3" cy="8" r="1.1" fill="currentColor"/><circle cx="3" cy="11.5" r="1.1" fill="currentColor"/><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  ordered: '<svg viewBox="0 0 16 16"><text x="1.2" y="5.6" font-size="5" fill="currentColor" font-family="sans-serif">1</text><text x="1.2" y="10" font-size="5" fill="currentColor" font-family="sans-serif">2</text><text x="1.2" y="14.2" font-size="5" fill="currentColor" font-family="sans-serif">3</text><path d="M6.5 4.5h7M6.5 8.4h7M6.5 12.3h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  task: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  quote: '<svg viewBox="0 0 16 16"><path d="M3 5.5h3.2v3.2c0 1.6-1 2.7-2.7 3.1M9 5.5h3.2v3.2c0 1.6-1 2.7-2.7 3.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  codeblock: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 6.4 4.4 8 6 9.6M10 6.4 11.6 8 10 9.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  table: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2 6.5h12M2 9.8h12M6.5 3.2v9.6M10 3.2v9.6" stroke="currentColor" stroke-width="1"/></svg>',
  hr: '<svg viewBox="0 0 16 16"><path d="M2.5 8h11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  image: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="5.6" cy="6.4" r="1.1" fill="currentColor"/><path d="M3 12l3.3-3 2.2 2 2.1-2.4L14 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  gdocs: '<svg viewBox="0 0 16 16"><path d="M4 1.6h4.6L12 5v8.9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2.1a.5.5 0 0 1 .5-.5z" fill="none" stroke="#4285F4" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.4 1.7v3.1h3.1" fill="none" stroke="#4285F4" stroke-width="1.2"/><path d="M5.6 7.7h4.8M5.6 9.6h4.8M5.6 11.5h3.4" stroke="#4285F4" stroke-width="1" stroke-linecap="round"/></svg>',
};

const TOOLBAR_GROUPS = [
  [
    { t: "Heading 1  ⌘1", text: "H1", fn: () => setHeading(1) },
    { t: "Heading 2  ⌘2", text: "H2", fn: () => setHeading(2) },
    { t: "Heading 3  ⌘3", text: "H3", fn: () => setHeading(3) },
  ],
  [
    { t: "Bold  ⌘B", text: "<b>B</b>", fn: () => applyFormat("bold") },
    { t: "Italic  ⌘I", text: "<i>I</i>", fn: () => applyFormat("italic") },
    { t: "Strikethrough  ⌘⇧X", text: "<s>S</s>", fn: () => applyFormat("strike") },
    { t: "Inline code  ⌘E", svg: "code", fn: () => applyFormat("code") },
    { t: "Link  ⌘K", svg: "link", fn: () => applyFormat("link") },
  ],
  [
    { t: "Bullet list", svg: "bullet", fn: () => toggleLinePrefix(/^\s*[-*+] /, () => "- ") },
    { t: "Numbered list", svg: "ordered", fn: () => toggleLinePrefix(/^\s*\d+\. /, (i) => `${i + 1}. `) },
    { t: "Task list", svg: "task", fn: () => toggleLinePrefix(/^\s*[-*+] \[[ xX]\] /, () => "- [ ] ") },
    { t: "Quote", svg: "quote", fn: () => toggleLinePrefix(/^> ?/, () => "> ") },
  ],
  [
    { t: "Code block", svg: "codeblock", fn: insertCodeBlock },
    { t: "Table", svg: "table", fn: insertTable },
    { t: "Divider", svg: "hr", fn: insertHR },
  ],
  [
    { t: "Image alt text", svg: "image", fn: editImageAlt },
    { t: "Copy for Google Docs", svg: "gdocs", fn: copyForGoogleDocs },
  ],
];

/* ---------- Fonts ---------- */
const FONTS = [
  { id: "inter", label: "Inter", stack: '"Inter Variable", "Inter", -apple-system, sans-serif' },
  { id: "system", label: "System (SF Pro)", stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif' },
  { id: "newyork", label: "New York", stack: 'ui-serif, "New York", Charter, Georgia, serif' },
  { id: "charter", label: "Charter", stack: 'Charter, "Bitstream Charter", Georgia, serif' },
  { id: "iowan", label: "Iowan", stack: '"Iowan Old Style", Palatino, "Palatino Linotype", serif' },
  { id: "mono", label: "JetBrains Mono", stack: '"JetBrains Mono", "SF Mono", ui-monospace, monospace' },
];

function applyFont(id) {
  const font = FONTS.find((f) => f.id === id) || FONTS[0];
  document.documentElement.style.setProperty("--font-body", font.stack);
  localStorage.setItem("plume-font", font.id);
}

function buildFontPicker() {
  const wrap = document.createElement("label");
  wrap.className = "tb-font";
  wrap.title = "Editor font";
  const select = document.createElement("select");
  for (const f of FONTS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    select.appendChild(opt);
  }
  select.value = localStorage.getItem("plume-font") || "inter";
  select.addEventListener("change", () => { applyFont(select.value); view.focus(); });
  wrap.appendChild(select);
  return wrap;
}

/* ---------- Toolbar ---------- */
function buildToolbar() {
  const tb = document.getElementById("toolbar");
  tb.innerHTML = "";
  TOOLBAR_GROUPS.forEach((group, gi) => {
    if (gi > 0) {
      const div = document.createElement("span");
      div.className = "tb-divider";
      tb.appendChild(div);
    }
    for (const b of group) {
      const btn = document.createElement("button");
      btn.className = "tb-btn";
      btn.title = b.t;
      btn.setAttribute("aria-label", b.t);
      btn.innerHTML = b.svg ? ICONS[b.svg] : `<span class="tb-text">${b.text}</span>`;
      btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor selection
      btn.addEventListener("click", b.fn);
      tb.appendChild(btn);
    }
  });
  const spacer = document.createElement("span");
  spacer.className = "tb-spacer";
  tb.appendChild(spacer);
  tb.appendChild(buildFontPicker());
}

function applyToolbar(visible) {
  document.getElementById("toolbar").classList.toggle("hidden", !visible);
  localStorage.setItem("plume-toolbar", visible ? "1" : "0");
}

/* ---------- Markdown mark visibility ---------- */
function applyReveal(reveal) {
  setRevealMarks(reveal);
  localStorage.setItem("plume-reveal", reveal ? "1" : "0");
  view.dispatch({ effects: refreshEffect.of(null) });
}

function applyFocus(on) {
  setFocusMode(on);
  appEl.classList.toggle("focus-mode", on);
  localStorage.setItem("plume-focus", on ? "1" : "0");
  view.dispatch({ effects: refreshEffect.of(null) });
}

applyFont(localStorage.getItem("plume-font") || "inter");
buildToolbar();
applyToolbar(localStorage.getItem("plume-toolbar") !== "0");
applyReveal(localStorage.getItem("plume-reveal") === "1");
applyFocus(localStorage.getItem("plume-focus") === "1");
viewToggle.addEventListener("click", toggleSourceView);

/* ---------- Image paste / drop ---------- */
async function insertImageFile(file) {
  if (currentMode !== "markdown") return;
  if (!currentPath) { flashMessage("Save the file first to add images."); return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = ((file.type.split("/")[1]) || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    const rel = await window.plume.saveImage(bytes, ext);
    if (rel) {
      const r = view.state.selection.main;
      const snippet = `![](${rel})`;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: snippet }, selection: { anchor: r.from + 2 } });
      view.focus();
      flashMessage("Saved " + rel);
    }
  } catch (e) { flashMessage("Image insert failed: " + e.message); }
}
view.dom.addEventListener("paste", (e) => {
  const img = [...(e.clipboardData?.items || [])].find((it) => it.kind === "file" && it.type.startsWith("image/"));
  if (img) { e.preventDefault(); e.stopPropagation(); insertImageFile(img.getAsFile()); }
}, true);
view.dom.addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.items || [])].some((it) => it.kind === "file" && it.type.startsWith("image/"))) e.preventDefault();
}, true);
view.dom.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); e.stopPropagation(); files.forEach(insertImageFile); }
}, true);

/* ---------- Folder sidebar ---------- */
const sidebarEl = document.getElementById("sidebar");
function currentDir() { return currentPath ? currentPath.replace(/\/[^/]*$/, "") : null; }

async function refreshSidebar() {
  if (sidebarEl.classList.contains("hidden")) return;
  const dir = currentDir();
  sidebarEl.innerHTML = "";
  if (!dir) { sidebarEl.innerHTML = '<div class="sb-empty">Open a saved file to browse its folder.</div>'; return; }
  const header = document.createElement("div");
  header.className = "sb-header";
  header.textContent = dir.split("/").pop();
  sidebarEl.appendChild(header);
  const body = document.createElement("div");
  renderTree(await window.plume.listDir(dir, 3), body, 0);
  sidebarEl.appendChild(body);
}
function renderTree(nodes, parent, depth) {
  for (const n of nodes) {
    const row = document.createElement("div");
    row.className = "sb-item sb-" + n.type;
    row.style.paddingLeft = 8 + depth * 13 + "px";
    if (n.type === "file") {
      row.textContent = n.name;
      if (n.path === currentPath) row.classList.add("active");
      row.onclick = () => window.plume.openInThisWindow(n.path);
      parent.appendChild(row);
    } else {
      row.textContent = "▸ " + n.name;
      const kids = document.createElement("div");
      kids.className = "sb-children hidden";
      let open = false;
      row.onclick = () => { open = !open; row.textContent = (open ? "▾ " : "▸ ") + n.name; kids.classList.toggle("hidden", !open); };
      renderTree(n.children || [], kids, depth + 1);
      parent.append(row, kids);
    }
  }
}
function toggleSidebar() { sidebarEl.classList.toggle("hidden"); refreshSidebar(); }

/* ---------- Command palette ---------- */
const paletteEl = document.getElementById("palette");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
let paletteFiles = [], paletteItems = [], paletteSel = 0;
const COMMANDS = [
  { label: "Toggle Files Sidebar", run: toggleSidebar },
  { label: "Toggle Outline", run: toggleOutline },
  { label: "Search in Folder", run: () => openSearch() },
  { label: "Copy as Rich Text", run: copyAsRichText },
  { label: "Copy for Google Docs", run: copyForGoogleDocs },
  { label: "Export to PDF", run: () => exportAs("pdf") },
  { label: "Export to HTML", run: () => exportAs("html") },
  { label: "Export to Word (.docx)", run: () => exportAs("docx") },
  { label: "Format Document (JSON)", run: formatDocument },
  { label: "Appearance: Dark", run: () => applyTheme("dark") },
  { label: "Appearance: Light", run: () => applyTheme("light") },
  { label: "Appearance: System", run: () => applyTheme("system") },
  { label: "Reveal Markdown Marks While Editing", run: () => applyReveal(localStorage.getItem("plume-reveal") !== "1") },
  { label: "Toggle Focus Mode", run: () => applyFocus(localStorage.getItem("plume-focus") !== "1") },
];
function flattenFiles(tree, acc = []) {
  for (const n of tree) { if (n.type === "file") acc.push(n); else flattenFiles(n.children || [], acc); }
  return acc;
}
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}
async function openPalette() {
  closeSearch();
  paletteEl.classList.remove("hidden");
  paletteInput.value = "";
  const dir = currentDir();
  paletteFiles = dir ? flattenFiles(await window.plume.listDir(dir, 3)) : [];
  renderPalette("");
  paletteInput.focus();
}
function closePalette() { paletteEl.classList.add("hidden"); view.focus(); }
function renderPalette(q) {
  const cmdMode = q.startsWith(">");
  const term = (cmdMode ? q.slice(1) : q).trim();
  const cmds = COMMANDS.filter((c) => !term || fuzzy(term, c.label)).map((c) => ({ kind: "cmd", label: c.label, run: c.run }));
  const files = cmdMode ? [] : paletteFiles.filter((f) => !term || fuzzy(term, f.name)).slice(0, 40)
    .map((f) => ({ kind: "file", label: f.name, run: () => window.plume.openInThisWindow(f.path) }));
  paletteItems = [...files, ...cmds];
  paletteSel = 0;
  drawPalette();
}
function drawPalette() {
  paletteList.innerHTML = "";
  paletteItems.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "pal-item" + (i === paletteSel ? " sel" : "");
    const icon = document.createElement("span"); icon.className = "pal-icon"; icon.textContent = it.kind === "file" ? "›" : "⚡";
    const label = document.createElement("span"); label.className = "pal-label"; label.textContent = it.label;
    row.append(icon, label);
    row.onmousedown = (e) => { e.preventDefault(); runPalette(i); };
    paletteList.appendChild(row);
  });
}
function runPalette(i) { const it = paletteItems[i]; closePalette(); if (it) it.run(); }
paletteInput.addEventListener("input", () => renderPalette(paletteInput.value));
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePalette();
  else if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); drawPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); drawPalette(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(paletteSel); }
});
paletteEl.addEventListener("mousedown", (e) => { if (e.target === paletteEl) closePalette(); });

/* ---------- Cross-file search ---------- */
const searchPanel = document.getElementById("searchpanel");
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
let searchTimer = null;
function openSearch() {
  closePalette();
  searchPanel.classList.remove("hidden");
  searchInput.value = "";
  searchResults.innerHTML = "";
  searchInput.focus();
}
function closeSearch() { searchPanel.classList.add("hidden"); }
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value;
  searchTimer = setTimeout(async () => {
    const dir = currentDir();
    if (!dir || q.length < 2) { searchResults.innerHTML = ""; return; }
    const res = await window.plume.searchFiles(dir, q);
    searchResults.innerHTML = "";
    if (!res.length) { searchResults.innerHTML = '<div class="sb-empty">No matches</div>'; return; }
    for (const r of res) {
      const row = document.createElement("div");
      row.className = "sr-item";
      const meta = document.createElement("div"); meta.className = "sr-meta"; meta.textContent = `${r.name}:${r.line}`;
      const txt = document.createElement("div"); txt.className = "sr-text"; txt.textContent = r.text;
      row.append(meta, txt);
      row.onmousedown = (e) => { e.preventDefault(); closeSearch(); window.plume.openInThisWindow(r.path, r.line); };
      searchResults.appendChild(row);
    }
  }, 160);
});
searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSearch(); view.focus(); } });
searchPanel.addEventListener("mousedown", (e) => { if (e.target === searchPanel) closeSearch(); });

/* ---------- Menu + IPC wiring ---------- */
window.plume.onOpenFile(({ filePath, content, recovery, gotoLine }) => loadDocument(content, filePath, recovery, gotoLine));
window.plume.onExternalChange(({ content }) => applyExternalChange(content));

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
    case "menu:toggleSidebar": toggleSidebar(); break;
    case "menu:palette": openPalette(); break;
    case "menu:searchFolder": openSearch(); break;
    case "menu:toggleToolbar": applyToolbar(document.getElementById("toolbar").classList.contains("hidden")); break;
    case "menu:toggleReveal": applyReveal(localStorage.getItem("plume-reveal") !== "1"); break;
    case "menu:toggleFocus": applyFocus(localStorage.getItem("plume-focus") !== "1"); break;
    case "menu:formatDoc": formatDocument(); break;
    case "menu:copyRich": copyAsRichText(); break;
    case "menu:copyHtml": copyAsHtml(); break;
    case "menu:export": exportAs(args[0]); break;
    case "menu:toggleMode": toggleSourceView(); break;
    case "menu:theme": applyTheme(args[0]); break;
  }
});

setTitle(null);
buildWelcome();
updateWelcome();

// Automation surface (used for scripting / testing the UI).
window.__plume = { toggleSidebar, openPalette, openSearch, refreshSidebar, exportAs, copyAsRichText, applyFocus, updateWelcome };
