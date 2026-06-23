import { Decoration, WidgetType, EditorView, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { syntaxTree, foldService, codeFolding, foldEffect, unfoldEffect, foldedRanges } from "@codemirror/language";
import katex from "katex";
import mermaid from "mermaid";

/* ---------- Document path (for resolving relative images/links) ---------- */

export const setDocPathEffect = StateEffect.define();
export const refreshEffect = StateEffect.define();

export const docPathField = StateField.define({
  create() { return null; },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDocPathEffect)) return e.value;
    return value;
  },
});

export function setDocPath(view, path) {
  view.dispatch({ effects: setDocPathEffect.of(path) });
}

function docDir(state) {
  const p = state.field(docPathField, false);
  if (!p) return null;
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : null;
}

function resolveSrc(state, src) {
  if (/^(https?:|data:|file:|asset:|blob:)/i.test(src)) return src;
  const dir = docDir(state);
  if (!dir) return null;
  const base = dir.split("/");
  for (const part of decodeURIComponent(src).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  // Local files can't load via file:// from the app origin in Tauri/WKWebView;
  // route through the host's asset URL (Tauri asset protocol / Electron file://).
  const absPath = base.join("/");
  if (window.plume && window.plume.toAssetUrl) return window.plume.toAssetUrl(absPath);
  return "file://" + base.map(encodeURIComponent).join("/");
}

/* ---------- Mermaid ---------- */

let mmdSeq = 0;
let mermaidTheme = "default";
let mermaidInit = false;
function ensureMermaid() {
  if (mermaidInit) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: mermaidTheme,
    securityLevel: "strict",
    fontFamily: "inherit",
  });
  mermaidInit = true;
}
export function setMermaidTheme(theme) {
  mermaidTheme = theme;
  mermaidInit = false; // re-init on next render
}

/** Render a standalone Mermaid document into an element (for .mmd files). */
export async function renderMermaidInto(el, code) {
  ensureMermaid();
  const id = "mmd-file-" + mmdSeq++;
  try {
    const { svg } = await mermaid.render(id, code.trim());
    el.innerHTML = svg;
  } catch (e) {
    el.classList.add("error");
    el.textContent = "Mermaid: " + (e?.message || e);
  }
}

/* When false (default), Markdown marks stay hidden even on the active line. */
let revealMarksWhenEditing = false;
export function setRevealMarks(v) { revealMarksWhenEditing = v; }
function shouldConceal(onActive) { return !(revealMarksWhenEditing && onActive); }

/* Focus mode dims everything but the paragraph you're in. */
let focusMode = false;
export function setFocusMode(v) { focusMode = v; }

/* `==highlight==` inline mark (a small @lezer/markdown delimiter extension). */
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
export const Highlight = {
  defineNodes: ["Highlight", "HighlightMark"],
  parseInline: [{
    name: "Highlight",
    parse(cx, next, pos) {
      if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true);
    },
    after: "Emphasis",
  }],
};

const CALLOUT_RE = /^>\s*\[!(\w+)\]/;

/* ---------- Widgets ---------- */

class CheckboxWidget extends WidgetType {
  constructor(checked, from, to) { super(); this.checked = checked; this.from = from; this.to = to; }
  eq(o) { return o.checked === this.checked && o.from === this.from; }
  toDOM(view) {
    const box = document.createElement("span");
    box.className = "tok-task" + (this.checked ? " checked" : "");
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.from, to: this.to, insert: this.checked ? "[ ]" : "[x]" } });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "tok-hr-line"; return s; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "tok-bullet"; s.textContent = "•"; return s; }
}

function urlHost(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }

