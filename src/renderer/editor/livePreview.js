import { Decoration, WidgetType, EditorView, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
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
  if (/^(https?:|data:|file:)/i.test(src)) return src;
  const dir = docDir(state);
  if (!dir) return null;
  const base = dir.split("/");
  for (const part of decodeURIComponent(src).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
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
  constructor(source) { super(); this.source = source; }
  eq(o) { return o.source === this.source; }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "tok-table";
    wrap.appendChild(buildTable(this.source));
    return wrap;
  }
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

function buildTable(source) {
  const lines = source.split("\n").map((l) => l.trim()).filter((l) => l.includes("|"));
  if (lines.length < 2) { const p = document.createElement("pre"); p.textContent = source; return p; }
  const cells = (line) => {
    let s = line.replace(/^\|/, "").replace(/\|$/, "");
    return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  };
  const aligns = cells(lines[1]).map((c) => {
    const l = c.startsWith(":"), r = c.endsWith(":");
    return r && l ? "center" : r ? "right" : l ? "left" : "";
  });
  const table = document.createElement("table");
  const thead = table.createTHead();
  const htr = thead.insertRow();
  cells(lines[0]).forEach((c, i) => {
    const th = document.createElement("th");
    th.innerHTML = inlineMd(c); if (aligns[i]) th.style.textAlign = aligns[i];
    htr.appendChild(th);
  });
  const tbody = table.createTBody();
  for (let r = 2; r < lines.length; r++) {
    const tr = tbody.insertRow();
    cells(lines[r]).forEach((c, i) => {
      const td = tr.insertCell();
      td.innerHTML = inlineMd(c); if (aligns[i]) td.style.textAlign = aligns[i];
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

  tree.iterate({
    enter: (node) => {
      const name = node.name;

      // ----- Block widgets (tables, mermaid) -----
      if (name === "Table") {
        if (!rangeActive(state, node.from, node.to)) {
          ranges.push(
            Decoration.replace({ widget: new TableWidget(state.sliceDoc(node.from, node.to)), block: true })
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
        if (/^[-*+]$/.test(txt) && shouldConceal(onActive)) {
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

// Approximate width of each prefix character in units of the average glyph.
function prefixCols(prefix) {
  let cols = 0;
  for (const ch of prefix) {
    if (ch === " ") cols += 0.5;
    else if (ch === "." || ch === ")") cols += 0.5;
    else if (ch === "[" || ch === "]") cols += 0.55;
    else if (/\d/.test(ch)) cols += 1.0;
    else if (/[-*+]/.test(ch)) cols += 1.0; // rendered as a bullet
    else cols += 0.9; // x / other
  }
  return cols;
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
          // Estimate the rendered prefix width per character (digits/markers are
          // ~1 average glyph; spaces, dots, and brackets are narrower). Scaled by
          // the editor's measured average char width, so it adapts to the font.
          const indent = Math.round(prefixCols(m[1]) * view.defaultCharacterWidth);
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

export const livePreview = [docPathField, livePreviewField, listIndent, focusPlugin, linkClicker];
