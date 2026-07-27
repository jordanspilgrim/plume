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
import { syntaxTree, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { codeLanguages, codeHighlightStyle } from "./editor/highlight.js";
import { livePreview, setDocPath, setMermaidTheme, setRevealMarks, setFocusMode, refreshEffect, renderMermaidInto, Highlight } from "./editor/livePreview.js";
import { modeForPath, languageForExt, codeFeatures, extOf, baseName } from "./editor/modes.js";
import { diffDecorations, logDecorations } from "./editor/decorators.js";
import { annotField, setAnnotRanges, locateQuote } from "./editor/annotations.js";
import { computeSegments, applySegments, hunkCount } from "./diff.js";
import { renderJsonl, renderCsv, looksLikeTranscript, renderConversation } from "./editor/viewers.js";
import { htmlToMarkdown, looksRich, inlinePastedImages } from "./editor/paste.js";
import {
  createTab, findTab, addTab, closeTab, cycleTabId, tabDisplayName, isCapturedDirty, isBlankTab,
  closeDecision, dirtyBackgroundTabs, isDraftTab, isKeepableDraft, findTabByPath,
} from "./tabs-model.js";
import { mdToHtml, fullHtmlDocument } from "./editor/export.js";
import "katex/dist/katex.min.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

/* ---------- Platform (drives per-OS chrome: traffic-light padding etc.) ---------- */
// macOS uses a custom overlay title bar (traffic lights overlaid); Windows/Linux
// get the native window frame, so they don't need the traffic-light left padding.
{
  const ua = navigator.userAgent;
  const p = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac OS X/i.test(ua) ? "mac"
    : /Win/i.test(navigator.platform) || /Windows/i.test(ua) ? "windows"
    : "linux";
  document.documentElement.dataset.platform = p;
}

/* ---------- State ---------- */
let savedText = "";
let currentPath = null; // THE single source of truth for the active doc's path (bridge is stateless)
let pendingName = null; // a name set via the title bar before an untitled doc is saved
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
  if (u.docChanged) { scheduleSideEffects(); updateWelcome(); maybeCreateDraft(); }
  if (u.selectionSet) updateStatus();
  if (u.selectionSet || u.docChanged) updateSelBar();
  handleSlash(u);
});

// List auto-continuation (Enter) already inserts the marker on the next line.
// If the user then types the marker again out of habit, absorb the duplicate so
// "- " + typed "- " doesn't become "- - " (and likewise for "1. ", "* ", "+ ").
const listMarkerDedup = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== " " || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const before = view.state.doc.sliceString(line.from, from);
  const m = /^\s*(?:[-*+]|\d+[.)])\s+([-*+]|\d+[.)])$/.exec(before);
  if (!m) return false;
  const dupStart = from - m[1].length; // start of the just-typed redundant marker
  view.dispatch({ changes: { from: dupStart, to: from }, selection: { anchor: dupStart } });
  return true; // swallow the space; the original marker + its space remain
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
      // Tab nests list items a full 4-space "tab" — matching pasted nesting,
      // instead of CodeMirror's narrow 2-space default.
      indentUnit.of("    "),
      // Override CodeMirror's default monospace content font with the themeable body font.
      EditorView.theme({
        "&": { fontFamily: "var(--font-body)" },
        ".cm-content": { fontFamily: "var(--font-body)" },
        ".cm-scroller": { fontFamily: "var(--font-body)" },
      }),
      langConf.of(markdownLang()),
      previewConf.of(livePreview),
      codeConf.of([]),
      listMarkerDedup,
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

  // Crash-recovery snapshot. Routes by the native binding, which detachDoc()
  // now really clears on untitled tabs — no misroute guard needed. (Interim
  // note: until A-native lands detach_doc, an untitled tab in a previously
  // file-backed window can misfile its snapshot into that file's recovery
  // slot — benign, user-confirmed banner content only; merge order handles it.)
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    // Path-backed non-draft docs only: drafts' Autosave file IS the live copy,
    // and the untitled snapshot subsystem is gone (first-keystroke ruling).
    if (!currentPath || isDraft(activeTab())) return;
    window.plume.snapshot(view.state.doc.toString());
  }, 700);

  // Autosave the open file after a short idle.
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 1300);
}

function autosaveEnabled() { return localStorage.getItem("plume-autosave") !== "0"; }

// Draft filename = stable timestamp form (owner ruled FIRST-KEYSTROKE: at
// creation time the buffer is one character, so a content slug would be junk;
// the human-readable name is listDrafts' title, derived from content at list
// time). Native uniquifies against collisions.
function draftTimestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `note-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// FIRST-KEYSTROKE draft creation (owner ruling): the moment an untitled
// markdown buffer becomes non-empty it is backed by an Autosave draft file —
// no debounce window in which a crash could lose a brand-new note. Untitled
// crash snapshots are gone (native subsystem deleted); this replaces them.
// Per-TAB in-flight set: a second untitled tab's first keystroke creates its
// own draft concurrently (native unique_path handles names) instead of being
// dropped by a global flag.
const draftCreatesInFlight = new Set();
async function maybeCreateDraft() {
  if (currentPath || currentMode !== "markdown") return;
  if (!window.plume.createDraft || !autosaveEnabled()) return;
  const initTabId = activeTabId;
  if (draftCreatesInFlight.has(initTabId)) return;
  const t = activeTab();
  if (t && t.unbound) return;
  const text0 = view.state.doc.toString();
  if (!text0.trim()) return;
  draftCreatesInFlight.add(initTabId);
  try {
    const r = await window.plume.createDraft(pendingName || draftTimestampName(), text0);
    if (!r || !r.path) return;
    if (!draftsDir) draftsDir = r.path.slice(0, r.path.lastIndexOf("/") + 1); // fallback derivation
    // The user may have switched tabs, closed the tab, or Saved-As during the
    // round-trip (HIGH regression: completion used to mutate whatever tab was
    // active NOW). Dispatch on the INITIATING tab's identity + state:
    const t0 = findTab(tabs, initTabId);
    if (!t0 || t0.path !== null) {
      // Initiator closed (e.g. Don't Save mid-flight) or no longer untitled
      // (Saved-As / retargeted): the landed draft contradicts the user's
      // expressed intent — remove it, touch nothing else.
      window.plume.discardDraft?.(r.path);
    } else if (initTabId === activeTabId && !currentPath) {
      // Initiator still active and untitled: the original full update.
      savedText = text0;
      setTitle(r.path);
      t0.path = r.path;
      t0.unbound = false;
      // The user keeps typing during the round-trip — recompute, never assert clean.
      setDirty(view.state.doc.toString() !== savedText);
      pushOpenPaths();
    } else {
      // Initiator alive but BACKGROUNDED: update only its captured record —
      // no global (active-doc) state may move. savedText = what was written,
      // so isCapturedDirty reflects any pre-switch typing.
      t0.path = r.path;
      t0.unbound = false;
      t0.pendingName = null;
      t0.savedText = text0;
      pushOpenPaths(); // tab-set-derived, safe globally
    }
    // Binding re-assert: native bound the new draft to this WINDOW at create
    // completion, which may have stolen the binding from whatever the user
    // switched to mid-flight. Re-align native to the ACTIVE tab.
    if (initTabId !== activeTabId || currentPath) {
      // Deterministic: whenever we can't rebind the active tab's path (untitled
      // OR unbound — a stale path must never be re-bound), detach. The old
      // `else if (!currentPath)` left the binding stale when the user switched
      // to an UNBOUND tab mid-flight, letting the 700ms snapshot write that
      // tab's content into the new draft's recovery slot (re-verify MED).
      if (currentPath && !(activeTab() && activeTab().unbound)) {
        window.plume.bindDoc(currentPath).catch(() => {}); // bridge already catch-nulls; belt-and-braces
      } else {
        window.plume.detachDoc?.();
      }
    }
  } finally { draftCreatesInFlight.delete(initTabId); }
}

let autosaving = false;
// Autosave writes an OPEN (path-backed) file back to its own path. SAVEFLOW:
// an untitled MARKDOWN buffer becomes a DRAFT on its first dirty tick — the
// native side creates + binds ~/Documents/Plume/Autosave/<derived>.md and
// autosave then rides the normal explicit-path write. The close prompt stays
// (owner option B: drafts prompt regardless of dirty); a scratch code buffer
// never becomes a stray .md. Inert until the native create_draft lands.
async function autosave() {
  // Untitled buffers never reach here: first-keystroke draft creation
  // (maybeCreateDraft) backs them with a path before any autosave tick.
  if (!autosaveEnabled() || autosaving || !currentPath) return;
  // A dropped binding (file moved/deleted under this tab) must never autosave —
  // the next save is an explicit Save As so the user picks the destination.
  const t = activeTab();
  if (t && t.unbound) return;
  const text = view.state.doc.toString();
  if (text === savedText) return;
  autosaving = true;
  try {
    const result = await window.plume.save(currentPath, text);
    if (result) { savedText = text; setDirty(false); return; }
    // Refused/failed write mid-autosave: the binding is gone (file moved?).
    // Autosave must not pop dialogs — mark the tab unbound (stops further
    // autosaves; ⌘S now routes to Save As) and tell the user once.
    const t2 = activeTab();
    if (t2 && !t2.unbound) {
      t2.unbound = true;
      flashMessage(`Autosave couldn't write ${currentPath.split("/").pop()} — it may have moved. Save (⌘S) to choose where.`);
    }
  } finally {
    autosaving = false;
  }
}

function setDirty(dirty) {
  titlebar.classList.toggle("dirty", dirty);
  // Per-PATH flag feeding only the agent write_document guard; the renderer is
  // its single writer (cleared on save / tab close / close resolution).
  if (currentPath) window.plume.setDocDirty(currentPath, dirty);
  if (tabs.length > 1) renderTabbar(); // keep the active tab's dirty dot honest
}

// Flush a save when the window loses focus, so nothing is lost on app switch.
window.addEventListener("blur", () => { autosave(); });

/* ---------- Title ---------- */
function setTitle(pathOrNull) {
  currentPath = pathOrNull;
  const name = pathOrNull ? pathOrNull.split("/").pop() : (pendingName || "Untitled");
  document.title = name;
  if (tabs.length > 1) renderTabbar(); // active tab label follows the title
  if (titlebarName.classList.contains("editing")) return; // don't clobber an in-progress rename
  titlebarName.textContent = name;
}

/* ---------- Rename via the title bar (click the filename) ---------- */
function startTitleRename() {
  if (titlebarName.classList.contains("editing")) return;
  const base = currentPath ? currentPath.split("/").pop().replace(/\.[^.]+$/, "") : (pendingName || "");
  titlebarName.classList.add("editing");
  titlebarName.contentEditable = "plaintext-only";
  titlebarName.spellcheck = false;
  titlebarName.textContent = base;
  const range = document.createRange();
  range.selectNodeContents(titlebarName);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  titlebarName.focus();
}
async function commitTitleRename(cancel) {
  if (!titlebarName.classList.contains("editing")) return;
  const raw = titlebarName.textContent.trim();
  titlebarName.classList.remove("editing");
  titlebarName.contentEditable = "false";
  if (cancel || !raw) { setTitle(currentPath); return; }
  if (currentPath) {
    const p = await window.plume.renameFile(currentPath, raw);
    setTitle(p || currentPath);
    if (p) setDocPath(view, p); // same relative-base desync class as saveAs
  } else {
    pendingName = raw; // becomes the draft filename when the first keystroke creates it
    setTitle(null);
  }
}
// The title name is no-drag so it's clickable to rename — but that would make
// the center of the title bar (the prime grab spot) undraggable. Disambiguate:
// move past a small threshold → start an OS window drag; release without moving
// → treat it as a click and rename.
titlebarName.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || titlebarName.classList.contains("editing")) return;
  const sx = e.clientX, sy = e.clientY;
  let dragging = false;
  const cleanup = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) {
      dragging = true;
      cleanup();
      window.plume.startWindowDrag && window.plume.startWindowDrag();
    }
  };
  const up = () => { cleanup(); if (!dragging) startTitleRename(); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});
