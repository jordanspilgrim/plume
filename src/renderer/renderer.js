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
import { annotField, setAnnotRanges, locateQuote } from "./editor/annotations.js";
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
  if (u.selectionSet || u.docChanged) updateSelBar();
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
      annotField,
      syntaxHighlighting(codeHighlightStyle),
      search({ top: true }),
      keymap.of([
        { key: "Mod-j", run: () => { addAnnotation(); return true; } },
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

/* ---------- Steer-loop annotations (notes the agent can read via MCP) ---------- */
let annotations = []; // { id, quote, note, line, resolved, ts }
function annotId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function refreshAnnotRanges() {
  const ranges = [];
  for (const a of annotations) {
    const loc = locateQuote(view.state, a.quote, a.line);
    if (loc) {
      ranges.push({ id: a.id, from: loc.from, to: loc.to, resolved: a.resolved });
      a.line = view.state.doc.lineAt(loc.from).number; // re-anchor for display / agent
    }
    a.anchored = !!loc;
  }
  view.dispatch({ effects: setAnnotRanges.of(ranges) });
  renderNotes();
}

const notesEl = document.getElementById("notes");
let notesHidden = false;
function renderNotes() {
  const has = annotations.length > 0;
  notesEl.classList.toggle("hidden", !has || notesHidden);
  if (!has || notesHidden) { notesEl.innerHTML = ""; return; }
  notesEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "notes-header";
  header.textContent = `Notes · ${annotations.length}`;
  const close = document.createElement("button");
  close.className = "notes-close"; close.textContent = "×"; close.title = "Hide notes";
  close.onclick = () => { notesHidden = true; renderNotes(); };
  header.appendChild(close);
  notesEl.appendChild(header);
  for (const a of annotations.slice().sort((x, y) => x.line - y.line)) {
    const row = document.createElement("div");
    row.className = "note-item" + (a.resolved ? " resolved" : "") + (a.anchored ? "" : " orphan");
    const quote = document.createElement("div");
    quote.className = "note-quote";
    quote.textContent = a.anchored ? `“${a.quote.slice(0, 70)}”` : `“${a.quote.slice(0, 70)}” (text changed)`;
    const text = document.createElement("div");
    text.className = "note-text"; text.textContent = a.note;
    row.append(quote, text);
    row.onclick = () => {
      const loc = locateQuote(view.state, a.quote, a.line);
      if (loc) { view.dispatch({ selection: { anchor: loc.from }, effects: EditorView.scrollIntoView(loc.from, { y: "center" }) }); view.focus(); }
    };
    const bar = document.createElement("div");
    bar.className = "note-actions";
    const res = document.createElement("button");
    res.textContent = a.resolved ? "Unresolve" : "Resolve";
    res.onclick = (e) => { e.stopPropagation(); a.resolved = !a.resolved; persistAnnotations(); refreshAnnotRanges(); };
    const del = document.createElement("button");
    del.textContent = "Delete"; del.className = "ghost";
    del.onclick = (e) => { e.stopPropagation(); annotations = annotations.filter((x) => x !== a); persistAnnotations(); refreshAnnotRanges(); };
    bar.append(res, del);
    row.appendChild(bar);
    notesEl.appendChild(row);
  }
}
function persistAnnotations() { if (currentPath) window.plume.saveAnnotations(currentPath, annotations); }
async function loadAnnotationsFor(filePath) {
  annotations = filePath ? ((await window.plume.loadAnnotations(filePath)) || []) : [];
  refreshAnnotRanges();
}

let floatBox = null;
function closeFloat() { if (floatBox) { floatBox.remove(); floatBox = null; } }
function showFloatAt(x, y, build) {
  closeFloat();
  floatBox = document.createElement("div");
  floatBox.className = "annot-float";
  floatBox.style.left = Math.max(8, Math.min(x, window.innerWidth - 330)) + "px";
  floatBox.style.top = (y + 6) + "px";
  build(floatBox);
  document.body.appendChild(floatBox);
}
document.addEventListener("mousedown", (e) => {
  if (floatBox && !floatBox.contains(e.target) && !e.target.closest(".tok-annot")) closeFloat();
});

function addAnnotation() {
  const sel = view.state.selection.main;
  if (sel.empty) { flashMessage("Select text, then ⌘J to add a note for the agent"); return; }
  if (!currentPath) { flashMessage("Save the file first to add notes."); return; }
  const quote = view.state.sliceDoc(sel.from, sel.to).slice(0, 400);
  const coords = view.coordsAtPos(sel.from);
  showFloatAt(coords ? coords.left : 120, coords ? coords.bottom : 120, (box) => {
    const ta = document.createElement("textarea");
    ta.className = "annot-ta"; ta.rows = 3; ta.placeholder = "Note for the agent…  (⌘↵ to save)";
    const bar = document.createElement("div"); bar.className = "annot-bar";
    const save = document.createElement("button"); save.textContent = "Add note";
    const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.className = "ghost";
    save.onclick = () => {
      const note = ta.value.trim(); closeFloat();
      if (!note) return;
      notesHidden = false;
      annotations.push({ id: annotId(), quote, note, line: view.state.doc.lineAt(sel.from).number, resolved: false, ts: Date.now() });
      persistAnnotations(); refreshAnnotRanges(); flashMessage("Note added — the agent can read it via MCP");
    };
    cancel.onclick = closeFloat;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
      if (e.key === "Escape") { e.preventDefault(); closeFloat(); }
    });
    bar.append(save, cancel); box.append(ta, bar); ta.focus();
  });
}