class LinkCardWidget extends WidgetType {
  constructor(url) { super(); this.url = url; }
  eq(o) { return o.url === this.url; }
  toDOM() {
    const host = urlHost(this.url);
    const card = document.createElement("a");
    card.className = "tok-linkcard";
    card.href = this.url;
    card.onclick = (e) => { e.preventDefault(); window.plume.openExternal(this.url); };
    const body = document.createElement("div");
    body.className = "lc-body";
    body.innerHTML = "";
    const title = document.createElement("div"); title.className = "lc-title"; title.textContent = host;
    const desc = document.createElement("div"); desc.className = "lc-desc"; desc.textContent = "Loading preview…";
    body.append(title, desc);
    card.appendChild(body);
    window.plume.linkPreview(this.url).then((meta) => {
      card.innerHTML = "";
      if (meta && meta.isImage) {
        card.classList.add("lc-isimage");
        const img = document.createElement("img");
        img.className = "lc-fullimg";
        img.src = meta.image; img.alt = "";
        img.onerror = () => { card.textContent = urlHost(this.url); };
        card.appendChild(img);
        return;
      }
      if (meta && meta.image) {
        const thumb = document.createElement("div"); thumb.className = "lc-thumb";
        const img = document.createElement("img"); img.src = meta.image; img.alt = "";
        img.onerror = () => thumb.remove();
        thumb.appendChild(img);
        card.appendChild(thumb);
      }
      const b = document.createElement("div"); b.className = "lc-body";
      const t = document.createElement("div"); t.className = "lc-title"; t.textContent = (meta && meta.title) || host;
      b.appendChild(t);
      if (meta && meta.description) { const d = document.createElement("div"); d.className = "lc-desc"; d.textContent = meta.description; b.appendChild(d); }
      const s = document.createElement("div"); s.className = "lc-site"; s.textContent = (meta && meta.site) || host;
      b.appendChild(s);
      card.appendChild(b);
    }).catch(() => {});
    return card;
  }
  ignoreEvent() { return false; }
}

const CALLOUT_LABELS = {
  note: ["ⓘ", "Note"], tip: ["✦", "Tip"], important: ["❗", "Important"],
  warning: ["⚠", "Warning"], caution: ["⚑", "Caution"], info: ["ⓘ", "Info"],
  success: ["✓", "Success"], danger: ["⚠", "Danger"], question: ["?", "Question"],
};
class CalloutWidget extends WidgetType {
  constructor(type) { super(); this.type = type; }
  eq(o) { return o.type === this.type; }
  toDOM() {
    const [icon, label] = CALLOUT_LABELS[this.type] || ["ⓘ", this.type.replace(/^\w/, (c) => c.toUpperCase())];
    const el = document.createElement("span");
    el.className = "tok-callout-label";
    el.textContent = `${icon} ${label}`;
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "tok-img";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt || "";
    img.onerror = () => { wrap.classList.add("broken"); wrap.textContent = `🖼 ${this.alt || this.src}`; };
    wrap.appendChild(img);
    return wrap;
  }
}

class MathWidget extends WidgetType {
  constructor(tex, display) { super(); this.tex = tex; this.display = display; }
  eq(o) { return o.tex === this.tex && o.display === this.display; }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = "tok-math" + (this.display ? " display" : "");
    try {
      el.innerHTML = katex.renderToString(this.tex, {
        displayMode: this.display, throwOnError: false, errorColor: "#e06c75",
      });
    } catch (e) {
      el.classList.add("error"); el.textContent = this.tex;
    }
    return el;
  }
}

class TableWidget extends WidgetType {
  constructor(source, from, docPath) { super(); this.source = source; this.from = from; this.docPath = docPath; }
  eq(o) { return o.source === this.source && o.from === this.from && o.docPath === this.docPath; }
  // Keep CM out of the widget's internal events so the in-cell editor can run.
  ignoreEvent() { return true; }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "tok-table";
    wrap.appendChild(buildTable(this.source, this.from, this.docPath));
    // In-place cell editing: click a cell to edit it directly. The cursor never
    // enters the table (so it stays rendered, no raw markdown); instead a small
    // textarea opens over the clicked cell and writes that cell's span back.
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
      if (e.target.closest(".col-resize")) return;     // column-resize handle
      if (e.target.closest(".tok-table-edit")) return; // already editing
      const cell = e.target.closest("[data-start]");
      if (!cell) return;
      e.preventDefault();
      openCellEditor(view, cell);
    });
    return wrap;
  }
}