titlebarName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); titlebarName.blur(); }
  else if (e.key === "Escape") { e.preventDefault(); commitTitleRename(true); titlebarName.blur(); }
});
titlebarName.addEventListener("blur", () => commitTitleRename(false));

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
  const rec = document.createElement("div");
  rec.className = "welcome-recents";
  rec.id = "welcome-recents";
  const drafts = document.createElement("div");
  drafts.className = "welcome-recents";
  drafts.id = "welcome-drafts";
  welcomeEl.append(art, tag, hints, blink, drafts, rec);
}
function renderWelcomeRecents() {
  const host = document.getElementById("welcome-recents");
  if (!host) return;
  host.innerHTML = "";
  const recents = loadRecents().slice(0, 6);
  if (!recents.length) return;
  const head = document.createElement("div");
  head.className = "welcome-recents-head";
  head.textContent = "RECENT";
  host.appendChild(head);
  for (const p of recents) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "welcome-recent";
    const name = document.createElement("span"); name.className = "welcome-recent-name"; name.textContent = p.split("/").pop();
    const path = document.createElement("span"); path.className = "welcome-recent-path"; path.textContent = p.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
    row.append(name, path);
    row.onclick = () => smartOpen(p);
    host.appendChild(row);
  }
}
// M4: autosaved drafts get a visible home — without this they were invisible
// after switching away (files persist in Autosave/ with no in-app surface).
async function renderWelcomeDrafts() {
  const host = document.getElementById("welcome-drafts");
  if (!host || !window.plume.listDrafts) return;
  const open = new Set(tabs.map((t) => t.path).filter(Boolean));
  const drafts = ((await window.plume.listDrafts()) || []).filter((d) => !open.has(d.path)).slice(0, 6);
  host.innerHTML = "";
  if (!drafts.length) return;
  const head = document.createElement("div");
  head.className = "welcome-recents-head";
  head.textContent = "DRAFTS";
  host.appendChild(head);
  for (const d of drafts) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "welcome-recent";
    const name = document.createElement("span"); name.className = "welcome-recent-name"; name.textContent = d.title || d.path.split("/").pop();
    const path = document.createElement("span"); path.className = "welcome-recent-path"; path.textContent = "draft";
    row.append(name, path);
    row.onclick = () => smartOpen(d.path);
    host.appendChild(row);
  }
}
function updateWelcome() {
  const empty = view.state.doc.length === 0 && !currentPath && currentMode === "markdown";
  welcomeEl.classList.toggle("hidden", !empty);
  if (empty) { renderWelcomeRecents(); renderWelcomeDrafts(); }
}

/* ---------- Steer-loop annotations (notes the agent can read via MCP) ---------- */
let annotations = []; // { id, quote, note, suggestion, verdict, line, resolved, ts }
function annotId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Typed steering verdicts — the prose analog of code-review accept/reject. Each
// annotation carries one, turning a margin note into a structured directive the
// agent reads via MCP. `hint` drives the input placeholder; `needsDetail` marks
// verdicts that require text (revise/reject/question) vs. optional (approve/pin).
const VERDICTS = {
  revise:   { label: "Revise",   glyph: "✎", hint: "What should change?", needsDetail: true },
  approve:  { label: "Approve",  glyph: "✓", hint: "Optional: why this is good", needsDetail: false },
  reject:   { label: "Reject",   glyph: "✕", hint: "Why reject this?", needsDetail: true },
  question: { label: "Question", glyph: "?", hint: "Your question for the agent", needsDetail: true },
  pin:      { label: "Pin",      glyph: "📌", hint: "Optional: why this must stay", needsDetail: false },
};
const VERDICT_KEYS = ["revise", "approve", "reject", "question", "pin"];
function verdictOf(a) { return VERDICTS[a && a.verdict] ? a.verdict : "revise"; } // legacy notes → revise

function refreshAnnotRanges() {
  const ranges = [];
  for (const a of annotations) {
    const loc = locateQuote(view.state, a.quote, a.line);
    if (loc) {
      ranges.push({ id: a.id, from: loc.from, to: loc.to, resolved: a.resolved, verdict: verdictOf(a) });
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
    const vk = verdictOf(a);
    row.className = "note-item v-" + vk + (a.resolved ? " resolved" : "") + (a.anchored ? "" : " orphan");
    const chip = document.createElement("span");
    chip.className = "verdict-chip v-" + vk + " mini";
    chip.innerHTML = `<span class="vg">${VERDICTS[vk].glyph}</span>${VERDICTS[vk].label}`;
    const quote = document.createElement("div");
    quote.className = "note-quote";
    quote.textContent = a.anchored ? `“${a.quote.slice(0, 70)}”` : `“${a.quote.slice(0, 70)}” (text changed)`;
    row.append(chip, quote);
    if (a.note) { const text = document.createElement("div"); text.className = "note-text"; text.textContent = a.note; row.append(text); }
    if (a.suggestion) { const s = document.createElement("div"); s.className = "note-suggestion"; s.textContent = "→ " + a.suggestion; row.append(s); }
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
    let verdict = "revise";
    const ta = document.createElement("textarea");
    ta.className = "annot-ta"; ta.rows = 3; ta.placeholder = VERDICTS[verdict].hint + "  (⌘↵ to save)";
    const repl = document.createElement("input");
    repl.className = "annot-repl"; repl.placeholder = "Replace with…  (optional)";
    repl.style.display = verdict === "revise" ? "" : "none";
    // Verdict picker — selecting one adapts the inputs to that directive type.
    const picker = document.createElement("div"); picker.className = "verdict-picker";
    const chips = {};
    for (const k of VERDICT_KEYS) {
      const c = document.createElement("button");
      c.type = "button"; c.className = "verdict-chip v-" + k + (k === verdict ? " sel" : "");
      c.innerHTML = `<span class="vg">${VERDICTS[k].glyph}</span>${VERDICTS[k].label}`;
      c.onclick = () => {
        verdict = k;
        for (const kk of VERDICT_KEYS) chips[kk].classList.toggle("sel", kk === k);
        ta.placeholder = VERDICTS[k].hint + "  (⌘↵ to save)";
        repl.style.display = k === "revise" ? "" : "none";
        ta.focus();
      };
      chips[k] = c; picker.appendChild(c);
    }
    const bar = document.createElement("div"); bar.className = "annot-bar";
    const save = document.createElement("button"); save.textContent = "Add directive";
    const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.className = "ghost";
    save.onclick = () => {
      const note = ta.value.trim(); const suggestion = repl.value.trim();
      closeFloat();
      if (VERDICTS[verdict].needsDetail && !note && !suggestion) return; // revise/reject/question need detail
      notesHidden = false;
      annotations.push({ id: annotId(), quote, note, suggestion: suggestion || null, verdict, line: view.state.doc.lineAt(sel.from).number, resolved: false, ts: Date.now() });
      persistAnnotations(); refreshAnnotRanges(); flashMessage("Directive added — the agent reads it via MCP");
    };
    cancel.onclick = closeFloat;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
      if (e.key === "Escape") { e.preventDefault(); closeFloat(); }
    });
    bar.append(save, cancel); box.append(picker, ta, repl, bar); ta.focus();
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
let isTranscript = false; // jsonl that looks like a Claude Code chat log

function isRenderMode() { return RENDER_MODES.has(currentMode); }

// Toggle label adapts: transcripts flip Conversation/Raw, other render modes Rendered/Source.
function setToggleLabel() {
  viewToggle.textContent = isTranscript
    ? (showSource ? "Conversation" : "Raw")
    : (showSource ? "Rendered" : "Source");
}

function updateHosts() {
  const render = isRenderMode();
  viewToggle.classList.toggle("hidden", !render);
  setToggleLabel();
  const showRendered = render && !showSource;
  editorHost.classList.toggle("hidden", showRendered);
  renderHost.classList.toggle("hidden", !showRendered);
}

function renderCurrent() {
  if (!isRenderMode()) return;
  const text = view.state.doc.toString();
  renderHost.innerHTML = "";
  isTranscript = currentMode === "jsonl" && looksLikeTranscript(text);
  const body = document.createElement("div");
  body.className = "render-body mode-" + (isTranscript ? "conversation" : currentMode);
  renderHost.appendChild(body);
  if (currentMode === "jsonl") {
    if (isTranscript) renderConversation(body, text);
    else renderJsonl(body, text);
    setToggleLabel();
  }
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

function applyMode(filePath, content) {
  // No path = an untitled scratch buffer, which is always markdown
  // (modeForPath("") would say "code").
  let mode = filePath ? modeForPath(filePath) : "markdown";
  // Gemini sessions are .json (→ code mode); route transcript content to the
  // conversation view like Claude/Codex .jsonl.
  if (mode === "code" && content && looksLikeTranscript(content)) mode = "jsonl";
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
  // Markdown-only chrome: hide the Share menu + toolbar + selection bubble + slash menu in code/data modes.
  const tools = document.getElementById("titlebar-tools");
  if (tools) tools.style.display = mode === "markdown" ? "" : "none";
  updateToolbarVisibility();
  const sb = document.getElementById("selbar");
  closeSlash();
  if (mode !== "markdown") {
    outlineEl.classList.add("hidden");
    if (sb) sb.classList.add("hidden");
  }
  if (typeof refreshRail === "function") refreshRail();
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
/* ---------- Export runtime enablement (pkg-dev contract, PR #2) ----------
   docx export + Google publish run through a Node sidecar. For external users
   without Node, pkg-dev bundles a one-time managed download; the renderer owns
   the prompt + progress UI. Every bridge call is optional-chained, so until
   pkg-dev's branch lands this is byte-identical to the old behavior. PDF/HTML
   export is native and must never enter this path. */
let nodeInstallBannerUp = false;
window.plume.onNodeInstallProgress?.((p) => {
  if (p.phase === "done") {
    if (nodeInstallBannerUp) { nodeInstallBannerUp = false; clearBanner(); }
    return;
  }
  nodeInstallBannerUp = true;
  const mb = (n) => Math.max(1, Math.round(n / 1048576));
  bannerEl.className = "";
  bannerEl.textContent =
    p.phase === "download"
      ? (p.total ? `Downloading export helper… ${mb(p.received)} MB of ${mb(p.total)} MB` : "Downloading export helper…")
      : p.phase === "verify" ? "Verifying export helper…"
      : "Setting up export helper…";
});
// True when docx/publish can proceed. Prompts for (and runs) the one-time
// download when the helper is missing; call BEFORE any save dialog.
async function ensureExportRuntime() {
  if (!window.plume.nodeStatus) return true; // contract not landed → old behavior
  const st = await window.plume.nodeStatus().catch(() => null);
  if (!st || st.available) return true;
  const choice = await askConfirm({
    message: "Enable export?",
    detail: "Exporting to Word and publishing to Google Docs uses a small helper that needs a one-time ~40 MB download.",
    buttons: [
      { label: "Download & Enable", kind: "primary", value: "enable" },
      { label: "Cancel", kind: "ghost", value: "cancel" },
    ],
  });
  if (choice !== "enable") return false;
  const r = await window.plume.installNode().catch((e) => ({ ok: false, error: String(e) }));
  nodeInstallBannerUp = false;
  clearBanner();
  if (r?.ok) return true;
  flashMessage(
    r?.code === "IN_PROGRESS"
      ? "The export helper is already downloading — try again in a moment."
      : "Couldn't enable export: " + (r?.error || "download failed") + " — check your connection and try again."
  );
  return false;
}

async function exportAs(format) {
  if (format === "docx" && !(await ensureExportRuntime())) return;
  const html = fullHtmlDocument(mdToHtml(view.state.doc.toString()), docBaseName());
  const result = await window.plume.exportDoc(format, html, docBaseName());
  if (result?.ok && result.path) {
    flashMessage("Exported " + result.path.split("/").pop());
  } else if (result && !result.ok && !result.cancelled) {
    // F2: a failed export must say so — silence reads as "nothing happened".
    flashMessage("Export failed: " + (result.error || "unknown error"));
  }
}
async function publishGoogle(retried = false) {
  if (currentMode !== "markdown") { flashMessage("Publish to Google Docs works on Markdown documents."); return; }
  if (!(await ensureExportRuntime())) return;
  flashMessage("Publishing to Google Docs…");
  const r = await window.plume.publishGoogle(view.state.doc.toString(), docBaseName());
  // Belt-and-braces: raced past the status check and the sidecar was missing —
  // run the enable flow once, then retry the publish.
  if (!retried && r && r.ok === false && r.code === "NODE_MISSING") {
    if (await ensureExportRuntime()) return publishGoogle(true);
    return;
  }
  if (r?.ok) {
    flashMessage("Published — opening the Google Doc…");
  } else if (r?.code === "NO_CREDS") {
    flashMessage("Google publish needs a one-time OAuth client (~/.plume/google.json) — see docs/agent-setup.md.");
  } else if (r?.code === "OAUTH_TIMEOUT" || r?.code === "OAUTH_DENIED") {
    flashMessage("Google sign-in wasn't completed — publish cancelled. Try again when ready.");
  } else {
    // F2: covers helper crashes (r.error carries the reason) and null results.
    flashMessage("Publish failed: " + (r?.error || "no response from the export helper"));
  }
}

/* ---------- File I/O ---------- */
function loadDocument(content, filePath, recovery, gotoLine) {
  // Tab switch in flight? A captured (possibly dirty) buffer for this exact
  // path is restored on top of the disk content loaded below.
  const restore = pendingTabRestore && pendingTabRestore.path === filePath ? pendingTabRestore : null;
  if (restore) pendingTabRestore = null;
  applyMode(filePath, content);
  savedText = content;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
    selection: { anchor: 0 },
  });
  setDocPath(view, filePath);
  setTitle(filePath);
  if (filePath) recordRecent(filePath);
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
  if (restore) {
    // Unsaved edits from when this tab was backgrounded win over disk content;
    // savedText stays the disk content, so the dirty flag recomputes correctly.
    if (restore.text != null && restore.text !== content) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: restore.text } });
    }
    const len = view.state.doc.length;
    const anchor = Math.min(restore.sel?.anchor ?? 0, len);
    const head = Math.min(restore.sel?.head ?? anchor, len);
    view.dispatch({ selection: { anchor, head } });
    view.scrollDOM.scrollTop = restore.scrollTop || 0;
  }
  // Keep the active tab's record pointing at what this window now shows
  // (in-place navigation from the sidebar retargets the current tab).
  const at = findTab(tabs, activeTabId);
  if (at) { at.path = filePath || null; at.pendingName = null; at.text = null; at.savedText = null; at.unbound = false; }
  renderTabbar();
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