// Click a highlight → view/resolve/delete the note.
view.dom.addEventListener("click", (e) => {
  const el = e.target.closest(".tok-annot"); if (!el) return;
  const id = el.getAttribute("data-annot");
  const a = annotations.find((x) => String(x.id) === id); if (!a) return;
  const r = el.getBoundingClientRect();
  showFloatAt(r.left, r.bottom, (box) => {
    const note = document.createElement("div"); note.className = "annot-note"; note.textContent = a.note;
    const bar = document.createElement("div"); bar.className = "annot-bar";
    const resolve = document.createElement("button");
    resolve.textContent = a.resolved ? "Unresolve" : "Resolve";
    resolve.onclick = () => { a.resolved = !a.resolved; persistAnnotations(); refreshAnnotRanges(); closeFloat(); };
    const del = document.createElement("button"); del.textContent = "Delete"; del.className = "ghost";
    del.onclick = () => { annotations = annotations.filter((x) => x !== a); persistAnnotations(); refreshAnnotRanges(); closeFloat(); };
    bar.append(resolve, del); box.append(note, bar);
  });
});

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
  // Markdown-only chrome: hide the formatting cluster + selection bubble in code/data modes.
  const tools = document.getElementById("titlebar-tools");
  if (tools) tools.style.display = mode === "markdown" ? "" : "none";
  const sb = document.getElementById("selbar");
  if (mode !== "markdown") {
    outlineEl.classList.add("hidden");
    if (sb) sb.classList.add("hidden");
  }
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
async function publishGoogle() {
  if (currentMode !== "markdown") { flashMessage("Publish to Google Docs works on Markdown documents."); return; }
  flashMessage("Publishing to Google Docs…");
  await window.plume.publishGoogle(view.state.doc.toString(), docBaseName());
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
  loadAnnotationsFor(filePath);
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
// Consistent 18px icon set (1.6–1.8 stroke, rounded) — all icons, no text glyphs.
const ICONS = {
  heading: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M212,56V200a12,12,0,0,1-24,0V140H68v60a12,12,0,0,1-24,0V56a12,12,0,0,1,24,0v60H188V56a12,12,0,0,1,24,0Z\"/></svg>",
  bold: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M185.08,114.46A48,48,0,0,0,148,36H80A12,12,0,0,0,68,48V200a12,12,0,0,0,12,12h80a52,52,0,0,0,25.08-97.54ZM92,60h56a24,24,0,0,1,0,48H92Zm68,128H92V132h68a28,28,0,0,1,0,56Z\"/></svg>",
  italic: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M204,56a12,12,0,0,1-12,12H160.65l-40,120H144a12,12,0,0,1,0,24H64a12,12,0,0,1,0-24H95.35l40-120H112a12,12,0,0,1,0-24h80A12,12,0,0,1,204,56Z\"/></svg>",
  strike: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M228,128a12,12,0,0,1-12,12H185.86A41.48,41.48,0,0,1,196,168c0,14.45-7.81,28.32-21.43,38.05C162,215.05,145.44,220,128,220s-34-4.95-46.57-13.95C67.81,196.32,60,182.45,60,168a12,12,0,0,1,24,0c0,15.18,20.15,28,44,28s44-12.82,44-28c0-12.76-9.3-20.18-35.35-28H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128ZM75.11,100a12,12,0,0,0,12-12c0-16,17.58-28,40.89-28,17.36,0,31.37,6.65,37.48,17.78a12,12,0,0,0,21-11.56C176.13,47.3,154.25,36,128,36,91,36,63.11,58.35,63.11,88A12,12,0,0,0,75.11,100Z\"/></svg>",
  type: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M90.86,50.89a12,12,0,0,0-21.72,0l-64,136a12,12,0,0,0,21.71,10.22L42.44,164h75.12l15.58,33.11a12,12,0,0,0,21.72-10.22ZM53.74,140,80,84.18,106.27,140ZM200,84c-13.85,0-24.77,3.86-32.45,11.48a12,12,0,1,0,16.9,17c3-3,8.26-4.52,15.55-4.52,11,0,20,7.18,20,16v4.39A47.28,47.28,0,0,0,200,124c-24.26,0-44,17.94-44,40s19.74,40,44,40a47.18,47.18,0,0,0,22-5.38A12,12,0,0,0,244,192V124C244,101.94,224.26,84,200,84Zm0,96c-11,0-20-7.18-20-16s9-16,20-16,20,7.18,20,16S211,180,200,180Z\"/></svg>",
  code: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M71.68,97.22,34.74,128l36.94,30.78a12,12,0,1,1-15.36,18.44l-48-40a12,12,0,0,1,0-18.44l48-40A12,12,0,0,1,71.68,97.22Zm176,21.56-48-40a12,12,0,1,0-15.36,18.44L221.26,128l-36.94,30.78a12,12,0,1,0,15.36,18.44l48-40a12,12,0,0,0,0-18.44ZM164.1,28.72a12,12,0,0,0-15.38,7.18l-64,176a12,12,0,0,0,7.18,15.37A11.79,11.79,0,0,0,96,228a12,12,0,0,0,11.28-7.9l64-176A12,12,0,0,0,164.1,28.72Z\"/></svg>",
  link: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M117.18,188.74a12,12,0,0,1,0,17l-5.12,5.12A58.26,58.26,0,0,1,70.6,228h0A58.62,58.62,0,0,1,29.14,127.92L63.89,93.17a58.64,58.64,0,0,1,98.56,28.11,12,12,0,1,1-23.37,5.44,34.65,34.65,0,0,0-58.22-16.58L46.11,144.89A34.62,34.62,0,0,0,70.57,204h0a34.41,34.41,0,0,0,24.49-10.14l5.11-5.12A12,12,0,0,1,117.18,188.74ZM226.83,45.17a58.65,58.65,0,0,0-82.93,0l-5.11,5.11a12,12,0,0,0,17,17l5.12-5.12a34.63,34.63,0,1,1,49,49L175.1,145.86A34.39,34.39,0,0,1,150.61,156h0a34.63,34.63,0,0,1-33.69-26.72,12,12,0,0,0-23.38,5.44A58.64,58.64,0,0,0,150.56,180h.05a58.28,58.28,0,0,0,41.47-17.17l34.75-34.75a58.62,58.62,0,0,0,0-82.91Z\"/></svg>",
  bullet: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M76,64A12,12,0,0,1,88,52H216a12,12,0,0,1,0,24H88A12,12,0,0,1,76,64Zm140,52H88a12,12,0,0,0,0,24H216a12,12,0,0,0,0-24Zm0,64H88a12,12,0,0,0,0,24H216a12,12,0,0,0,0-24ZM44,112a16,16,0,1,0,16,16A16,16,0,0,0,44,112Zm0-64A16,16,0,1,0,60,64,16,16,0,0,0,44,48Zm0,128a16,16,0,1,0,16,16A16,16,0,0,0,44,176Z\"/></svg>",
  ordered: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M228,128a12,12,0,0,1-12,12H116a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128ZM116,76H216a12,12,0,0,0,0-24H116a12,12,0,0,0,0,24ZM216,180H116a12,12,0,0,0,0,24H216a12,12,0,0,0,0-24ZM44,59.31V104a12,12,0,0,0,24,0V40A12,12,0,0,0,50.64,29.27l-16,8a12,12,0,0,0,9.36,22Zm39.73,96.86a27.7,27.7,0,0,0-11.2-18.63A28.89,28.89,0,0,0,32.9,143a27.71,27.71,0,0,0-4.17,7.54,12,12,0,0,0,22.55,8.21,4,4,0,0,1,.58-1,4.78,4.78,0,0,1,6.5-.82,3.82,3.82,0,0,1,1.61,2.6,3.63,3.63,0,0,1-.77,2.77l-.13.17L30.39,200.82A12,12,0,0,0,40,220H72a12,12,0,0,0,0-24H64l14.28-19.11A27.48,27.48,0,0,0,83.73,156.17Z\"/></svg>",
  task: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M228,128a12,12,0,0,1-12,12H128a12,12,0,0,1,0-24h88A12,12,0,0,1,228,128ZM128,76h88a12,12,0,0,0,0-24H128a12,12,0,0,0,0,24Zm88,104H128a12,12,0,0,0,0,24h88a12,12,0,0,0,0-24ZM79.51,39.51,56,63l-7.51-7.52a12,12,0,0,0-17,17l16,16a12,12,0,0,0,17,0l32-32a12,12,0,0,0-17-17Zm0,64L56,127l-7.51-7.52a12,12,0,1,0-17,17l16,16a12,12,0,0,0,17,0l32-32a12,12,0,0,0-17-17Zm0,64L56,191l-7.51-7.52a12,12,0,1,0-17,17l16,16a12,12,0,0,0,17,0l32-32a12,12,0,0,0-17-17Z\"/></svg>",
  quote: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M100,52H40A20,20,0,0,0,20,72v64a20,20,0,0,0,20,20H96v4a28,28,0,0,1-28,28,12,12,0,0,0,0,24,52.06,52.06,0,0,0,52-52V72A20,20,0,0,0,100,52Zm-4,80H44V76H96ZM216,52H156a20,20,0,0,0-20,20v64a20,20,0,0,0,20,20h56v4a28,28,0,0,1-28,28,12,12,0,0,0,0,24,52.06,52.06,0,0,0,52-52V72A20,20,0,0,0,216,52Zm-4,80H160V76h52Z\"/></svg>",
  codeblock: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M51.51,104.49l-32-32a12,12,0,0,1,0-17l32-32a12,12,0,1,1,17,17L45,64,68.49,87.51a12,12,0,0,1-17,17Zm48,0a12,12,0,0,0,17,0l32-32a12,12,0,0,0,0-17l-32-32a12,12,0,1,0-17,17L123,64,99.51,87.51A12,12,0,0,0,99.51,104.49ZM200,36H180a12,12,0,0,0,0,24h16V196H60V140a12,12,0,0,0-24,0v60a20,20,0,0,0,20,20H200a20,20,0,0,0,20-20V56A20,20,0,0,0,200,36Z\"/></svg>",
  table: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M224,44H32A12,12,0,0,0,20,56V192a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A12,12,0,0,0,224,44ZM44,116H76v24H44Zm56,0H212v24H100ZM212,68V92H44V68ZM44,164H76v24H44Zm56,24V164H212v24Z\"/></svg>",
  hr: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z\"/></svg>",
  image: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M144,96a16,16,0,1,1,16,16A16,16,0,0,1,144,96Zm92-40V200a20,20,0,0,1-20,20H40a20,20,0,0,1-20-20V56A20,20,0,0,1,40,36H216A20,20,0,0,1,236,56ZM44,60v79.72l33.86-33.86a20,20,0,0,1,28.28,0L147.31,147l17.18-17.17a20,20,0,0,1,28.28,0L212,149.09V60Zm0,136H162.34L92,125.66l-48,48Zm168,0V183l-33.37-33.37L164.28,164l32,32Z\"/></svg>",
  gdocs: "<svg viewBox=\"0 0 18 18\"><path d=\"M4.5 2h4.6L12.5 5.4V15a.6.6 0 0 1-.6.6H4.5a.6.6 0 0 1-.6-.6V2.6A.6.6 0 0 1 4.5 2z\" fill=\"none\" stroke=\"#4285F4\" stroke-width=\"1.3\" stroke-linejoin=\"round\"/><path d=\"M9 2.2v3.4h3.4\" fill=\"none\" stroke=\"#4285F4\" stroke-width=\"1.3\"/><path d=\"M6.2 8.6h5.4M6.2 10.7h5.4M6.2 12.8h3.8\" stroke=\"#4285F4\" stroke-width=\"1.1\" stroke-linecap=\"round\"/></svg>",
};
const CHEVRON = '<svg class="tb-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';

ICONS.plus = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 4v10M4 9h10"/></svg>';
const CHEV_TT = '<svg class="tt-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';

// Always-visible cluster folded into the title bar (block style · insert · font).
const TITLE_CLUSTER = [
  { t: "Paragraph style", svg: "heading", menu: "heading" },
  { t: "Insert", svg: "plus", menu: "insert" },
  { t: "Editor font", svg: "type", menu: "font" },
];
// Inline formatting — surfaced contextually in the selection bubble.
const INLINE_FORMATS = [
  { t: "Bold  ⌘B", svg: "bold", fn: () => applyFormat("bold") },
  { t: "Italic  ⌘I", svg: "italic", fn: () => applyFormat("italic") },
  { t: "Strikethrough  ⌘⇧X", svg: "strike", fn: () => applyFormat("strike") },
  { t: "Inline code  ⌘E", svg: "code", fn: () => applyFormat("code") },
  { t: "Link  ⌘K", svg: "link", fn: () => applyFormat("link") },
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

/* ---------- Title-bar cluster ---------- */
function buildTitleTools() {
  const host = document.getElementById("titlebar-tools");
  host.innerHTML = "";
  for (const b of TITLE_CLUSTER) {
    const btn = document.createElement("button");
    btn.className = "tt-btn has-menu";
    btn.title = b.t;
    btn.setAttribute("aria-label", b.t);
    btn.innerHTML = ICONS[b.svg] + CHEV_TT;
    btn.addEventListener("click", () => openToolbarMenu(btn, b.menu));
    host.appendChild(btn);
  }
}

/* ---------- Contextual selection bubble (inline formatting) ---------- */
const selbar = document.getElementById("selbar");
function buildSelBar() {
  selbar.innerHTML = "";
  for (const b of INLINE_FORMATS) {
    const btn = document.createElement("button");
    btn.className = "sel-btn";
    btn.title = b.t;
    btn.setAttribute("aria-label", b.t);
    btn.innerHTML = ICONS[b.svg];
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
    btn.addEventListener("click", b.fn);
    selbar.appendChild(btn);
  }
}
function updateSelBar() {
  const sel = view.state.selection.main;
  if (currentMode !== "markdown" || sel.empty) { selbar.classList.add("hidden"); return; }
  const a = view.coordsAtPos(sel.from);
  const b = view.coordsAtPos(sel.to);
  if (!a || !b) { selbar.classList.add("hidden"); return; }
  selbar.classList.remove("hidden");
  const bw = selbar.offsetWidth || 200;
  const bh = selbar.offsetHeight || 38;
  let left = (a.left + b.right) / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  let top = Math.min(a.top, b.top) - bh - 8;
  if (top < 52) top = Math.max(a.bottom, b.bottom) + 8; // flip below if no room above
  selbar.style.left = left + "px";
  selbar.style.top = top + "px";
}

/* ---------- Dropdown menus (heading / insert / font) ---------- */
let openMenuEl = null;
function closeToolbarMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
document.addEventListener("mousedown", (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest(".has-menu")) closeToolbarMenu();
});
function headingMenuItems() {
  const lvl = (view.state.doc.lineAt(view.state.selection.main.head).text.match(/^(#{1,6}) /) || [])[1]?.length || 0;
  return [
    { label: "Title", fn: () => setHeading(1), checked: lvl === 1 },
    { label: "Heading", fn: () => setHeading(2), checked: lvl === 2 },
    { label: "Subheading", fn: () => setHeading(3), checked: lvl === 3 },
    { label: "Body text", fn: () => setHeading(0), checked: lvl === 0 },
  ];
}
function insertMenuItems() {
  const l = view.state.doc.lineAt(view.state.selection.main.head).text;
  return [
    { label: "Bullet list", fn: () => toggleLinePrefix(/^\s*[-*+] /, () => "- "), checked: /^\s*[-*+] /.test(l) && !/^\s*[-*+] \[[ xX]\] /.test(l) },
    { label: "Numbered list", fn: () => toggleLinePrefix(/^\s*\d+\. /, (i) => `${i + 1}. `), checked: /^\s*\d+\. /.test(l) },
    { label: "Task list", fn: () => toggleLinePrefix(/^\s*[-*+] \[[ xX]\] /, () => "- [ ] "), checked: /^\s*[-*+] \[[ xX]\] /.test(l) },
    { label: "Quote", fn: () => toggleLinePrefix(/^> ?/, () => "> "), checked: /^\s*> /.test(l) },
    { sep: true },
    { label: "Code block", fn: insertCodeBlock },
    { label: "Table", fn: insertTable },
    { label: "Divider", fn: insertHR },
    { label: "Image", fn: editImageAlt },
  ];
}
function fontMenuItems() {
  const cur = localStorage.getItem("plume-font") || "inter";
  return FONTS.map((f) => ({ label: f.label, fn: () => applyFont(f.id), checked: f.id === cur }));
}
function openToolbarMenu(anchor, kind) {
  if (openMenuEl) { closeToolbarMenu(); return; }
  const items = kind === "heading" ? headingMenuItems() : kind === "insert" ? insertMenuItems() : fontMenuItems();
  const menu = document.createElement("div");
  menu.className = "tb-menu";
  for (const it of items) {
    if (it.sep) { const s = document.createElement("div"); s.className = "tb-menu-sep"; menu.appendChild(s); continue; }
    const row = document.createElement("button");
    row.className = "tb-menu-item" + (it.checked ? " checked" : "");
    row.innerHTML = `<span class="tbm-check">${it.checked ? "✓" : ""}</span><span>${it.label}</span>`;
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => { closeToolbarMenu(); it.fn(); view.focus(); });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 10) + "px";
  menu.style.top = r.bottom + 6 + "px";
  openMenuEl = menu;
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
buildTitleTools();
buildSelBar();
view.scrollDOM.addEventListener("scroll", () => { if (!selbar.classList.contains("hidden")) updateSelBar(); });
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
let sidebarRoot = null; // explicit root from `plume .`; otherwise the open file's dir
function currentDir() { return sidebarRoot || (currentPath ? currentPath.replace(/\/[^/]*$/, "") : null); }

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
  { label: "Claude Code Sessions & Context", run: () => openWorkspace() },
  { label: "Copy as Rich Text", run: copyAsRichText },
  { label: "Copy for Google Docs", run: copyForGoogleDocs },
  { label: "Export to PDF", run: () => exportAs("pdf") },
  { label: "Export to HTML", run: () => exportAs("html") },
  { label: "Export to Word (.docx)", run: () => exportAs("docx") },
  { label: "Publish to Google Docs", run: () => publishGoogle() },
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

/* ---------- Sessions & project context (Claude Code workspace) ---------- */
const wsEl = document.getElementById("workspace");
const wsInput = document.getElementById("ws-input");
const wsList = document.getElementById("ws-list");
let wsSessions = [], wsContext = [], wsTimer = null, wsRows = [], wsSel = 0;

async function openWorkspace() {
  closePalette(); closeSearch();
  wsEl.classList.remove("hidden");
  wsInput.value = "";
  const dir = currentDir();
  [wsContext, wsSessions] = await Promise.all([
    window.plume.listContext(dir),
    window.plume.listSessions(dir),
  ]);
  renderWorkspace("");
  wsInput.focus();
}
function closeWorkspace() { wsEl.classList.add("hidden"); }

function tsLabel(ms) {
  const d = Date.now() - ms;
  if (d < 6e4) return "just now";
  if (d < 36e5) return Math.round(d / 6e4) + "m ago";
  if (d < 864e5) return Math.round(d / 36e5) + "h ago";
  return Math.round(d / 864e5) + "d ago";
}

function renderWorkspace(q) {
  const term = q.trim().toLowerCase();
  wsRows = []; wsSel = 0; wsList.innerHTML = "";
  const addGroup = (label) => { const h = document.createElement("div"); h.className = "ws-group"; h.textContent = label; wsList.appendChild(h); };
  const addRow = (title, sub, openPath, line) => {
    const row = document.createElement("div");
    row.className = "ws-item";
    const t = document.createElement("div"); t.className = "ws-title"; t.textContent = title;
    const s = document.createElement("div"); s.className = "ws-sub"; s.textContent = sub;
    row.append(t, s);
    const idx = wsRows.length;
    row.onmousedown = (e) => { e.preventDefault(); closeWorkspace(); window.plume.openInThisWindow(openPath, line); };
    row.onmouseenter = () => { wsSel = idx; paintWsSel(); };
    wsList.appendChild(row);
    wsRows.push({ el: row, path: openPath, line });
  };

  const ctx = wsContext.filter((c) => !term || c.name.toLowerCase().includes(term));
  if (ctx.length) { addGroup("Project context"); ctx.forEach((c) => addRow(c.name, c.path.replace(/\/[^/]*$/, ""), c.path)); }

  const sess = wsSessions.filter((s) => !term || s.title.toLowerCase().includes(term));
  if (sess.length) { addGroup(term ? "Sessions (title)" : "Recent Claude Code sessions"); sess.slice(0, 40).forEach((s) => addRow(s.title, tsLabel(s.ts), s.path)); }

  if (!wsRows.length && !term) wsList.innerHTML = '<div class="sb-empty">No Claude Code sessions or context files for this folder.</div>';
  paintWsSel();

  if (term.length >= 2) {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(async () => {
      const hits = await window.plume.searchSessions(term, currentDir());
      const shown = new Set(wsRows.map((r) => r.path));
      const fresh = hits.filter((h) => !shown.has(h.path));
      if (fresh.length) {
        addGroup("Matches in transcript");
        fresh.forEach((h) => addRow(h.title, h.snippet, h.path));
        paintWsSel();
      }
    }, 200);
  }
}
function paintWsSel() {
  wsRows.forEach((r, i) => r.el.classList.toggle("sel", i === wsSel));
  if (wsRows[wsSel]) wsRows[wsSel].el.scrollIntoView({ block: "nearest" });
}
wsInput.addEventListener("input", () => renderWorkspace(wsInput.value));
wsInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeWorkspace(); view.focus(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); wsSel = Math.min(wsSel + 1, wsRows.length - 1); paintWsSel(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); wsSel = Math.max(wsSel - 1, 0); paintWsSel(); }
  else if (e.key === "Enter") { const r = wsRows[wsSel]; if (r) { closeWorkspace(); window.plume.openInThisWindow(r.path, r.line); } }
});
wsEl.addEventListener("mousedown", (e) => { if (e.target === wsEl) closeWorkspace(); });

/* ---------- Menu + IPC wiring ---------- */
window.plume.onOpenFile(({ filePath, content, recovery, gotoLine }) => loadDocument(content, filePath, recovery, gotoLine));
window.plume.onExternalChange(({ content }) => applyExternalChange(content));
window.plume.onFolderOpen(({ dir }) => {
  sidebarRoot = dir;
  sidebarEl.classList.remove("hidden");
  refreshSidebar();
});

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
    case "menu:workspace": openWorkspace(); break;
    case "menu:toggleToolbar": break; // toolbar slab retired; controls live in the title bar
    case "menu:toggleReveal": applyReveal(localStorage.getItem("plume-reveal") !== "1"); break;
    case "menu:toggleFocus": applyFocus(localStorage.getItem("plume-focus") !== "1"); break;
    case "menu:formatDoc": formatDocument(); break;
    case "menu:copyRich": copyAsRichText(); break;
    case "menu:copyHtml": copyAsHtml(); break;
    case "menu:export": exportAs(args[0]); break;
    case "menu:publishGoogle": publishGoogle(); break;
    case "menu:toggleMode": toggleSourceView(); break;
    case "menu:theme": applyTheme(args[0]); break;
  }
});

setTitle(null);
buildWelcome();
updateWelcome();

// Automation surface (used for scripting / testing the UI).
window.__plume = { toggleSidebar, openPalette, openSearch, openWorkspace, refreshSidebar, exportAs, copyAsRichText, applyFocus, updateWelcome, addAnnotation, view };

// Agent surface — read by the main process (executeJavaScript) for the MCP server.
window.__plumeAgent = {
  getActiveDocument: () => ({
    path: currentPath,
    content: view.state.doc.toString(),
    mode: currentMode,
    dirty: titlebar.classList.contains("dirty"),
  }),
  getSelection: () => {
    const s = view.state.selection.main;
    return {
      path: currentPath,
      text: view.state.sliceDoc(s.from, s.to),
      fromLine: view.state.doc.lineAt(s.from).number,
      toLine: view.state.doc.lineAt(s.to).number,
      empty: s.empty,
    };
  },
  getAnnotations: () => {
    refreshAnnotRanges();
    return annotations.map((a) => ({ id: a.id, quote: a.quote, note: a.note, line: a.line, resolved: !!a.resolved, ts: a.ts }));
  },
};
