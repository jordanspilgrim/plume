import { Decoration, ViewPlugin, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

/* ---------- Widgets ---------- */

class CheckboxWidget extends WidgetType {
  constructor(checked, from, to) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }
  eq(other) {
    return other.checked === this.checked && other.from === this.from;
  }
  toDOM(view) {
    const box = document.createElement("span");
    box.className = "tok-task" + (this.checked ? " checked" : "");
    box.setAttribute("aria-checked", String(this.checked));
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const next = this.checked ? "[ ]" : "[x]";
      view.dispatch({ changes: { from: this.from, to: this.to, insert: next } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "tok-hr-line";
    return hr;
  }
}

/* ---------- Decoration builders ---------- */

const conceal = Decoration.replace({});
const lineDeco = (cls) => Decoration.line({ class: cls });
const markDeco = (cls) => Decoration.mark({ class: cls });

const HEADING_LINE = {
  ATXHeading1: "tok-h1", ATXHeading2: "tok-h2", ATXHeading3: "tok-h3",
  ATXHeading4: "tok-h4", ATXHeading5: "tok-h5", ATXHeading6: "tok-h6",
  SetextHeading1: "tok-h1", SetextHeading2: "tok-h2",
};

const INLINE_STYLE = {
  StrongEmphasis: "tok-strong",
  Emphasis: "tok-emphasis",
  Strikethrough: "tok-strike",
  InlineCode: "tok-inline-code",
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

function lineActive(state, pos, active) {
  return active.has(state.doc.lineAt(pos).number);
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

function buildDecorations(view) {
  const { state } = view;
  const active = activeLineSet(state);
  const ranges = [];
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const onActive = lineActive(state, node.from, active);

        // Block-level line styling
        if (HEADING_LINE[name]) {
          addLineClasses(ranges, state, node.from, node.from, HEADING_LINE[name]);
          return;
        }
        if (name === "Blockquote") {
          addLineClasses(ranges, state, node.from, node.to, "tok-quote");
          return;
        }
        if (name === "FencedCode" || name === "CodeBlock") {
          addLineClasses(ranges, state, node.from, node.to, "tok-code-block");
          return;
        }

        // Inline styling (apply over whole node; concealed marks have zero width)
        if (INLINE_STYLE[name]) {
          ranges.push(markDeco(INLINE_STYLE[name]).range(node.from, node.to));
          return;
        }
        if (name === "Link" || name === "Image") {
          ranges.push(markDeco("tok-link").range(node.from, node.to));
          return;
        }
        if (name === "Autolink") {
          ranges.push(markDeco("tok-url").range(node.from, node.to));
          return;
        }
        // A URL inside a [text](url) link/image is concealed (show only the text);
        // a bare/autolink URL stays visible.
        if (name === "URL") {
          const parent = node.node.parent?.name;
          if (parent === "Link" || parent === "Image") {
            if (!onActive) ranges.push(conceal.range(node.from, node.to));
          } else {
            ranges.push(markDeco("tok-url").range(node.from, node.to));
          }
          return;
        }

        // Concealable marks (revealed when their line is being edited)
        if (name === "HeaderMark" || name === "QuoteMark") {
          if (!onActive) {
            ranges.push(conceal.range(node.from, eatTrailingSpace(state, node.to)));
          }
          return;
        }
        if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark") {
          if (!onActive) ranges.push(conceal.range(node.from, node.to));
          return;
        }
        if (name === "LinkMark" || name === "LinkTitle") {
          if (!onActive) ranges.push(conceal.range(node.from, node.to));
          return;
        }
        if (name === "ListMark") {
          ranges.push(markDeco("tok-list-bullet").range(node.from, node.to));
          return;
        }
        if (name === "TaskMarker") {
          if (!onActive) {
            const text = state.doc.sliceString(node.from, node.to);
            const checked = /x/i.test(text);
            ranges.push(
              Decoration.replace({
                widget: new CheckboxWidget(checked, node.from, node.to),
              }).range(node.from, eatTrailingSpace(state, node.to))
            );
          }
          return;
        }
        if (name === "HorizontalRule") {
          addLineClasses(ranges, state, node.from, node.from, "tok-hr");
          if (!onActive) {
            ranges.push(
              Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to)
            );
          }
          return;
        }
      },
    });
  }

  return Decoration.set(ranges, true);
}

/* ---------- Plugin ---------- */

export const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        // Cmd/Ctrl-click a link to follow it.
        if (!(e.metaKey || e.ctrlKey)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const url = linkAt(view, pos);
        if (url) {
          e.preventDefault();
          followLink(url);
          return true;
        }
        return false;
      },
    },
  }
);

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
  if (/^https?:\/\//i.test(url)) {
    window.plume.openExternal(url);
  } else {
    const resolved = await window.plume.resolveLink(url);
    if (resolved) window.plume.openInNewWindow(resolved);
  }
}