/* ---------- Prose-diff review (review the agent's revision) ---------- */
// When the agent revises a doc that still has open directives, don't silently
// reload — show the change as accept/reject hunks, each linked to the directive
// whose passage it touches. Only accepted hunks get written back to disk.
let reviewState = null;
const reviewEl = (() => {
  const el = document.createElement("div");
  el.id = "review"; el.className = "review-overlay hidden";
  document.body.appendChild(el);
  return el;
})();

function directivesForHunk(hunk) {
  const delText = hunk.del.join("\n");
  return annotations.filter((a) => !a.resolved && a.quote && delText.includes(a.quote));
}

function openDiffReview(before, after) {
  const segs = computeSegments(before, after);
  if (hunkCount(segs) === 0) { applyExternalChange(after); return; }
  const accepted = new Set(segs.filter((s) => s.type === "hunk").map((s) => s.id));
  reviewState = { segs, accepted, before, after };
  renderReview();
}

function renderReview() {
  if (!reviewState) { reviewEl.classList.add("hidden"); return; }
  const { segs, accepted } = reviewState;
  const hunks = segs.filter((s) => s.type === "hunk");
  const addressed = hunks.filter((h) => directivesForHunk(h).length > 0).length;
  reviewEl.classList.remove("hidden");
  reviewEl.innerHTML = "";

  const head = document.createElement("div"); head.className = "review-head";
  const titles = document.createElement("div"); titles.className = "review-titles";
  const t = document.createElement("div"); t.className = "review-title";
  t.textContent = `Review revision · ${hunks.length} change${hunks.length === 1 ? "" : "s"}`;
  const sub = document.createElement("div"); sub.className = "review-sub";
  sub.textContent = addressed ? `${addressed} address your directives` : "no open directives touched";
  titles.append(t, sub);
  const acts = document.createElement("div"); acts.className = "review-acts";
  const mk = (label, cls, fn) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; };
  acts.append(
    mk("Reject all", "ghost", () => { accepted.clear(); renderReview(); }),
    mk("Accept all", "ghost", () => { hunks.forEach((h) => accepted.add(h.id)); renderReview(); }),
    mk(`Apply (${accepted.size} accepted)`, "primary", commitReview),
  );
  head.append(titles, acts);
  reviewEl.appendChild(head);

  const body = document.createElement("div"); body.className = "review-body";
  for (const h of hunks) {
    const card = document.createElement("div");
    const on = accepted.has(h.id);
    card.className = "review-hunk" + (on ? " accepted" : " rejected");
    const bar = document.createElement("div"); bar.className = "review-hunk-bar";
    const toggle = document.createElement("button");
    toggle.className = "review-toggle"; toggle.textContent = on ? "✓ Accept" : "✕ Reject";
    toggle.onclick = () => { if (accepted.has(h.id)) accepted.delete(h.id); else accepted.add(h.id); renderReview(); };
    bar.appendChild(toggle);
    for (const d of directivesForHunk(h)) {
      const chip = document.createElement("span");
      const vk = verdictOf(d);
      chip.className = "verdict-chip v-" + vk + " mini";
      // d.note is user-typed — build with textContent so it can't inject markup.
      const cg = document.createElement("span"); cg.className = "vg"; cg.textContent = VERDICTS[vk].glyph;
      chip.appendChild(cg);
      chip.appendChild(document.createTextNode((d.note || VERDICTS[vk].label).slice(0, 48)));
      bar.appendChild(chip);
    }
    card.appendChild(bar);
    // A couple of unchanged context lines on each side so the change is placeable.
    const si = segs.indexOf(h);
    const prevEq = si > 0 && segs[si - 1].type === "eq" ? segs[si - 1].lines.slice(-2) : [];
    const nextEq = si < segs.length - 1 && segs[si + 1].type === "eq" ? segs[si + 1].lines.slice(0, 2) : [];
    const pre = document.createElement("pre"); pre.className = "review-diff";
    const addLine = (cls, prefix, l) => { const r = document.createElement("div"); r.className = "dl " + cls; r.textContent = prefix + l; pre.appendChild(r); };
    for (const l of prevEq) addLine("ctx", "  ", l);
    for (const l of h.del) addLine("del", "− ", l);
    for (const l of h.add) addLine("add", "+ ", l);
    for (const l of nextEq) addLine("ctx", "  ", l);
    card.appendChild(pre);
    body.appendChild(card);
  }
  reviewEl.appendChild(body);
}

async function commitReview() {
  if (!reviewState) return;
  const { segs, accepted } = reviewState;
  const merged = applySegments(segs, accepted);
  // Mark directives the agent addressed AND you accepted as resolved.
  for (const h of segs.filter((s) => s.type === "hunk" && accepted.has(s.id)))
    for (const d of directivesForHunk(h)) d.resolved = true;
  reviewState = null;
  reviewEl.classList.add("hidden"); reviewEl.innerHTML = "";
  setDoc(merged);
  savedText = merged; // so our own write-back doesn't re-trigger a review
  if (currentPath) await window.plume.save(currentPath, merged);
  setDirty(false);
  persistAnnotations(); refreshAnnotRanges();
  if (isRenderMode() && !showSource) renderCurrent();
  flashMessage("Revision applied");
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
  // No path (untitled) or a dropped binding (file moved/deleted) → Save As so
  // the user picks the destination; a stale path must never be written blindly.
  const t = activeTab();
  // No path, dropped binding, or a DRAFT (⌘S on a draft = graduation: native
  // writes the current buffer to the chosen path, deletes the Autosave source,
  // rebinds) → route through Save As.
  if (!currentPath || (t && t.unbound) || isDraft(t)) {
    const saved = await saveAs();
    if (saved && thenClose) window.close();
    return;
  }
  const content = view.state.doc.toString();
  const result = await window.plume.save(currentPath, content);
  if (result) {
    savedText = content;
    setTitle(result);
    setDirty(false);
    if (thenClose) window.close();
    return;
  }
  // Native refused the write (binding raced/dropped — write_file only accepts
  // this window's bound path) or the disk write failed. Never drop edits
  // silently: mark the tab unbound and route through Save As (contract rule).
  if (t) t.unbound = true;
  const saved = await saveAs();
  if (saved && thenClose) window.close();
}

async function saveAs() {
  const content = view.state.doc.toString();
  const result = await window.plume.saveAs(content); // native writes AND rebinds atomically
  if (result) {
    savedText = content;
    const t = activeTab();
    if (t) { t.path = result; t.unbound = false; }
    setTitle(result);
    setDocPath(view, result); // relative links/images resolve against the NEW location (Codex P2)
    setDirty(false);
    pushOpenPaths();
  }
  return result;
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
  refreshRail();
}

/* ---------- Theme ---------- */
function applyTheme(theme) {
  appEl.dataset.theme = theme;
  // Also theme <html> so the palette vars (--bg, --text) cascade to html/body —
  // otherwise body's background is transparent and the window bg bleeds through.
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("plume-theme", theme);
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  setMermaidTheme(dark ? "dark" : "default");
  view.dispatch({ effects: refreshEffect.of(null) });
}
applyTheme(localStorage.getItem("plume-theme") || "system");

// Wide mode — full-width content (for tables / wide docs); off keeps the
// readable prose measure. Toggled from Settings or the command palette.
function applyWide(on) {
  document.documentElement.dataset.wide = on ? "1" : "0";
  localStorage.setItem("plume-wide", on ? "1" : "0");
}
applyWide(localStorage.getItem("plume-wide") === "1");

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

// Named line-prefix toggles — shared by the toolbar, native Format menu
// (menu:list / menu:block), slash menu, and the selection bubble's block menu.
function toggleBulletList() { toggleLinePrefix(/^\s*[-*+] /, () => "- "); }
function toggleOrderedList() { toggleLinePrefix(/^\s*\d+\. /, (i) => `${i + 1}. `); }
function toggleTaskList() { toggleLinePrefix(/^\s*[-*+] \[[ xX]\] /, () => "- [ ] "); }
function toggleQuote() { toggleLinePrefix(/^> ?/, () => "> "); }

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
// Inline-format glyphs (Phosphor Bold, 18px) used by the contextual selection bubble.
const ICONS = {
  bold: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M185.08,114.46A48,48,0,0,0,148,36H80A12,12,0,0,0,68,48V200a12,12,0,0,0,12,12h80a52,52,0,0,0,25.08-97.54ZM92,60h56a24,24,0,0,1,0,48H92Zm68,128H92V132h68a28,28,0,0,1,0,56Z\"/></svg>",
  italic: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M204,56a12,12,0,0,1-12,12H160.65l-40,120H144a12,12,0,0,1,0,24H64a12,12,0,0,1,0-24H95.35l40-120H112a12,12,0,0,1,0-24h80A12,12,0,0,1,204,56Z\"/></svg>",
  strike: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M228,128a12,12,0,0,1-12,12H185.86A41.48,41.48,0,0,1,196,168c0,14.45-7.81,28.32-21.43,38.05C162,215.05,145.44,220,128,220s-34-4.95-46.57-13.95C67.81,196.32,60,182.45,60,168a12,12,0,0,1,24,0c0,15.18,20.15,28,44,28s44-12.82,44-28c0-12.76-9.3-20.18-35.35-28H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128ZM75.11,100a12,12,0,0,0,12-12c0-16,17.58-28,40.89-28,17.36,0,31.37,6.65,37.48,17.78a12,12,0,0,0,21-11.56C176.13,47.3,154.25,36,128,36,91,36,63.11,58.35,63.11,88A12,12,0,0,0,75.11,100Z\"/></svg>",
  code: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M71.68,97.22,34.74,128l36.94,30.78a12,12,0,1,1-15.36,18.44l-48-40a12,12,0,0,1,0-18.44l48-40A12,12,0,0,1,71.68,97.22Zm176,21.56-48-40a12,12,0,1,0-15.36,18.44L221.26,128l-36.94,30.78a12,12,0,1,0,15.36,18.44l48-40a12,12,0,0,0,0-18.44ZM164.1,28.72a12,12,0,0,0-15.38,7.18l-64,176a12,12,0,0,0,7.18,15.37A11.79,11.79,0,0,0,96,228a12,12,0,0,0,11.28-7.9l64-176A12,12,0,0,0,164.1,28.72Z\"/></svg>",
  link: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 256 256\" fill=\"currentColor\"><path d=\"M117.18,188.74a12,12,0,0,1,0,17l-5.12,5.12A58.26,58.26,0,0,1,70.6,228h0A58.62,58.62,0,0,1,29.14,127.92L63.89,93.17a58.64,58.64,0,0,1,98.56,28.11,12,12,0,1,1-23.37,5.44,34.65,34.65,0,0,0-58.22-16.58L46.11,144.89A34.62,34.62,0,0,0,70.57,204h0a34.41,34.41,0,0,0,24.49-10.14l5.11-5.12A12,12,0,0,1,117.18,188.74ZM226.83,45.17a58.65,58.65,0,0,0-82.93,0l-5.11,5.11a12,12,0,0,0,17,17l5.12-5.12a34.63,34.63,0,1,1,49,49L175.1,145.86A34.39,34.39,0,0,1,150.61,156h0a34.63,34.63,0,0,1-33.69-26.72,12,12,0,0,0-23.38,5.44A58.64,58.64,0,0,0,150.56,180h.05a58.28,58.28,0,0,0,41.47-17.17l34.75-34.75a58.62,58.62,0,0,0,0-82.91Z\"/></svg>",
};
const CHEV_TT = '<svg class="tt-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';
// "Turn into" block-type glyph (Phosphor heading) for the selection bubble.
const BLOCK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M212,56V200a12,12,0,0,1-24,0V140H68v60a12,12,0,0,1-24,0V56a12,12,0,0,1,24,0v60H188V56a12,12,0,0,1,24,0Z"/></svg>';