// Open a textarea editor laid exactly over `cell`, pre-filled with the cell's
// source text. Enter / blur commit (write the cell span back to the doc, which
// re-renders the table); Escape cancels. The .md never shows pipes to the user.
function openCellEditor(view, cell) {
  const start = parseInt(cell.dataset.start, 10);
  const end = parseInt(cell.dataset.end, 10);
  if (Number.isNaN(start) || Number.isNaN(end)) return;
  const rect = cell.getBoundingClientRect();
  const cs = getComputedStyle(cell);
  const ta = document.createElement("textarea");
  ta.className = "tok-table-edit";
  ta.value = cell.dataset.raw || "";
  ta.spellcheck = false;
  Object.assign(ta.style, {
    position: "fixed", left: rect.left + "px", top: rect.top + "px",
    width: rect.width + "px", height: rect.height + "px",
    font: cs.font, padding: cs.padding, textAlign: cs.textAlign,
  });
  document.body.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    const val = ta.value;
    ta.remove();
    if (!save) return;
    // Re-pad the whole inter-pipe region to a clean "| text |" (or "| |" if empty).
    const trimmed = val.replace(/\r?\n/g, " ").trim().replace(/\|/g, "\\|");
    const insert = trimmed ? " " + trimmed + " " : " ";
    const docLen = view.state.doc.length;
    view.dispatch({ changes: { from: Math.min(start, docLen), to: Math.min(end, docLen), insert } });
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    else if (e.key === "Tab") { e.preventDefault(); commit(true); }
  });
  ta.addEventListener("blur", () => commit(true));
}

class MermaidWidget extends WidgetType {
  constructor(code) { super(); this.code = code; }
  eq(o) { return o.code === this.code; }
  toDOM() {
    const el = document.createElement("div");
    el.className = "tok-mermaid";
    ensureMermaid();
    const id = "mmd-" + mmdSeq++;
    mermaid.render(id, this.code)
      .then(({ svg }) => { el.innerHTML = svg; })
      .catch((err) => { el.classList.add("error"); el.textContent = "Mermaid: " + (err?.message || err); });
    return el;
  }
}

/* ---------- Minimal inline markdown for table cells ---------- */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

// Column widths are a Plume-local view preference (Markdown can't carry them):
// persisted in localStorage keyed by doc path + the header row, so they survive
// reopening on this machine but never touch the .md file.
function tableWidthKey(docPath, headerCells) {
  return "plume-twidth:" + (docPath || "") + "::" + headerCells.join("␟").slice(0, 200);
}
function loadTableWidths(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return Array.isArray(v) ? v : null; } catch { return null; }
}
function saveTableWidths(key, widths) {
  try { localStorage.setItem(key, JSON.stringify(widths.map((w) => Math.round(w) || 0))); } catch { /* quota / private mode */ }
}

// A draggable handle on a header cell's right border. Dragging resizes that
// column; on release the full width set is persisted under `key`.
function makeResizeHandle(table, colgroup, colIdx, key) {
  const h = document.createElement("span");
  h.className = "col-resize";
  h.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // don't let the table's cell-edit listener fire
    const ths = table.tHead.rows[0].cells;
    // Snapshot every column's current rendered width, then switch to fixed
    // layout so explicit col widths are honored and other columns hold steady.
    [...colgroup.children].forEach((col, j) => {
      if (!parseFloat(col.style.width)) col.style.width = ths[j].getBoundingClientRect().width + "px";
    });
    table.style.tableLayout = "fixed";
    const col = colgroup.children[colIdx];
    const startX = e.clientX;
    const startW = parseFloat(col.style.width) || ths[colIdx].getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    const onMove = (ev) => { col.style.width = Math.max(40, startW + (ev.clientX - startX)) + "px"; };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      saveTableWidths(key, [...colgroup.children].map((c) => parseFloat(c.style.width) || 0));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  return h;
}

