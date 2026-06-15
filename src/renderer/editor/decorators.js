import { Decoration, ViewPlugin } from "@codemirror/view";

const conceal = Decoration.replace({});
const mark = (cls) => Decoration.mark({ class: cls });
const line = (cls) => Decoration.line({ class: cls });

function eachVisibleLine(view, fn) {
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const ln = view.state.doc.lineAt(pos);
      fn(ln, ranges);
      pos = ln.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

/* ---------- Unified diff ---------- */

function classifyDiff(text) {
  if (/^(diff --git|index |new file|deleted file|similarity|rename|copy|old mode|new mode|Binary files)/.test(text)) return "diff-meta";
  if (/^@@/.test(text)) return "diff-hunk";
  if (/^(\+\+\+|---)/.test(text)) return "diff-file";
  if (/^\+/.test(text)) return "diff-add";
  if (/^-/.test(text)) return "diff-del";
  return null;
}

function buildDiff(view) {
  return eachVisibleLine(view, (ln, ranges) => {
    const cls = classifyDiff(ln.text);
    if (cls) ranges.push(line(cls).range(ln.from));
  });
}

export const diffDecorations = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildDiff(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildDiff(u.view); }
  },
  { decorations: (v) => v.decorations }
);

/* ---------- Log files (ANSI + level + timestamp) ---------- */

const ANSI_MAP = {
  30: "black", 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "gray", 91: "red", 92: "green", 93: "yellow", 94: "blue", 95: "magenta", 96: "cyan", 97: "white",
};

function sgrToClass(codeStr, cur) {
  let cls = cur;
  for (const c of (codeStr || "0").split(";").map(Number)) {
    if (c === 0) cls = null;
    else if (ANSI_MAP[c]) cls = "ansi-" + ANSI_MAP[c];
  }
  return cls;
}

const TIMESTAMP = /^\[?\d{4}-\d{2}-\d{2}[ T][\d:.,]+Z?\]?|^\[?\d{2}:\d{2}:\d{2}[.\d]*\]?/;

function levelClass(text) {
  if (/\b(ERROR|ERR|FATAL|FAIL(ED|URE)?|PANIC|EXCEPTION|TRACEBACK)\b/i.test(text)) return "log-error";
  if (/\b(WARN(ING)?)\b/i.test(text)) return "log-warn";
  if (/\b(DEBUG|TRACE|VERBOSE)\b/i.test(text)) return "log-dim";
  if (/\b(INFO|NOTICE)\b/i.test(text)) return "log-info";
  return null;
}

function decorateLogLine(ln, ranges) {
  const text = ln.text;
  if (text.indexOf("\x1b[") >= 0) {
    const re = /\x1b\[([0-9;]*)m/g;
    let m, last = 0, cur = null;
    while ((m = re.exec(text))) {
      const segStart = ln.from + last, segEnd = ln.from + m.index;
      if (segEnd > segStart && cur) ranges.push(mark(cur).range(segStart, segEnd));
      ranges.push(conceal.range(ln.from + m.index, ln.from + m.index + m[0].length));
      cur = sgrToClass(m[1], cur);
      last = m.index + m[0].length;
    }
    const segStart = ln.from + last;
    if (ln.to > segStart && cur) ranges.push(mark(cur).range(segStart, ln.to));
    return;
  }
  const cls = levelClass(text);
  if (cls) ranges.push(line(cls).range(ln.from));
  const tm = text.match(TIMESTAMP);
  if (tm) ranges.push(mark("log-time").range(ln.from, ln.from + tm[0].length));
}

function buildLog(view) {
  return eachVisibleLine(view, decorateLogLine);
}

export const logDecorations = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildLog(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildLog(u.view); }
  },
  { decorations: (v) => v.decorations }
);