// Inline formatting — surfaced contextually in the selection bubble.
const INLINE_FORMATS = [
  { t: "Bold  ⌘B", svg: "bold", fn: () => applyFormat("bold") },
  { t: "Italic  ⌘I", svg: "italic", fn: () => applyFormat("italic") },
  { t: "Strikethrough  ⌘⇧X", svg: "strike", fn: () => applyFormat("strike") },
  { t: "Inline code  ⌘E", svg: "code", fn: () => applyFormat("code") },
  { t: "Link  ⌘K", svg: "link", fn: () => applyFormat("link") },
];

/* ---------- Persistent formatting toolbar (#3 — visible chrome) ---------- */
// A non-Markdown user must be able to format without knowing any syntax. The
// contextual selection bubble still exists; this row is the always-visible
// entry point. Markdown mode only; toggleable (View menu / Settings / palette),
// on by default.
const toolbarEl = document.getElementById("toolbar");
function toolbarEnabled() { return localStorage.getItem("plume-toolbar") !== "0"; }
function applyToolbarSetting(on) {
  localStorage.setItem("plume-toolbar", on ? "1" : "0");
  updateToolbarVisibility();
}
function updateToolbarVisibility() {
  toolbarEl.classList.toggle("hidden", !(currentMode === "markdown" && toolbarEnabled()));
}
function buildToolbar() {
  toolbarEl.innerHTML = "";
  const btn = (title, html, fn, { menu = false, stroke = false } = {}) => {
    const b = document.createElement("button");
    b.className = "tb-btn tb-item" + (menu ? " has-menu" : "") + (stroke ? " tb-stroke" : "");
    b.title = title;
    b.setAttribute("aria-label", title.replace(/\s+[⌘⇧⌃].*$/u, ""));
    b.innerHTML = html + (menu ? CHEV_TT : "");
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor selection/focus
    b.addEventListener("click", () => fn(b));
    toolbarEl.appendChild(b);
    return b;
  };
  const sep = () => { const s = document.createElement("div"); s.className = "sel-div"; toolbarEl.appendChild(s); };

  btn("Turn into…  (heading, list, quote, code)", BLOCK_ICON, (b) => openMenu(b, blockMenuItems()), { menu: true });
  sep();
  for (const f of INLINE_FORMATS) btn(f.t, ICONS[f.svg], f.fn);
  sep();
  btn("Bullet list  ⌘⇧8", SLASH_ICONS.bullet, toggleBulletList, { stroke: true });
  btn("Numbered list  ⌘⇧7", SLASH_ICONS.numbered, toggleOrderedList, { stroke: true });
  btn("To-do list", SLASH_ICONS.todo, toggleTaskList, { stroke: true });
  sep();
  btn("Quote", SLASH_ICONS.quote, toggleQuote, { stroke: true });
  btn("Code block", SLASH_ICONS.code, insertCodeBlock, { stroke: true });
  btn("Table", SLASH_ICONS.table, insertTable, { stroke: true });
  btn("Divider (horizontal rule)", SLASH_ICONS.hr, insertHR, { stroke: true });
  btn("Insert image…", SLASH_ICONS.image, insertImageViaPicker, { stroke: true });
  updateToolbarVisibility();
}

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

/* ---------- Title bar: brand (left) + Share (right) ---------- */
const BRAND_FEATHER = '<svg viewBox="0 0 18 18"><path d="M14.5 3.5a5.5 5.5 0 0 0-7.8 7.8L4.5 13.5v1.5h1.5l2.2-2.2A5.5 5.5 0 0 0 14.5 3.5z"/><path d="M11.5 6.5 6 12"/></svg>';
const SHARE_ICON = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v9"/><path d="M5.5 5.5 9 2l3.5 3.5"/><path d="M4 11v3.5A1.5 1.5 0 0 0 5.5 16h7a1.5 1.5 0 0 0 1.5-1.5V11"/></svg>';

function buildBrand() {
  const el = document.getElementById("titlebar-brand");
  if (!el) return;
  el.innerHTML = `<span class="brand-mark">${BRAND_FEATHER}</span><span class="brand-name">Plume</span>`;
}
function buildTitlebarTools() {
  const host = document.getElementById("titlebar-tools");
  if (!host) return;
  host.innerHTML = "";
  const share = document.createElement("button");
  share.className = "tt-btn has-menu";
  share.title = "Share — copy, export, publish";
  share.setAttribute("aria-label", "Share");
  share.innerHTML = SHARE_ICON + CHEV_TT;
  share.addEventListener("click", () => openMenu(share, shareMenuItems()));
  host.appendChild(share);
}

/* ---------- Left rail: the app's surfaces ---------- */
const RAIL_ICONS = {
  feather: '<svg viewBox="0 0 22 22"><path d="M17.5 4.5a6.5 6.5 0 0 0-9.2 9.2L5.5 16.5v2h2l2.8-2.8a6.5 6.5 0 0 0 7.2-11.2z"/><path d="M14 7 7.5 13.5"/></svg>',
  files: '<svg viewBox="0 0 22 22"><path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h3.5l1.8 2.2H17A1.5 1.5 0 0 1 18.5 8.7v7.3A1.5 1.5 0 0 1 17 17.5H5A1.5 1.5 0 0 1 3.5 16z"/></svg>',
  sessions: '<svg viewBox="0 0 22 22"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h11A1.5 1.5 0 0 1 18 6.5v6A1.5 1.5 0 0 1 16.5 14H9l-3.5 3.2V14H5.5A1.5 1.5 0 0 1 4 12.5z"/><path d="M7.5 8.2h7M7.5 11h4.5"/></svg>',
  outline: '<svg viewBox="0 0 22 22"><path d="M6 6h11M6 11h11M6 16h7"/><circle cx="3.4" cy="6" r="1.1" style="fill:currentColor;stroke:none"/><circle cx="3.4" cy="11" r="1.1" style="fill:currentColor;stroke:none"/><circle cx="3.4" cy="16" r="1.1" style="fill:currentColor;stroke:none"/></svg>',
  search: '<svg viewBox="0 0 22 22"><circle cx="10" cy="10" r="5"/><path d="M17.5 17.5 13.6 13.6"/></svg>',
  settings: '<svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="2.6"/><path d="M11 3.5v2M11 16.5v2M3.5 11h2M16.5 11h2M5.7 5.7l1.4 1.4M14.9 14.9l1.4 1.4M16.3 5.7l-1.4 1.4M7.1 14.9l-1.4 1.4"/></svg>',
};
const RAIL = [
  { icon: "feather", t: "Command palette  ⌘P", brand: true, fn: () => openPalette() },
  { icon: "files", t: "Files  ⌘⇧E", id: "files", fn: () => toggleSidebar() },
  { icon: "sessions", t: "Sessions & context  ⌘⇧P", fn: () => openWorkspace() },
  { icon: "outline", t: "Outline  ⌘⇧O", id: "outline", fn: () => toggleOutline() },
  { icon: "search", t: "Search in folder  ⌘⇧F", fn: () => openSearch() },
  { icon: "settings", t: "Settings — appearance & fonts", bottom: true, fn: (el) => openMenu(el, settingsMenuItems()) },
];
function buildRail() {
  const host = document.getElementById("rail");
  if (!host) return;
  host.innerHTML = "";
  for (const r of RAIL) {
    const btn = document.createElement("button");
    btn.className = "rail-item" + (r.brand ? " brand" : "") + (r.bottom ? " bottom" : "");
    btn.title = r.t;
    btn.setAttribute("aria-label", r.t);
    if (r.id) btn.dataset.rail = r.id;
    btn.innerHTML = RAIL_ICONS[r.icon];
    btn.addEventListener("click", () => r.fn(btn));
    host.appendChild(btn);
  }
  refreshRail();
}
function refreshRail() {
  const host = document.getElementById("rail");
  if (!host) return;
  const f = host.querySelector('[data-rail="files"]');
  if (f) f.classList.toggle("on", !sidebarEl.classList.contains("hidden"));
  const o = host.querySelector('[data-rail="outline"]');
  if (o) o.classList.toggle("on", !outlineEl.classList.contains("hidden"));
}