// `from` is the table's source start offset; each cell is tagged with data-pos
// (the document position of its content) so a click can drop the cursor into it.
function buildTable(source, from, docPath) {
  const rawLines = source.split("\n");
  const lineStart = []; // offset of each raw line within `source`
  for (let i = 0, acc = 0; i < rawLines.length; i++) { lineStart.push(acc); acc += rawLines[i].length + 1; }
  const rowIdx = rawLines.map((l, i) => (l.includes("|") ? i : -1)).filter((i) => i >= 0);
  if (rowIdx.length < 2) { const p = document.createElement("pre"); p.textContent = source; return p; }
  const cells = (line) => {
    const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  };
  // For the colIdx-th cell on a raw line: the full inter-pipe region [start,end)
  // (so a write re-pads to a clean "| text |"), plus the trimmed display text
  // (unescaped) used to prefill the in-cell editor.
  const cellSpan = (lineIdx, colIdx) => {
    const rl = rawLines[lineIdx];
    let pipes = 0, i = 0;
    for (; i < rl.length; i++) {
      if (rl[i] === "|" && rl[i - 1] !== "\\") { pipes++; if (pipes === colIdx + 1) { i++; break; } }
    }
    const regionStart = i;                 // just after the opening pipe
    let j = i;
    for (; j < rl.length; j++) { if (rl[j] === "|" && rl[j - 1] !== "\\") break; }
    const regionEnd = j;                   // just before the closing pipe
    let cs = regionStart; while (cs < regionEnd && rl[cs] === " ") cs++;
    let ce = regionEnd; while (ce > cs && rl[ce - 1] === " ") ce--;
    const base = (from || 0) + lineStart[lineIdx];
    return { start: base + regionStart, end: base + regionEnd, raw: rl.slice(cs, ce).replace(/\\\|/g, "|") };
  };
  const tagCell = (el, lineIdx, colIdx) => {
    const sp = cellSpan(lineIdx, colIdx);
    el.dataset.start = sp.start; el.dataset.end = sp.end; el.dataset.raw = sp.raw;
  };
  const aligns = cells(rawLines[rowIdx[1]]).map((c) => {
    const l = c.startsWith(":"), r = c.endsWith(":");
    return r && l ? "center" : r ? "right" : l ? "left" : "";
  });
  const headerCells = cells(rawLines[rowIdx[0]]);
  const numCols = headerCells.length;
  const key = tableWidthKey(docPath, headerCells);
  const saved = loadTableWidths(key);

  const table = document.createElement("table");
  if (saved) table.style.tableLayout = "fixed";
  const colgroup = document.createElement("colgroup");
  for (let i = 0; i < numCols; i++) {
    const col = document.createElement("col");
    if (saved && saved[i]) col.style.width = saved[i] + "px";
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  const htr = table.createTHead().insertRow();
  headerCells.forEach((c, i) => {
    const th = document.createElement("th");
    th.innerHTML = inlineMd(c); if (aligns[i]) th.style.textAlign = aligns[i];
    tagCell(th, rowIdx[0], i);
    if (i < numCols - 1) th.appendChild(makeResizeHandle(table, colgroup, i, key));
    htr.appendChild(th);
  });
  const tbody = table.createTBody();
  for (let r = 2; r < rowIdx.length; r++) {
    const tr = tbody.insertRow();
    cells(rawLines[rowIdx[r]]).forEach((c, i) => {
      const td = tr.insertCell();
      td.innerHTML = inlineMd(c); if (aligns[i]) td.style.textAlign = aligns[i];
      tagCell(td, rowIdx[r], i);
    });
  }
  return table;
}

/* ---------- Decoration helpers ---------- */

const conceal = Decoration.replace({});
const lineDeco = (cls) => Decoration.line({ class: cls });
const markDeco = (cls) => Decoration.mark({ class: cls });

const HEADING_LINE = {
  ATXHeading1: "tok-h1", ATXHeading2: "tok-h2", ATXHeading3: "tok-h3",
  ATXHeading4: "tok-h4", ATXHeading5: "tok-h5", ATXHeading6: "tok-h6",
  SetextHeading1: "tok-h1", SetextHeading2: "tok-h2",
};
const INLINE_STYLE = {
  StrongEmphasis: "tok-strong", Emphasis: "tok-emphasis",
  Strikethrough: "tok-strike", InlineCode: "tok-inline-code",
  Highlight: "tok-highlight",
};

function activeLineSet(state) {
  const set = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}
function rangeActive(state, from, to) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}
function eatTrailingSpace(state, to) {
  return state.doc.sliceString(to, to + 1) === " " ? to + 1 : to;
}
function addLineClasses(ranges, state, from, to, cls) {
  let line = state.doc.lineAt(from);
  while (true) {
    ranges.push(lineDeco(cls).range(line.from));
    if (line.to >= to) break;
    line = state.doc.lineAt(line.to + 1);
  }
}
function isInCode(node) {
  let n = node;
  while (n) {
    if (/Code|Fenced|InlineCode|CodeText|CodeMark|CodeBlock|HTML/.test(n.name)) return true;
    n = n.parent;
  }
  return false;
}
function fenceLang(state, node) {
  const first = state.doc.lineAt(node.from).text;
  const m = first.match(/^\s*(?:`{3,}|~{3,})\s*([\w+#-]+)/);
  return m ? m[1].toLowerCase() : "";
}
// A line that is just a Markdown link or a bare URL (not an image — those start with "!").
function parseLoneLink(text) {
  let m = text.match(/^\[([^\]]*)\]\(([^)\s]+)\)$/);
  if (m) return { label: m[1], url: m[2] };
  m = text.match(/^<?(https?:\/\/[^\s>]+)>?$/);
  if (m) return { label: "", url: m[1] };
  return null;
}
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i;
function fenceBody(state, node) {
  const lines = state.sliceDoc(node.from, node.to).split("\n");
  if (lines.length && /^\s*(`{3,}|~{3,})/.test(lines[0])) lines.shift();
  if (lines.length && /^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

/* ---------- Math scanning (parser is markdown-only) ---------- */

function scanMath(state, ranges, active) {
  const text = state.doc.toString();
  const tree = syntaxTree(state);
  const blockRanges = [];

  // Block / display math: $$ ... $$
  const block = /\$\$([\s\S]+?)\$\$/g;
  let m;
  while ((m = block.exec(text))) {
    const from = m.index, to = from + m[0].length;
    if (isInCode(tree.resolveInner(from, 1))) continue;
    blockRanges.push([from, to]);
    if (rangeActive(state, from, to)) continue;
    const tex = m[1].trim();
    const multiline = m[0].includes("\n");
    ranges.push(
      Decoration.replace({ widget: new MathWidget(tex, true), block: multiline }).range(from, to)
    );
  }

  // Inline math: $ ... $  (conservative, to avoid currency / shell vars)
  const inline = /\$([^$\n]+?)\$/g;
  while ((m = inline.exec(text))) {
    const from = m.index, to = from + m[0].length;
    if (blockRanges.some(([a, b]) => from >= a && to <= b)) continue;
    const inner = m[1];
    if (/^[\d({]/.test(inner)) continue;                 // $5, $(cmd), ${VAR}
    if (!/[\\^_{}=+\-*/<>]/.test(inner)) continue;        // require a math indicator
    if (isInCode(tree.resolveInner(from, 1))) continue;
    if (active.has(state.doc.lineAt(from).number)) continue;
    ranges.push(Decoration.replace({ widget: new MathWidget(inner.trim(), false) }).range(from, to));
  }
}

/* ---------- Build ---------- */

function parseImage(src) {
  const m = src.match(/^!\[([^\]]*)\]\(([^)\s]+)/);
  return m ? { alt: m[1], src: m[2] } : { alt: "", src: "" };
}

// Above this size, the whole-document live-preview pass is skipped so the
// editor stays responsive (the file still opens as plain, highlighted text).
const MAX_LIVE_PREVIEW_BYTES = 400_000;

function buildDecorations(state) {
  if (state.doc.length > MAX_LIVE_PREVIEW_BYTES) return Decoration.none;

  const ranges = [];
  const active = activeLineSet(state);
  const tree = syntaxTree(state);
  const docPath = state.field(docPathField, false) || ""; // for per-doc table column widths

  tree.iterate({
    enter: (node) => {
      const name = node.name;

      // ----- A line that is just a link/URL → inline image or link-preview card -----
      if (name === "Paragraph" && !rangeActive(state, node.from, node.to)) {
        const lk = parseLoneLink(state.sliceDoc(node.from, node.to).trim());
        if (lk) {
          if (IMAGE_URL_RE.test(lk.url)) {
            const url = resolveSrc(state, lk.url);
            if (url) {
              ranges.push(Decoration.replace({ widget: new ImageWidget(url, lk.label || ""), block: true }).range(node.from, node.to));
              return false;
            }
          } else if (/^https?:\/\//i.test(lk.url)) {
            ranges.push(Decoration.replace({ widget: new LinkCardWidget(lk.url), block: true }).range(node.from, node.to));
            return false;
          }
        }
      }

      // ----- Block widgets (tables, mermaid) -----
      if (name === "Table") {
        if (!rangeActive(state, node.from, node.to)) {
          ranges.push(
            Decoration.replace({ widget: new TableWidget(state.sliceDoc(node.from, node.to), node.from, docPath), block: true })
              .range(node.from, node.to)
          );
        }
        return false;
      }
      if (name === "FencedCode" || name === "CodeBlock") {
        const lang = name === "FencedCode" ? fenceLang(state, node) : "";
        if ((lang === "mermaid" || lang === "mmd") && !rangeActive(state, node.from, node.to)) {
          ranges.push(
            Decoration.replace({ widget: new MermaidWidget(fenceBody(state, node)), block: true })
              .range(node.from, node.to)
          );
          return false;
        }
        addLineClasses(ranges, state, node.from, node.to, "tok-code-block");
        return false;
      }
      if (name === "Image") {
        if (!active.has(state.doc.lineAt(node.from).number)) {
          const { src, alt } = parseImage(state.sliceDoc(node.from, node.to));
          const url = src && resolveSrc(state, src);
          if (url) {
            ranges.push(Decoration.replace({ widget: new ImageWidget(url, alt) }).range(node.from, node.to));
            return false;
          }
        }
        ranges.push(markDeco("tok-link").range(node.from, node.to));
        return false;
      }

      // ----- Block line styling -----
      if (HEADING_LINE[name]) { addLineClasses(ranges, state, node.from, node.from, HEADING_LINE[name]); return; }
      if (name === "Blockquote") {
        const first = state.doc.lineAt(node.from);
        const cm = CALLOUT_RE.exec(first.text);
        if (cm) {
          const type = cm[1].toLowerCase();
          addLineClasses(ranges, state, node.from, node.to, `tok-callout tok-cal-${type}`);
          if (shouldConceal(active.has(first.number))) {
            const br = first.text.indexOf("[");
            ranges.push(
              Decoration.replace({ widget: new CalloutWidget(type) }).range(first.from + br, first.from + cm[0].length)
            );
          }
          return; // descend so QuoteMark on each line is concealed
        }
        addLineClasses(ranges, state, node.from, node.to, "tok-quote");
        return;
      }

      // ----- Inline styling -----
      if (INLINE_STYLE[name]) { ranges.push(markDeco(INLINE_STYLE[name]).range(node.from, node.to)); return; }
      if (name === "Link") { ranges.push(markDeco("tok-link").range(node.from, node.to)); return; }
      if (name === "Autolink") { ranges.push(markDeco("tok-url").range(node.from, node.to)); return; }
      if (name === "URL") {
        const parent = node.node.parent?.name;
        if (parent === "Link" || parent === "Image") {
          if (shouldConceal(active.has(state.doc.lineAt(node.from).number))) {
            ranges.push(conceal.range(node.from, node.to));
          }
        } else {
          ranges.push(markDeco("tok-url").range(node.from, node.to));
        }
        return;
      }

      // ----- Concealable marks (hidden even when editing unless reveal mode is on) -----
      const onActive = active.has(state.doc.lineAt(node.from).number);
      if (name === "HeaderMark" || name === "QuoteMark") {
        if (shouldConceal(onActive)) ranges.push(conceal.range(node.from, eatTrailingSpace(state, node.to)));
        return;
      }
      if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark" || name === "HighlightMark") {
        if (shouldConceal(onActive)) ranges.push(conceal.range(node.from, node.to));
        return;
      }
      if (name === "LinkMark" || name === "LinkTitle") {
        if (shouldConceal(onActive)) ranges.push(conceal.range(node.from, node.to));
        return;
      }
      if (name === "ListMark") {
        const txt = state.doc.sliceString(node.from, node.to);
        // Only turn "-" into a bullet for a real item ("- x"), not a bare dash.
        const followedBySpace = state.doc.sliceString(node.to, node.to + 1) === " ";
        if (/^[-*+]$/.test(txt) && followedBySpace && shouldConceal(onActive)) {
          ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
        } else {
          ranges.push(markDeco("tok-list-bullet").range(node.from, node.to));
        }
        return;
      }
      if (name === "TaskMarker") {
        if (!onActive) {
          const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
          ranges.push(
            Decoration.replace({ widget: new CheckboxWidget(checked, node.from, node.to) })
              .range(node.from, eatTrailingSpace(state, node.to))
          );
        }
        return;
      }
      if (name === "HorizontalRule") {
        addLineClasses(ranges, state, node.from, node.from, "tok-hr");
        if (!onActive) ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
        return;
      }
    },
  });

  scanMath(state, ranges, active);
  return Decoration.set(ranges, true);
}

/* ---------- StateField + link handling ---------- */

const livePreviewField = StateField.define({
  create(state) { return buildDecorations(state); },
  update(value, tr) {
    const refresh = tr.effects.some((e) => e.is(setDocPathEffect) || e.is(refreshEffect));
    if (tr.docChanged || tr.selection || refresh) return buildDecorations(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function linkAt(view, pos) {
  const tree = syntaxTree(view.state);
  let node = tree.resolveInner(pos, -1);
  while (node) {
    if (node.name === "Link" || node.name === "Image" || node.name === "Autolink") {
      const text = view.state.doc.sliceString(node.from, node.to);
      const m = text.match(/\]\(([^)\s]+)/) || text.match(/^<?(https?:\/\/[^>\s]+)>?$/);
      if (m) return m[1];
    }
    node = node.parent;
  }
  return null;
}

async function followLink(url) {
  if (/^https?:\/\//i.test(url)) window.plume.openExternal(url);
  else {
    const resolved = await window.plume.resolveLink(url);
    if (resolved) window.plume.openInNewWindow(resolved);
  }
}

const linkClicker = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!(e.metaKey || e.ctrlKey)) return false;
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return false;
    const url = linkAt(view, pos);
    if (url) { e.preventDefault(); followLink(url); return true; }
    return false;
  },
});

/* ---------- List hanging indent (wrapped lines align under the text) ---------- */
const LIST_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/;

// Measure the actual rendered width of a list prefix in the editor font, so the
// hanging indent aligns exactly (bullets render as "•", ordered keep "1.", etc.).
const _measureCtx = document.createElement("canvas").getContext("2d");
function measurePrefixWidth(view, prefix) {
  const cs = getComputedStyle(view.contentDOM);
  _measureCtx.font = `${cs.fontSize} ${cs.fontFamily}`;
  const visible = prefix.replace(/^(\s*)[-*+]/, "$1•"); // bullet markers render as •
  return _measureCtx.measureText(visible).width;
}

function buildListIndent(view) {
  const tree = syntaxTree(view.state);
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const m = LIST_PREFIX.exec(line.text);
      if (m) {
        // Confirm it's a real list item (not a "- " line inside a code block).
        const at = line.from + (line.text.length - line.text.trimStart().length);
        let node = tree.resolveInner(at, 1), isList = false;
        for (let n = node; n; n = n.parent) {
          if (n.name === "ListItem") { isList = true; break; }
          if (/Code|Fenced/.test(n.name)) break;
        }
        if (isList) {
          const indent = Math.round(measurePrefixWidth(view, m[1]));
          if (indent > 0) {
            ranges.push(
              Decoration.line({ attributes: { style: `padding-left:${indent}px;text-indent:-${indent}px` } }).range(line.from)
            );
          }
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const listIndent = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildListIndent(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) {
        this.decorations = buildListIndent(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/* ---------- Focus mode (dim everything but the current paragraph) ---------- */
function buildFocus(view) {
  if (!focusMode) return Decoration.none;
  const active = new Set();
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number, b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) active.add(n);
  }
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (!active.has(line.number)) ranges.push(Decoration.line({ class: "cm-dim" }).range(line.from));
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}
const focusPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildFocus(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet ||
        u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)))) {
        this.decorations = buildFocus(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/* ---------- Heading section folding (H1–H3) ---------- */
// The section under a heading runs from the end of the heading line to the end
// of the last line before the next heading of the same-or-higher level (or EOF).
function headingFoldRange(state, line) {
  const m = /^(#{1,3})\s/.exec(line.text);
  if (!m) return null;
  const level = m[1].length;
  let endLine = line.number;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const hm = /^(#{1,6})\s/.exec(state.doc.line(n).text);
    if (hm && hm[1].length <= level) break;
    endLine = n;
  }
  if (endLine === line.number) return null; // nothing under the heading
  return { from: line.to, to: state.doc.line(endLine).to };
}

const headingFoldService = foldService.of((state, lineStart) =>
  headingFoldRange(state, state.doc.lineAt(lineStart))
);

function foldedRangeAt(state, pos) {
  let r = null;
  foldedRanges(state).between(pos, pos, (from, to) => { r = { from, to }; });
  return r;
}

// A chevron in the heading's left margin. Hidden by default; CSS reveals it on
// hover or when the line is active, and keeps it shown while collapsed.
class FoldToggleWidget extends WidgetType {
  constructor(folded, headFrom, active) { super(); this.folded = folded; this.headFrom = headFrom; this.active = active; }
  eq(o) { return o.folded === this.folded && o.headFrom === this.headFrom && o.active === this.active; }
  toDOM(view) {
    const el = document.createElement("span");
    el.className = "fold-toggle" + (this.folded ? " folded" : "") + (this.active ? " active" : "");
    el.setAttribute("aria-label", this.folded ? "Expand section" : "Collapse section");
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(this.headFrom);
      const existing = foldedRangeAt(view.state, line.to);
      if (existing) {
        view.dispatch({ effects: unfoldEffect.of(existing) });
      } else {
        const range = headingFoldRange(view.state, line);
        if (range) view.dispatch({ effects: foldEffect.of(range) });
      }
    });
    return el;
  }
  ignoreEvent() { return false; }
}

function buildFoldToggles(view) {
  // Heading lines the cursor sits on — the toggle shows there too (markdown mode
  // has no .cm-activeLine, so we track the cursor line ourselves).
  const cursorLines = new Set(view.state.selection.ranges.map((r) => view.state.doc.lineAt(r.head).number));
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      if (headingFoldRange(view.state, line)) {
        const folded = !!foldedRangeAt(view.state, line.to);
        ranges.push(
          Decoration.widget({ widget: new FoldToggleWidget(folded, line.from, cursorLines.has(line.number)), side: -1 }).range(line.from)
        );
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const headingFoldToggles = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildFoldToggles(view); }
    update(u) {
      const foldChanged = u.transactions.some((t) =>
        t.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
      if (u.docChanged || u.viewportChanged || u.selectionSet || foldChanged) this.decorations = buildFoldToggles(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

export const livePreview = [
  docPathField, livePreviewField, listIndent, focusPlugin, linkClicker,
  headingFoldService, codeFolding(), headingFoldToggles,
];