/* ---------- Contextual selection bubble (inline formatting) ---------- */
const selbar = document.getElementById("selbar");
// "Turn into" — block-type transforms for the line(s) under the selection.
function blockMenuItems() {
  const line = view.state.doc.lineAt(view.state.selection.main.head).text;
  const hLvl = (line.match(/^(#{1,6}) /) || [])[1]?.length || 0;
  const isList = /^\s*([-*+] |\d+\. |> )/.test(line);
  return [
    { label: "Title", fn: () => setHeading(1), checked: hLvl === 1 },
    { label: "Heading", fn: () => setHeading(2), checked: hLvl === 2 },
    { label: "Subheading", fn: () => setHeading(3), checked: hLvl === 3 },
    { label: "Body text", fn: () => setHeading(0), checked: hLvl === 0 && !isList },
    { sep: true },
    { label: "Bullet list", fn: toggleBulletList, checked: /^\s*[-*+] /.test(line) && !/^\s*[-*+] \[[ xX]\] /.test(line) },
    { label: "Numbered list", fn: toggleOrderedList, checked: /^\s*\d+\. /.test(line) },
    { label: "To-do list", fn: toggleTaskList, checked: /^\s*[-*+] \[[ xX]\] /.test(line) },
    { label: "Quote", fn: toggleQuote, checked: /^\s*> /.test(line) },
    { sep: true },
    { label: "Code block", fn: insertCodeBlock },
  ];
}
// Comment bubble (Phosphor ChatTeardropDots) for the "leave a steering note" action.
const NOTE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200ZM84,140a12,12,0,1,1,12-12A12,12,0,0,1,84,140Zm48,0a12,12,0,1,1,12-12A12,12,0,0,1,132,140Zm48,0a12,12,0,1,1,12-12A12,12,0,0,1,180,140Z"/></svg>';
function buildSelBar() {
  selbar.innerHTML = "";
  // Lead with the block-type ("turn into") menu, then a divider, then inline formats.
  const blockBtn = document.createElement("button");
  blockBtn.className = "sel-btn sel-block has-menu";
  blockBtn.title = "Turn into…  (heading, list, quote, code)";
  blockBtn.setAttribute("aria-label", "Turn into");
  blockBtn.innerHTML = BLOCK_ICON + CHEV_TT;
  blockBtn.addEventListener("mousedown", (e) => e.preventDefault());
  blockBtn.addEventListener("click", () => openMenu(blockBtn, blockMenuItems()));
  selbar.appendChild(blockBtn);
  const div = document.createElement("div");
  div.className = "sel-div";
  selbar.appendChild(div);
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
  // Steering note — the entry point into the agent directive loop (also ⌘J).
  const div2 = document.createElement("div");
  div2.className = "sel-div";
  selbar.appendChild(div2);
  const noteBtn = document.createElement("button");
  noteBtn.className = "sel-btn";
  noteBtn.title = "Add note for the agent  (⌘J)";
  noteBtn.setAttribute("aria-label", "Add note for the agent");
  noteBtn.innerHTML = NOTE_ICON;
  noteBtn.addEventListener("mousedown", (e) => e.preventDefault());
  noteBtn.addEventListener("click", () => addAnnotation());
  selbar.appendChild(noteBtn);
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

/* ---------- Dropdown menus (Share / Settings) ---------- */
let openMenuEl = null;
function closeToolbarMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
document.addEventListener("mousedown", (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest(".has-menu, .rail-item")) closeToolbarMenu();
});
async function pushToAgent() {
  const content = view.state.doc.toString();
  if (!content.trim()) { flashMessage("Nothing to push — the document is empty."); return; }
  const name = currentPath ? currentPath.split("/").pop() : (pendingName ? pendingName + ".md" : "Untitled.md");
  const targets = (await window.plume.listSessionTargets()) || [];
  if (!targets.length) { flashMessage("No Claude Code sessions found to push to."); return; }
  const doPush = async (t) => {
    const r = await window.plume.pushToAgent(t.key, name, content);
    flashMessage(r ? `Pushed “${r}” to ${t.label} — tell that agent “read what I pushed”.` : "Push to agent failed.");
  };
  if (targets.length === 1) { return doPush(targets[0]); } // one project → no need to ask
  // Multiple projects → pick the target thread (most-recently-active first).
  openMenu(document.getElementById("titlebar-tools"), targets.map((t) => ({
    label: `${t.label}${t.title ? " · " + String(t.title).slice(0, 38) : ""}`,
    fn: () => doPush(t),
  })));
}
function shareMenuItems() {
  return [
    { label: "Push to agent", fn: () => pushToAgent() },
    { sep: true },
    { label: "Copy as rich text", fn: copyAsRichText },
    { label: "Copy as HTML", fn: copyAsHtml },
    { sep: true },
    { label: "Export to PDF…", fn: () => exportAs("pdf") },
    { label: "Export to HTML…", fn: () => exportAs("html") },
    { label: "Export to Word (.docx)…", fn: () => exportAs("docx") },
    { sep: true },
    { label: "Publish to Google Docs…", fn: () => publishGoogle() },
  ];
}
function applyAutosave(on) { localStorage.setItem("plume-autosave", on ? "1" : "0"); }
function settingsMenuItems() {
  const theme = localStorage.getItem("plume-theme") || "system";
  const reveal = localStorage.getItem("plume-reveal") === "1";
  const focus = localStorage.getItem("plume-focus") === "1";
  const curFont = localStorage.getItem("plume-font") || "inter";
  const autosaveOn = localStorage.getItem("plume-autosave") !== "0";
  const wide = localStorage.getItem("plume-wide") === "1";
  return [
    { label: "Appearance: System", fn: () => applyTheme("system"), checked: theme === "system" },
    { label: "Appearance: Light", fn: () => applyTheme("light"), checked: theme === "light" },
    { label: "Appearance: Dark", fn: () => applyTheme("dark"), checked: theme === "dark" },
    { sep: true },
    { label: "Formatting toolbar", fn: () => applyToolbarSetting(!toolbarEnabled()), checked: toolbarEnabled() },
    { label: "Wide mode (full width — for tables)", fn: () => applyWide(!wide), checked: wide },
    // Autosave covers open (saved) documents only — new/untitled docs are never
    // silently placed on disk; they prompt on close instead (owner decision).
    { label: "Autosave open documents", fn: () => applyAutosave(!autosaveOn), checked: autosaveOn },
    { sep: true },
    { label: "Reveal markdown marks", fn: () => applyReveal(!reveal), checked: reveal },
    { label: "Focus mode", fn: () => applyFocus(!focus), checked: focus },
    { sep: true },
    ...FONTS.map((f) => ({ label: `Font · ${f.label}`, fn: () => applyFont(f.id), checked: f.id === curFont })),
  ];
}
function openMenu(anchor, items) {
  if (openMenuEl) { closeToolbarMenu(); return; }
  const menu = document.createElement("div");
  menu.className = "tb-menu";
  for (const it of items) {
    if (it.sep) { const s = document.createElement("div"); s.className = "tb-menu-sep"; menu.appendChild(s); continue; }
    const row = document.createElement("button");
    row.className = "tb-menu-item" + (it.checked ? " checked" : "");
    // textContent, not innerHTML: it.label can carry untrusted text (e.g. a session
    // title derived from a transcript), and event-handler attributes like onerror=
    // are NOT blocked by the CSP. Build the row as text nodes.
    const check = document.createElement("span"); check.className = "tbm-check"; check.textContent = it.checked ? "✓" : "";
    const label = document.createElement("span"); label.textContent = it.label;
    row.append(check, label);
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => { closeToolbarMenu(); it.fn(); view.focus(); });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  // Rail menus open to the right of the rail; title-bar menus drop straight down.
  let left = anchor.classList.contains("rail-item") ? r.right + 6 : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 10));
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  openMenuEl = menu;
}

/* ---------- Slash command menu ('/' to insert blocks + companion actions) ---------- */
const SLASH_ICONS = {
  heading: '<svg viewBox="0 0 18 18"><path d="M3.5 5h5" stroke-width="2.4"/><path d="M3.5 9.3h11"/><path d="M3.5 13h8"/></svg>',
  bullet: '<svg viewBox="0 0 18 18"><circle cx="3.5" cy="5" r="1.2" style="fill:currentColor;stroke:none"/><circle cx="3.5" cy="9" r="1.2" style="fill:currentColor;stroke:none"/><circle cx="3.5" cy="13" r="1.2" style="fill:currentColor;stroke:none"/><path d="M7.5 5h7M7.5 9h7M7.5 13h7"/></svg>',
  todo: '<svg viewBox="0 0 18 18"><rect x="3" y="3.5" width="12" height="11" rx="2.5"/><path d="M6 9l2 2 4.5-5"/></svg>',
  code: '<svg viewBox="0 0 18 18"><rect x="2.5" y="3.5" width="13" height="11" rx="2.5"/><path d="M7 7 5 9l2 2M11 7l2 2-2 2"/></svg>',
  table: '<svg viewBox="0 0 18 18"><rect x="2.5" y="3.5" width="13" height="11" rx="2"/><path d="M2.5 7.5h13M2.5 11h13M7.3 3.7v10.6M11.3 3.7v10.6"/></svg>',
  session: '<svg viewBox="0 0 18 18"><path d="M3.5 6A1.5 1.5 0 0 1 5 4.5h8A1.5 1.5 0 0 1 14.5 6v4.5A1.5 1.5 0 0 1 13 12H7l-2.5 2.4V12H5A1.5 1.5 0 0 1 3.5 10.5z"/></svg>',
  pdf: '<svg viewBox="0 0 18 18"><path d="M9 2.5v8"/><path d="M6 7.5 9 10.5l3-3"/><path d="M4 11v3A1.5 1.5 0 0 0 5.5 15.5h7A1.5 1.5 0 0 0 14 14v-3"/></svg>',
  gdocs: '<svg viewBox="0 0 18 18"><path d="M4.5 2.5h4.6L12.5 5.9V15a.6.6 0 0 1-.6.6H4.5a.6.6 0 0 1-.6-.6V3.1A.6.6 0 0 1 4.5 2.5z"/><path d="M9 2.7v3.4h3.4"/></svg>',
  numbered: '<svg viewBox="0 0 18 18"><path d="M7.5 5h7M7.5 9h7M7.5 13h7"/><path d="M2.7 3.8 3.9 3v3.4M2.8 8.1c.9-1 2.2-.4 1.9.6-.2.6-1 .9-2 1.8h2.2M2.7 11.9h1.4a.9.9 0 0 1 0 1.8h-.6a.9.9 0 0 1 .6 1.7H2.6" stroke-width="1.1"/></svg>',
  quote: '<svg viewBox="0 0 18 18"><path d="M3.5 3.5v11"/><path d="M7 6h7.5M7 9h7.5M7 12h5"/></svg>',
  hr: '<svg viewBox="0 0 18 18"><path d="M2.5 9h13"/><path d="M4.5 4.5h9M4.5 13.5h9" stroke-opacity="0.35"/></svg>',
  image: '<svg viewBox="0 0 18 18"><rect x="2.5" y="3.5" width="13" height="11" rx="2"/><circle cx="6.4" cy="7.2" r="1.2"/><path d="M4 13.2 8 9.5l2.6 2.4 2-1.8 1.9 1.9"/></svg>',
};
const SLASH = [
  { g: "Basic blocks", icon: "heading", b: "Heading", s: "Section title", kbd: "##", fn: () => setHeading(2) },
  { g: "Basic blocks", icon: "bullet", b: "Bullet list", s: "A simple list", kbd: "-", fn: () => toggleBulletList() },
  { g: "Basic blocks", icon: "todo", b: "To-do list", s: "Track tasks with checkboxes", fn: () => toggleTaskList() },
  { g: "Basic blocks", icon: "code", b: "Code block", s: "Fenced snippet", fn: () => insertCodeBlock() },
  { g: "Basic blocks", icon: "table", b: "Table", s: "Rows and columns", fn: () => insertTable() },
  { g: "Basic blocks", icon: "hr", b: "Divider", s: "Horizontal rule", kbd: "---", fn: () => insertHR() },
  { g: "Basic blocks", icon: "image", b: "Image", s: "Insert a picture from disk", fn: () => insertImageViaPicker() },
  { g: "Basic blocks", icon: "image", b: "Image alt text", s: "Edit the alt text (accessibility)", fn: () => editImageAlt() },
  { g: "Companion", icon: "session", b: "Insert from session…", s: "Pull text from a Claude Code transcript", fn: () => openSessionInsert() },
  { g: "Companion", icon: "pdf", b: "Export to PDF", s: "Render this document to a file", fn: () => exportAs("pdf") },
  { g: "Companion", icon: "gdocs", b: "Publish to Google Docs", s: "Share with non-devs", fn: () => publishGoogle() },
];
const slashEl = document.createElement("div");
slashEl.className = "slash hidden";
document.body.appendChild(slashEl);
let slashOpen = false, slashFrom = -1, slashRows = [], slashSel = 0;
function filterSlash(q) {
  const term = q.trim().toLowerCase();
  return SLASH.filter((x) => !term || (x.b + " " + (x.s || "")).toLowerCase().includes(term));
}
function openSlash(fromPos) { slashOpen = true; slashFrom = fromPos; slashSel = 0; renderSlash(""); positionSlash(); }
function closeSlash() { if (!slashOpen) return; slashOpen = false; slashEl.classList.add("hidden"); }
function renderSlash(q) {
  slashRows = filterSlash(q);
  if (slashSel >= slashRows.length) slashSel = Math.max(0, slashRows.length - 1);
  slashEl.classList.remove("hidden");
  slashEl.innerHTML = "";
  const field = document.createElement("div");
  field.className = "slash-field";
  field.innerHTML = `<span class="sf-q">/</span><span class="sf-hint">${q ? q.replace(/[<>&]/g, "") : "filter…"}</span>`;
  slashEl.appendChild(field);
  if (!slashRows.length) {
    const empty = document.createElement("div");
    empty.className = "slash-empty"; empty.textContent = "No matches";
    slashEl.appendChild(empty);
    return;
  }
  let lastGroup = null;
  slashRows.forEach((it, i) => {
    if (it.g !== lastGroup) {
      lastGroup = it.g;
      const h = document.createElement("div"); h.className = "slash-group"; h.textContent = it.g;
      slashEl.appendChild(h);
    }
    const row = document.createElement("div");
    row.className = "slash-item" + (i === slashSel ? " on" : "");
    row.dataset.i = i;
    row.innerHTML = `<span class="si-ic">${SLASH_ICONS[it.icon]}</span><span class="si-tx"><b>${it.b}</b><span>${it.s || ""}</span></span>${it.kbd ? `<span class="si-kbd">${it.kbd}</span>` : ""}`;
    row.addEventListener("mousedown", (e) => { e.preventDefault(); runSlash(i); });
    row.addEventListener("mouseenter", () => { slashSel = i; paintSlash(); });
    slashEl.appendChild(row);
  });
}
function paintSlash() {
  slashEl.querySelectorAll(".slash-item").forEach((el) => el.classList.toggle("on", Number(el.dataset.i) === slashSel));
}
function positionSlash() {
  const c = view.coordsAtPos(slashFrom);
  if (!c) { closeSlash(); return; }
  const w = slashEl.offsetWidth || 312;
  const left = Math.max(8, Math.min(c.left, window.innerWidth - w - 10));
  slashEl.style.left = left + "px";
  let top = c.bottom + 6;
  if (top + slashEl.offsetHeight > window.innerHeight - 8) top = Math.max(8, c.top - slashEl.offsetHeight - 6);
  slashEl.style.top = top + "px";
}
function runSlash(i) {
  const it = slashRows[i];
  if (!it) return;
  const head = view.state.selection.main.head;
  // Remove the typed "/query" before running the action.
  if (head >= slashFrom) view.dispatch({ changes: { from: slashFrom, to: head, insert: "" }, selection: { anchor: slashFrom } });
  closeSlash();
  it.fn();
  view.focus();
}
function handleSlash(u) {
  if (currentMode !== "markdown") { closeSlash(); return; }
  const head = view.state.selection.main.head;
  if (slashOpen) {
    if (!view.state.selection.main.empty || head < slashFrom + 1) { closeSlash(); return; }
    const q = view.state.doc.sliceString(slashFrom, head);
    if (!q.startsWith("/") || /\s/.test(q)) { closeSlash(); return; }
    renderSlash(q.slice(1));
    positionSlash();
    return;
  }
  if (!u.docChanged) return;
  let opened = false;
  u.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (opened || inserted.toString() !== "/" || toB !== head) return;
    const line = view.state.doc.lineAt(head);
    const before = view.state.doc.sliceString(line.from, head - 1);
    if (head - 1 === line.from || /\s$/.test(before)) { openSlash(head - 1); opened = true; }
  });
}
view.dom.addEventListener("keydown", (e) => {
  if (!slashOpen) return;
  // Capture-phase: swallow nav keys so CodeMirror doesn't also act on them.
  const stop = () => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  if (e.key === "ArrowDown") { stop(); slashSel = Math.min(slashSel + 1, slashRows.length - 1); paintSlash(); }
  else if (e.key === "ArrowUp") { stop(); slashSel = Math.max(slashSel - 1, 0); paintSlash(); }
  else if (e.key === "Enter") { stop(); runSlash(slashSel); }
  else if (e.key === "Escape") { stop(); closeSlash(); }
}, true);
document.addEventListener("mousedown", (e) => { if (slashOpen && !slashEl.contains(e.target)) closeSlash(); });

/* ---------- Insert from a Claude Code session ---------- */
function openSessionInsert() { wsInsertMode = true; openWorkspace(); }
async function insertSessionText(filePath) {
  const text = await window.plume.readSession(filePath);
  if (!text || !text.trim()) { flashMessage("Nothing readable to insert from that file."); return; }
  const r = view.state.selection.main;
  const pre = freshLinePrefix(r.from);
  const block = pre + text.trim() + "\n";
  view.dispatch({ changes: { from: r.from, to: r.to, insert: block }, selection: { anchor: r.from + block.length } });
  view.focus();
  flashMessage("Inserted from session — edit freely.");
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
buildBrand();
buildTitlebarTools();
buildToolbar();
buildSelBar();
view.scrollDOM.addEventListener("scroll", () => {
  if (!selbar.classList.contains("hidden")) updateSelBar();
  if (slashOpen) positionSlash();
});
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
  if (img) { e.preventDefault(); e.stopPropagation(); insertImageFile(img.getAsFile()); return; }
  // Rich paste (Notes / Word / Google Docs) → Markdown, in markdown mode only.
  if (currentMode !== "markdown") return;
  const html = e.clipboardData?.getData("text/html");
  // A copy made INSIDE Plume serializes the rendered editor DOM (table/code
  // widgets carrying our CSS vars + the contenteditable's transparent caret).
  // Re-converting that produces gray-backed, mangled output — so when we see
  // those signatures, fall through to CodeMirror's plain-text paste (the clean
  // Markdown source, which is also on the clipboard).
  if (html && /var\(--|caret-color/.test(html)) return;
  if (!html || !looksRich(html)) return; // let CodeMirror do its plain-text paste
  e.preventDefault(); e.stopPropagation();
  const r = view.state.selection.main;
  const insertMd = (md) => {
    if (!md) return;
    view.dispatch({ changes: { from: r.from, to: r.to, insert: md }, selection: { anchor: r.from + md.length }, scrollIntoView: true });
    view.focus();
  };
  const hasImg = /<img\b/i.test(html);
  if (hasImg && currentPath) {
    // Save embedded images to assets/ next to the doc, then convert (async).
    inlinePastedImages(html, window.plume.saveImage)
      .then((processed) => { try { insertMd(htmlToMarkdown(processed)); } catch {} })
      .catch(() => { try { insertMd(htmlToMarkdown(html)); } catch {} });
    return;
  }
  // No images, or unsaved doc (no assets/ folder to anchor) → text only.
  try { insertMd(htmlToMarkdown(html)); } catch { return; }
  if (hasImg && !currentPath) flashMessage("Pasted text — save the doc to keep pasted images.");
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
      row.onclick = () => openInCurrentTab(n.path);
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
function toggleSidebar() { sidebarEl.classList.toggle("hidden"); refreshSidebar(); refreshRail(); }

/* ---------- Command palette ---------- */
const paletteEl = document.getElementById("palette");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
let paletteFiles = [], paletteDrafts = [], paletteItems = [], paletteSel = 0;
/* ---------- Recent files (Open Recent) ---------- */
const RECENTS_KEY = "plume-recents";
const RECENTS_MAX = 15;
function loadRecents() {
  try { const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); return Array.isArray(v) ? v.filter((p) => typeof p === "string") : []; }
  catch { return []; }
}
function recordRecent(filePath) {
  const next = [filePath, ...loadRecents().filter((p) => p !== filePath)].slice(0, RECENTS_MAX);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch { /* private mode / quota */ }
  pushRecentsToMenu();
}
// Mirror recents into the native File > Open Recent menu (Tauri; no-op on Electron).
function pushRecentsToMenu() {
  if (window.plume.setRecentFiles) window.plume.setRecentFiles(loadRecents());
}
function clearRecents() {
  try { localStorage.removeItem(RECENTS_KEY); } catch { /* ignore */ }
  pushRecentsToMenu();
  updateWelcome();
}
// Open a document without clobbering the one you're reading: reuse THIS window
// if it's an empty/untitled scratch surface (e.g. the welcome screen);
// otherwise open a new TAB (#10 in-window switching). Used by recents / palette
// file-open / Open Recent menu / CLI + double-click opens routed to this window.
// (Sidebar stays in-place navigation; search/session keep their line jump.)
function smartOpen(path, line) {
  openInNewTab(path, line);
}
function recentItems(term) {
  return loadRecents()
    .filter((p) => p !== currentPath)
    .filter((p) => !term || fuzzy(term, p.split("/").pop()))
    .slice(0, 8)
    .map((p) => ({ kind: "recent", label: p.split("/").pop(), sub: p, run: () => smartOpen(p) }));
}

const COMMANDS = [
  { label: "New Tab", run: () => newTab() },
  { label: "Open in New Window", run: () => { if (currentPath) window.plume.openInNewWindow(currentPath); } },
  { label: "Toggle Formatting Toolbar", run: () => applyToolbarSetting(!toolbarEnabled()) },
  { label: "Toggle Files Sidebar", run: toggleSidebar },
  { label: "Toggle Outline", run: toggleOutline },
  { label: "Insert Divider (Horizontal Rule)", run: () => insertHR() },
  { label: "Insert Image…", run: () => insertImageViaPicker() },
  { label: "Edit Image Alt Text", run: () => editImageAlt() },
  { label: "Search in Folder", run: () => openSearch() },
  { label: "Claude Code Sessions & Context", run: () => openWorkspace() },
  { label: "Copy as Rich Text", run: copyAsRichText },
  { label: "Copy for Google Docs", run: copyForGoogleDocs },
  { label: "Export to PDF", run: () => exportAs("pdf") },
  { label: "Export to HTML", run: () => exportAs("html") },
  { label: "Export to Word (.docx)", run: () => exportAs("docx") },
  { label: "Publish to Google Docs", run: () => publishGoogle() },
  { label: "Push to agent", run: () => pushToAgent() },
  { label: "Format Document (JSON)", run: formatDocument },
  { label: "Appearance: Dark", run: () => applyTheme("dark") },
  { label: "Appearance: Light", run: () => applyTheme("light") },
  { label: "Appearance: System", run: () => applyTheme("system") },
  { label: "Reveal Markdown Marks While Editing", run: () => applyReveal(localStorage.getItem("plume-reveal") !== "1") },
  { label: "Toggle Focus Mode", run: () => applyFocus(localStorage.getItem("plume-focus") !== "1") },
  { label: "Toggle Wide Mode (full width)", run: () => applyWide(localStorage.getItem("plume-wide") !== "1") },
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
  const openPaths = new Set(tabs.map((t) => t.path).filter(Boolean));
  paletteDrafts = ((await window.plume.listDrafts?.()) || []).filter((d) => !openPaths.has(d.path));
  renderPalette("");
  paletteInput.focus();
}
function closePalette() { paletteEl.classList.add("hidden"); view.focus(); }
function renderPalette(q) {
  const cmdMode = q.startsWith(">");
  const term = (cmdMode ? q.slice(1) : q).trim();
  const cmds = COMMANDS.filter((c) => !term || fuzzy(term, c.label)).map((c) => ({ kind: "cmd", label: c.label, run: c.run }));
  const recents = cmdMode ? [] : recentItems(term);
  const drafts = cmdMode ? [] : paletteDrafts
    .filter((d) => !term || fuzzy(term, d.title || d.path.split("/").pop()))
    .slice(0, 8)
    .map((d) => ({ kind: "draft", label: d.title || d.path.split("/").pop(), run: () => smartOpen(d.path) }));
  const recentPaths = new Set(recents.map((r) => r.sub));
  const files = cmdMode ? [] : paletteFiles.filter((f) => !recentPaths.has(f.path) && (!term || fuzzy(term, f.name))).slice(0, 40)
    .map((f) => ({ kind: "file", label: f.name, run: () => smartOpen(f.path) }));
  paletteItems = [...drafts, ...recents, ...files, ...cmds];
  paletteSel = 0;
  drawPalette();
}
const PAL_GROUP = { draft: "Drafts", recent: "Recent", file: "Files", cmd: "Commands" };
function drawPalette() {
  paletteList.innerHTML = "";
  let lastKind = null;
  paletteItems.forEach((it, i) => {
    if (it.kind !== lastKind && PAL_GROUP[it.kind]) {
      const g = document.createElement("div"); g.className = "pal-group"; g.textContent = PAL_GROUP[it.kind];
      paletteList.appendChild(g);
      lastKind = it.kind;
    }
    const row = document.createElement("div");
    row.className = "pal-item" + (i === paletteSel ? " sel" : "");
    const icon = document.createElement("span"); icon.className = "pal-icon";
    icon.textContent = it.kind === "file" ? "›" : it.kind === "recent" ? "↺" : it.kind === "draft" ? "✎" : "⚡";
    const label = document.createElement("span"); label.className = "pal-label"; label.textContent = it.label;
    row.append(icon, label);
    if (it.sub) {
      const sub = document.createElement("span"); sub.className = "pal-sub";
      sub.textContent = it.sub.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
      row.appendChild(sub);
    }
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
      row.onmousedown = (e) => { e.preventDefault(); closeSearch(); openInCurrentTab(r.path, r.line); };
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
let wsSessions = [], wsContext = [], wsTimer = null, wsRows = [], wsSel = 0, wsInsertMode = false;

async function openWorkspace() {
  closePalette(); closeSearch();
  wsEl.classList.remove("hidden");
  wsInput.value = "";
  wsInput.placeholder = wsInsertMode
    ? "Pick a session or context file to insert its text…"
    : "Filter sessions & context, or search transcripts…";
  const dir = currentDir();
  [wsContext, wsSessions] = await Promise.all([
    window.plume.listContext(dir),
    window.plume.listSessions(dir),
  ]);
  renderWorkspace("");
  wsInput.focus();
}
function closeWorkspace() { wsEl.classList.add("hidden"); wsInsertMode = false; }
function activateWsRow(openPath, line) {
  const insert = wsInsertMode;
  closeWorkspace();
  if (insert) insertSessionText(openPath);
  else openInCurrentTab(openPath, line);
}

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
  const AGENT_LABEL = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
  const addRow = (title, sub, openPath, line, agent) => {
    const row = document.createElement("div");
    row.className = "ws-item";
    const t = document.createElement("div"); t.className = "ws-title";
    if (agent && AGENT_LABEL[agent]) {
      const b = document.createElement("span"); b.className = "ws-badge agent-" + agent; b.textContent = AGENT_LABEL[agent];
      t.appendChild(b);
    }
    t.appendChild(document.createTextNode(title));
    const s = document.createElement("div"); s.className = "ws-sub"; s.textContent = sub;
    row.append(t, s);
    const idx = wsRows.length;
    row.onmousedown = (e) => { e.preventDefault(); activateWsRow(openPath, line); };
    row.onmouseenter = () => { wsSel = idx; paintWsSel(); };
    wsList.appendChild(row);
    wsRows.push({ el: row, path: openPath, line });
  };

  const ctx = wsContext.filter((c) => !term || c.name.toLowerCase().includes(term));
  if (ctx.length) { addGroup("Project context"); ctx.forEach((c) => addRow(c.name, c.path.replace(/\/[^/]*$/, ""), c.path)); }

  const sess = wsSessions.filter((s) => !term || s.title.toLowerCase().includes(term));
  if (sess.length) {
    const counts = {};
    for (const s of sess) counts[s.agent] = (counts[s.agent] || 0) + 1;
    const tally = ["claude", "codex", "gemini"].filter((a) => counts[a]).map((a) => `${AGENT_LABEL[a]} ${counts[a]}`).join(" · ");
    addGroup(term ? "Sessions (title)" : tally ? `Recent agent sessions — ${tally}` : "Recent agent sessions");
    sess.slice(0, 40).forEach((s) => addRow(s.title, tsLabel(s.ts), s.path, undefined, s.agent));
  }

  if (!wsRows.length && !term) wsList.innerHTML = '<div class="sb-empty">No agent sessions or context files for this folder.</div>';
  paintWsSel();

  if (term.length >= 2) {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(async () => {
      const hits = await window.plume.searchSessions(term, currentDir());
      const shown = new Set(wsRows.map((r) => r.path));
      const fresh = hits.filter((h) => !shown.has(h.path));
      if (fresh.length) {
        addGroup("Matches in transcript");
        fresh.forEach((h) => addRow(h.title, h.snippet, h.path, undefined, h.agent));
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
  else if (e.key === "Enter") { const r = wsRows[wsSel]; if (r) activateWsRow(r.path, r.line); }
});
wsEl.addEventListener("mousedown", (e) => { if (e.target === wsEl) closeWorkspace(); });

/* ---------- Confirm dialog (save prompts) ---------- */
const confirmEl = (() => {
  const el = document.createElement("div");
  el.id = "confirm";
  el.className = "overlay hidden";
  document.body.appendChild(el);
  return el;
})();
let confirmResolve = null;
function closeConfirm(value) {
  confirmEl.classList.add("hidden");
  confirmEl.innerHTML = "";
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(value);
}
// askConfirm({ message, detail, buttons: [{label, kind, value}] }) → Promise<value|null>.
// Escape / backdrop click resolve null (treat as Cancel).
function askConfirm({ message, detail, buttons }) {
  return new Promise((resolve) => {
    if (confirmResolve) closeConfirm(null); // replace any prior prompt
    confirmResolve = resolve;
    confirmEl.innerHTML = "";
    const box = document.createElement("div");
    box.className = "confirm-box";
    const msg = document.createElement("div");
    msg.className = "confirm-msg";
    msg.textContent = message;
    box.appendChild(msg);
    if (detail) {
      const d = document.createElement("div");
      d.className = "confirm-detail";
      d.textContent = detail;
      box.appendChild(d);
    }
    const bar = document.createElement("div");
    bar.className = "confirm-bar";
    let primary = null;
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = "confirm-btn " + (b.kind || "ghost");
      btn.textContent = b.label;
      btn.onclick = () => closeConfirm(b.value);
      if (b.kind === "primary") primary = btn;
      bar.appendChild(btn);
    }
    box.appendChild(bar);
    confirmEl.appendChild(box);
    confirmEl.classList.remove("hidden");
    (primary || bar.firstChild)?.focus();
  });
}
confirmEl.addEventListener("mousedown", (e) => { if (e.target === confirmEl) closeConfirm(null); });
document.addEventListener("keydown", (e) => {
  if (!confirmResolve) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeConfirm(null); }
}, true);

/* ---------- Document tabs (#10 — in-window switching) ---------- */
// The renderer owns the tab list AND is the single source of truth for what
// this window shows (Cluster A). The native side sees one bound document per
// window, managed exclusively through bindDoc()/detachDoc(); the full tab
// path-set is mirrored via setOpenPaths() so background tabs stay inside the
// agent write scope and listOpenFiles.
const tabbarEl = document.getElementById("tabbar");
let tabs = [createTab()];
let activeTabId = tabs[0].id;
let pendingTabRestore = null; // consumed by loadDocument when a switch is in flight

// Canonical Autosave dir, published by the native side (authoritative for the
// is-draft prefix check). Fallback: derived from createDraft's own response.
let draftsDir = null;
window.plume.draftsDir?.().then((d) => { if (d) draftsDir = d; }).catch(() => {});
function isDraft(tab) { return isDraftTab(tab, draftsDir); }

function activeTab() { return findTab(tabs, activeTabId); }

// Mirror the window's tab path-set to the native side (agent scope +
// listOpenFiles + the Destroyed-time dirty_files GC). Deduped push.
let lastOpenPathsPushed = "";
function pushOpenPaths() {
  const paths = [...new Set(tabs.map((t) => t.path).filter(Boolean))];
  const key = paths.join("\n");
  if (key === lastOpenPathsPushed) return;
  lastOpenPathsPushed = key;
  window.plume.setOpenPaths?.(paths);
}

// Bind `path` as this window's doc and load it into the editor (in the current
// tab). The single entry point for in-place file opens: sidebar, search,
// session rows, tab activation, and new-tab opens all come through here.
async function openInCurrentTab(path, line) {
  const r = await window.plume.bindDoc(path);
  if (!r) { flashMessage("Couldn't open " + path.split("/").pop()); return false; }
  loadDocument(r.content, path, r.recovery, line);
  return true;
}

// Freeze the live editor state into the active tab's record (before switching away).
function captureActiveTab() {
  const t = activeTab();
  if (!t) return;
  t.path = currentPath;
  t.pendingName = pendingName;
  t.text = view.state.doc.toString();
  t.savedText = savedText;
  t.sel = { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head };
  t.scrollTop = view.scrollDOM.scrollTop;
}

function renderTabbar() {
  pushOpenPaths(); // every tab add/remove/retarget re-renders — keep the native mirror current
  tabbarEl.classList.toggle("hidden", tabs.length < 2);
  tabbarEl.innerHTML = "";
  if (tabs.length < 2) return;
  for (const t of tabs) {
    const active = t.id === activeTabId;
    const el = document.createElement("div");
    el.className = "tab" + (active ? " on" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", active ? "true" : "false");
    const dirty = active ? titlebar.classList.contains("dirty") : isCapturedDirty(t);
    const name = document.createElement("span");
    name.className = "tab-name" + (dirty ? " dirty" : "");
    name.textContent = active
      ? (currentPath ? currentPath.split("/").pop() : (pendingName || "Untitled"))
      : tabDisplayName(t);
    name.title = t.path || name.textContent;
    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Close tab";
    close.setAttribute("aria-label", "Close tab");
    close.textContent = "×";
    close.addEventListener("mousedown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTabRequest(t.id); });
    el.append(name, close);
    el.addEventListener("mousedown", (e) => { if (e.button === 1) { e.preventDefault(); closeTabRequest(t.id); } });
    el.addEventListener("click", () => activateTab(t.id));
    tabbarEl.appendChild(el);
  }
  const add = document.createElement("button");
  add.className = "tab-add";
  add.title = "New tab  ⌘T";
  add.setAttribute("aria-label", "New tab");
  add.textContent = "+";
  add.addEventListener("click", () => newTab());
  tabbarEl.appendChild(add);
}

// Show an untitled tab's buffer. Mirrors loadDocument for the no-path case.
function presentUntitledTab(t) {
  // Clear this window's native binding so saves/snapshots route to the
  // untitled slot, never to the previously shown file.
  window.plume.detachDoc?.();
  const text = t.text ?? "";
  applyMode(null, text);
  pendingName = t.pendingName || null;
  savedText = t.savedText ?? "";
  const anchor = Math.min(t.sel?.anchor ?? 0, text.length);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor, head: Math.min(t.sel?.head ?? anchor, text.length) },
  });
  setDocPath(view, null);
  setTitle(null);
  setDirty(text !== savedText);
  loadAnnotationsFor(null);
  renderOutline();
  updateStatus();
  updateWelcome();
  clearBanner();
  view.scrollDOM.scrollTop = t.scrollTop || 0;
  view.focus();
}

// Load tab `t` into the editor (native rebind for path-backed tabs).
async function presentTab(t) {
  if (t.path && !t.unbound) {
    // P2-C: only a DIRTY captured buffer is restored over disk content — a
    // clean tab always takes the (possibly newer) state of the file on disk.
    pendingTabRestore = isCapturedDirty(t) ? t : null;
    const r = await window.plume.bindDoc(t.path);
    if (r) {
      loadDocument(r.content, t.path, r.recovery);
    } else {
      // Read failed (file moved/deleted): DROP the binding (Cluster A pillar 2).
      // The buffer stays; the next save is an explicit Save As — a stale path
      // is never written blindly.
      pendingTabRestore = null;
      window.plume.detachDoc?.();
      // Capture BEFORE loadDocument: its tab-record cleanup nulls t.text and
      // t.savedText, which silently erased the dirty baseline (Codex P1 —
      // the vanished-file tab then read as clean and close dropped it).
      const text = t.text ?? "";
      const baseline = t.savedText;
      loadDocument(text, t.path);
      t.unbound = true;
      if (baseline != null && baseline !== text) { savedText = baseline; setDirty(true); }
      flashMessage(`${tabDisplayName(t)} can't be read from disk — showing the buffer; saving will ask where.`);
    }
  } else if (t.path && t.unbound) {
    // Known-unbound tab: present the buffer, no native binding.
    window.plume.detachDoc?.();
    const text = t.text ?? "";
    const baseline = t.savedText; // before loadDocument nulls it (see above)
    loadDocument(text, t.path);
    t.unbound = true; // loadDocument resets the flag on the tab record
    if (baseline != null && baseline !== text) { savedText = baseline; setDirty(true); }
  } else {
    presentUntitledTab(t);
  }
  renderTabbar();
}

// flush:false is for the window-close iteration — the outgoing tab there may
// have just been explicitly DISCARDED (Don't Save), and the normal autosave
// flush would write the very edits the user chose to drop.
async function activateTab(id, { flush = true } = {}) {
  if (id === activeTabId) return;
  const t = findTab(tabs, id);
  if (!t) return;
  if (flush) await autosave(); // flush the outgoing tab so background tabs are clean
  captureActiveTab();
  activeTabId = id;
  await presentTab(t);
}

async function newTab() {
  await autosave();
  captureActiveTab();
  const t = createTab();
  tabs = addTab(tabs, t);
  activeTabId = t.id;
  presentUntitledTab(t);
  renderTabbar();
}

async function openInNewTab(path, line) {
  // Same-window dedupe (round-2 MED): a path already open in a tab activates
  // that tab instead of double-binding it in a second one.
  const existing = findTabByPath(tabs, path);
  if (existing) { await activateTab(existing.id); return; }
  // Cross-window (drafts only — regular files keep the cluster-A multi-window
  // contract; their watcher+banner reconciles, silent draft autosave doesn't):
  // if another window holds this draft, focus it there rather than double-bind.
  if (isDraftTab({ path, unbound: false }, draftsDir) && (await window.plume.focusPath?.(path))) return;
  // Reuse a blank scratch surface (e.g. the welcome screen) instead of stacking a tab.
  if (!currentPath && view.state.doc.length === 0) { await openInCurrentTab(path, line); return; }
  await autosave();
  captureActiveTab();
  const prevActive = activeTabId;
  const t = createTab({ path });
  tabs = addTab(tabs, t);
  activeTabId = t.id;
  if (!(await openInCurrentTab(path, line))) {
    // Read failed — drop the new tab and stay put (bindDoc left the previous
    // binding untouched, so the editor still shows the prior tab's doc).
    tabs = closeTab(tabs, t.id).tabs;
    activeTabId = prevActive;
  }
  renderTabbar();
}

async function closeTabRequest(id) {
  const t = findTab(tabs, id);
  if (!t) return;
  // Last tab → close the window; the native side owns that flow (and holds it
  // for a dirty untitled buffer, which re-enters via close-requested below).
  if (tabs.length === 1) { window.close(); return; }
  if (id !== activeTabId) {
    // Background tabs are flushed on switch-away, so dirty ones only exist when
    // autosave is off — surface them before discarding.
    if (isCapturedDirty(t)) { await activateTab(id); return closeActiveTab(); }
    // M4: a clean draft tab is ARCHIVED, not discarded — the Autosave file
    // stays and is reachable from the Drafts group; tell the user where.
    if (isKeepableDraft(t, draftsDir)) {
      tabs = closeTab(tabs, id).tabs;
      renderTabbar();
      flashMessage(`Draft kept — reopen “${tabDisplayName(t)}” from Drafts.`);
      return;
    }
    // An EMPTY draft's file is deleted with its tab (listDrafts orphan rule).
    if (isDraft(t) && t.path) window.plume.discardDraft?.(t.path);
    tabs = closeTab(tabs, id).tabs;
    renderTabbar();
    return;
  }
  return closeActiveTab();
}

// Ask Save / Don't Save / Cancel for the active doc; shared by tab close and
// window close so the two prompts stay identical.
function promptSaveChoice(detail) {
  const name = currentPath ? currentPath.split("/").pop() : (pendingName || "Untitled");
  return askConfirm({
    message: `Save changes to “${name}”?`,
    detail,
    buttons: [
      { label: "Save", kind: "primary", value: "save" },
      { label: "Don't Save", kind: "danger", value: "discard" },
      { label: "Cancel", kind: "ghost", value: "cancel" },
    ],
  });
}

// Dirty computed synchronously from the buffer — the titlebar flag lags behind
// the 120ms side-effect debounce, and the close iteration runs right after a
// tab switch restores a dirty buffer (Codex PR#9 P1: the race dropped drafts).
function activeDocDirtySync() { return view.state.doc.toString() !== savedText; }

// Resolve the close decision for the ACTIVE doc, running the prompt and any
// requested save. Returns true when the close may proceed. On resolution the
// doc's agent-guard dirty flag is cleared (the renderer is its single writer;
// a closing window can't clean up post-mortem), and an explicit Don't Save
// also clears the crash-recovery snapshot so the discard can't resurrect.
async function resolveCloseOfActiveDoc(detail, deferredCleanups = null) {
  const state = () => ({
    dirty: activeDocDirtySync(),
    hasPath: !!currentPath,
    isDraft: isDraft(activeTab()),
    empty: view.state.doc.toString().trim().length === 0,
  });
  let action = closeDecision(state());
  // An EMPTY draft closes without a prompt — but its file must not linger as a
  // permanent orphan in listDrafts (be-dev review): delete it on the way out.
  if (action === "close" && state().isDraft && state().empty && currentPath) {
    if (deferredCleanups) deferredCleanups.push({ path: currentPath, deleteDraft: true });
    else window.plume.discardDraft?.(currentPath);
  }
  if (action === "prompt") {
    const draft = state().isDraft;
    const choice = draft
      ? await askConfirm({
          message: "Keep this draft?",
          detail: "It's saved as a draft. Save it somewhere permanent, or delete it.",
          buttons: [
            { label: "Save…", kind: "primary", value: "save" },
            { label: "Delete Draft", kind: "danger", value: "discard" },
            { label: "Cancel", kind: "ghost", value: "cancel" },
          ],
        })
      : await promptSaveChoice(detail);
    action = closeDecision(state(), choice ?? "cancel");
  }
  if (action === "stay") return false;
  const path = currentPath;
  const t = activeTab();
  if (action === "save-then-close") {
    // An unbound tab (dropped binding) must not write its stale path — save()
    // routes it to Save As.
    await save();
    if (activeDocDirtySync()) return false; // save failed/cancelled → keep the doc open
  } else if (action === "saveas-then-close") {
    if (!(await saveAs())) return false; // dialog cancelled — keep the doc open
    if (activeDocDirtySync()) return false;
  } else if (action === "delete-draft-then-close") {
    // Irreversible unlink — DEFERRED to confirmClose in a window close (a
    // later tab's Cancel must find the draft intact); immediate on tab close.
    if (deferredCleanups) deferredCleanups.push({ path, deleteDraft: true });
    else window.plume.discardDraft?.(path);
  } else if (path && !(t && t.unbound) && activeDocDirtySync()) {
    // Explicit Don't Save of a path-backed doc: drop its recovery snapshot so
    // a later launch can't offer the discarded edits back. In a window close
    // this is DEFERRED (Codex P2): a later tab's Cancel aborts the close and
    // the still-open doc must keep its snapshot + agent-write guard.
    if (deferredCleanups) deferredCleanups.push({ path, discardRecovery: true });
    else window.plume.discardRecovery?.(path);
  }
  if (path) {
    if (deferredCleanups) deferredCleanups.push({ path });
    else window.plume.setDocDirty(path, false); // resolved either way
  }
  return true;
}

async function closeActiveTab() {
  if (!(await resolveCloseOfActiveDoc("Your changes will be lost if you close this tab without saving."))) return;
  const r = closeTab(tabs, activeTabId);
  tabs = r.tabs;
  activeTabId = r.nextActiveId;
  const next = activeTab();
  if (next) await presentTab(next);
  renderTabbar();
}

// Ctrl-Tab / Ctrl-Shift-Tab cycle tabs; ⌘T opens a new one. Capture phase so
// CodeMirror's Tab handling never sees Ctrl-Tab.
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.metaKey && e.key === "Tab") {
    e.preventDefault();
    activateTab(cycleTabId(tabs, activeTabId, e.shiftKey ? -1 : 1));
  } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "t" || e.key === "T")) {
    e.preventDefault();
    newTab();
  }
}, true);

/* ---------- Menu + IPC wiring ---------- */
window.plume.onOpenFile(({ filePath, content, recovery, gotoLine }) => loadDocument(content, filePath, recovery, gotoLine));
window.plume.onExternalChange(({ path, content }) => {
  // Per-window contract (be-dev #1): the payload names the file that changed on
  // disk. Ignore events for a file this window/tab isn't currently showing.
  if (path && path !== currentPath) return;
  const before = view.state.doc.toString();
  // Self-write or no-op → normal path (prevents the review re-firing on our own save).
  if (content === savedText || content === before) { applyExternalChange(content); return; }
  // Agent revised a doc that still has open directives, editor clean → review the diff.
  const hasOpenDirectives = annotations.some((a) => !a.resolved);
  if (hasOpenDirectives && currentPath && !titlebar.classList.contains("dirty")) openDiffReview(before, content);
  else applyExternalChange(content);
});
window.plume.onFolderOpen(({ dir }) => {
  sidebarRoot = dir;
  sidebarEl.classList.remove("hidden");
  refreshSidebar();
});

// Renderer-authoritative close (Cluster A pillar 3): the native side ALWAYS
// holds the close and emits close-requested (the bridge acks liveness
// immediately). Resolve the ACTIVE doc, then every captured-dirty BACKGROUND
// tab (untitled and saved) — activating each so its prompt names the right doc
// and Save routes correctly. Any Cancel aborts the whole close via
// cancelClose(); confirmClose() fires only when every dirty doc is saved or
// explicitly discarded. Don't Save never writes anything.
window.plume.onCloseRequested?.(async () => {
  const detail = "Your changes will be lost if you don't save them.";
  // Irreversible per-doc cleanups (recovery discard + agent-guard clear) are
  // COLLECTED here and committed only once the whole close is confirmed — a
  // later tab's Cancel aborts the close with every protection intact.
  const cleanups = [];
  if (!(await resolveCloseOfActiveDoc(detail, cleanups))) { window.plume.cancelClose?.(); return; }
  // Track resolved tabs by id: a tab discarded via Don't Save keeps its dirty
  // captured buffer when we move on, and must not be prompted again.
  const resolvedIds = new Set([activeTabId]);
  for (;;) {
    const t = dirtyBackgroundTabs(tabs, activeTabId, draftsDir).find((x) => !resolvedIds.has(x.id));
    if (!t) break;
    await activateTab(t.id, { flush: false }); // no autosave flush: outgoing tab may be freshly discarded
    if (!(await resolveCloseOfActiveDoc(detail, cleanups))) { window.plume.cancelClose?.(); return; }
    resolvedIds.add(t.id);
  }
  for (const c of cleanups) {
    if (c.deleteDraft) window.plume.discardDraft?.(c.path);
    if (c.discardRecovery) window.plume.discardRecovery?.(c.path);
    window.plume.setDocDirty(c.path, false);
  }
  window.plume.confirmClose?.();
});

// (Untitled crash-recovery banner removed: first-keystroke drafts made the
// per-window untitled snapshot subsystem obsolete — a new note is file-backed
// from its first character and reachable via the Drafts group.)

window.plume.onMenu((channel, ...args) => {
  switch (channel) {
    case "menu:open": window.plume.openDialog(); break;
    case "menu:openRecent": if (args[0]) smartOpen(args[0]); break;
    case "menu:clearRecent": clearRecents(); break;
    case "menu:save": save(Boolean(args[0]?.thenClose)); break;
    case "menu:saveAs": saveAs(); break;
    case "menu:find": openSearchPanel(view); break;
    case "menu:replace": openSearchPanel(view); break;
    case "menu:format": applyFormat(args[0]); break;
    case "menu:addNote": addAnnotation(); break;
    case "menu:heading": setHeading(args[0]); break;
    case "menu:toggleOutline": toggleOutline(); break;
    case "menu:toggleSidebar": toggleSidebar(); break;
    case "menu:palette": openPalette(); break;
    case "menu:searchFolder": openSearch(); break;
    case "menu:workspace": openWorkspace(); break;
    case "menu:toggleToolbar": applyToolbarSetting(!toolbarEnabled()); break;
    // New Format-menu channels (be-dev #12 contract).
    case "menu:list":
      if (args[0] === "bullet") toggleBulletList();
      else if (args[0] === "ordered") toggleOrderedList();
      else toggleTaskList();
      break;
    case "menu:block": (args[0] === "code" ? insertCodeBlock : toggleQuote)(); break;
    case "menu:insert": (args[0] === "hr" ? insertHR : insertTable)(); break;
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
buildRail();
buildWelcome();
updateWelcome();
pushRecentsToMenu(); // seed the native Open Recent menu from saved recents on launch

// Automation surface (used for scripting / testing the UI).
// Native asks THIS window to bring the tab holding `path` forward (the other
// half of focus_path — the source window focused us and routed the open here).
async function activatePath(path) {
  const t = findTabByPath(tabs, path);
  if (t) await activateTab(t.id);
}

window.__plume = {
  toggleSidebar, openPalette, openSearch, openWorkspace, refreshSidebar, exportAs,
  copyAsRichText, applyFocus, updateWelcome, addAnnotation, htmlToMarkdown,
  openDiffReview, smartOpen, view,
  newTab, activateTab, closeTabRequest, openInNewTab, activatePath,
  tabsState: () => ({ tabs: tabs.map((t) => ({ ...t })), activeTabId }),
};

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
