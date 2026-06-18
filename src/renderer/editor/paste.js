// HTML clipboard → Markdown, tuned for pasting out of Notes, Word, and Google Docs.
//
// The hard part isn't turndown — it's that Word and Google Docs encode emphasis
// as inline-styled <span>s (font-weight / font-style / text-decoration) rather
// than <b>/<i>, and Google Docs wraps the whole payload in a <b style="font-weight:
// normal"> that must NOT be treated as bold. We normalize those into semantic tags
// in a DOM pass first, then let turndown (with GFM tables/strikethrough) do the rest.

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const td = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
td.use(gfm);

// Clean, tight list items. turndown's default emits "-   " (3 spaces) with a
// 2-space nesting indent, which renders as a detached bullet + shallow nesting.
// Use "- " / "N. " (one space) and a full 4-space tab per nesting level.
const NEST_INDENT = "    ";
td.addRule("cleanList", {
  filter: "li",
  replacement: (content, node, options) => {
    content = content
      .replace(/^\n+/, "")
      .replace(/\n+$/, "\n")
      .replace(/\n/gm, "\n" + NEST_INDENT);
    let prefix = options.bulletListMarker + " ";
    const parent = node.parentNode;
    if (parent.nodeName === "OL") {
      const start = parent.getAttribute("start");
      const i = Array.prototype.indexOf.call(parent.children, node);
      prefix = (start ? Number(start) + i : i + 1) + ". ";
    }
    return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
  },
});

// Force GFM-standard double-tilde strikethrough — gfm's own rule emits a single
// `~`, which most renderers (including Plume's) don't treat as strikethrough.
// Added AFTER use(gfm) because turndown gives precedence to later-added rules.
td.addRule("strike2", {
  filter: ["del", "s", "strike"],
  replacement: (content) => {
    if (!content) return content;
    const lead = content.match(/^\s*/)[0];
    const trail = content.match(/\s*$/)[0];
    const mid = content.slice(lead.length, content.length - trail.length);
    return mid ? lead + "~~" + mid + "~~" + trail : content;
  },
});

function isBold(el) {
  const w = (el.style && el.style.fontWeight) || "";
  return w === "bold" || w === "bolder" || parseInt(w, 10) >= 600;
}
function isItalic(el) {
  const s = (el.style && el.style.fontStyle) || "";
  return s === "italic" || s === "oblique";
}
function isStrike(el) {
  const d = (el.style && (el.style.textDecorationLine || el.style.textDecoration)) || "";
  return /line-through/.test(d);
}
function unwrap(el) {
  const p = el.parentNode;
  if (!p) return;
  while (el.firstChild) p.insertBefore(el.firstChild, el);
  p.removeChild(el);
}

function normalize(doc) {
  doc.querySelectorAll("style, script, meta, link, title, o\\:p").forEach((e) => e.remove());
  // Drop images we can't resolve (data:/blob:/file:); keep real web images.
  doc.querySelectorAll("img").forEach((img) => {
    if (!/^https?:\/\//i.test(img.getAttribute("src") || "")) img.remove();
  });
  // Neutralize Google Docs' non-bold <b> wrapper so it doesn't bold everything.
  doc.querySelectorAll("b, strong").forEach((el) => {
    const w = (el.style && el.style.fontWeight) || "";
    if (w && !isBold(el)) unwrap(el);
  });
  // Promote style-based emphasis on generic inline elements to semantic tags.
  doc.querySelectorAll("span, font").forEach((el) => {
    const bold = isBold(el), ital = isItalic(el), strike = isStrike(el);
    if (!bold && !ital && !strike) return;
    let node = el;
    const wrap = (tag) => {
      const w = doc.createElement(tag);
      while (node.firstChild) w.appendChild(node.firstChild);
      node.appendChild(w);
      node = w;
    };
    if (strike) wrap("del");
    if (ital) wrap("em");
    if (bold) wrap("strong");
  });
}

// ---- Word "mso-list" fake lists → real <ul>/<ol> ----
// Word emits list items as <p style='...mso-list:lN levelM lfoK'> with the
// bullet/number glyph buried in a <![if !supportLists]>…<![endif]> block (which
// DOMParser turns into bogus comment nodes). We strip that marker, read the
// nesting level, infer ordered vs unordered from the glyph, then rebuild proper
// nested lists so turndown can render them.
function isMsoListItem(p) {
  return p.nodeName === "P" && /mso-list:\s*l\d/i.test(p.getAttribute("style") || "");
}
function msoLevel(p) {
  const m = (p.getAttribute("style") || "").match(/mso-list:[^;"]*level(\d+)/i);
  return m ? parseInt(m[1], 10) : 1;
}
const ORDERED_RE = /^[0-9a-z]{1,3}[.)]|^[ivxlcdm]+[.)]/i;
function stripMsoMarker(p) {
  let ordered = false, found = false, inMarker = false;
  for (const n of [...p.childNodes]) {
    if (n.nodeType === 8) {
      const d = n.data || "";
      if (/supportLists/i.test(d)) { inMarker = true; found = true; n.remove(); continue; }
      if (/endif/i.test(d)) { inMarker = false; n.remove(); continue; }
    }
    if (inMarker) {
      const t = (n.textContent || "").replace(/ /g, " ").trim();
      if (t && ORDERED_RE.test(t)) ordered = true;
      n.remove();
    }
  }
  if (!found) {
    // No conditional-comment marker (some Word exports / pasteboards drop it).
    // Fall back to a leading bullet/number span.
    const first = p.firstElementChild;
    if (first && first.nodeName === "SPAN") {
      const t = (first.textContent || "").replace(/ /g, " ").trim();
      if (/^[•·▪◦‣o*\-]/.test(t) || ORDERED_RE.test(t)) {
        ordered = ORDERED_RE.test(t);
        first.remove();
        found = true;
      }
    }
  }
  return { found, ordered };
}
function buildLists(doc, items) {
  const root = doc.createElement("div");
  const stack = []; // { level, listEl, ordered }
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].level > it.level) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.level < it.level) {
      const listEl = doc.createElement(it.ordered ? "ol" : "ul");
      if (top) (top.listEl.lastElementChild || top.listEl).appendChild(listEl);
      else root.appendChild(listEl);
      top = { level: it.level, listEl, ordered: it.ordered };
      stack.push(top);
    } else if (top.level === it.level && top.ordered !== it.ordered) {
      const listEl = doc.createElement(it.ordered ? "ol" : "ul");
      (top.listEl.parentNode || root).appendChild(listEl);
      top = { level: it.level, listEl, ordered: it.ordered };
      stack[stack.length - 1] = top;
    }
    const li = doc.createElement("li");
    while (it.p.firstChild) li.appendChild(it.p.firstChild);
    top.listEl.appendChild(li);
  }
  return root;
}
function convertMsoLists(doc) {
  const ps = [...doc.querySelectorAll("p")];
  let i = 0;
  while (i < ps.length) {
    if (!isMsoListItem(ps[i])) { i++; continue; }
    const run = [];
    while (i < ps.length && isMsoListItem(ps[i])) run.push(ps[i++]);
    const items = run.map((p) => {
      const level = msoLevel(p);
      const { ordered } = stripMsoMarker(p);
      return { level, ordered, p };
    });
    const listRoot = buildLists(doc, items);
    run[0].parentNode.insertBefore(listRoot, run[0]);
    run.forEach((p) => p.remove());
    while (listRoot.firstChild) listRoot.parentNode.insertBefore(listRoot.firstChild, listRoot);
    listRoot.remove();
  }
}

export function htmlToMarkdown(html) {
  // Strip <!--…--> comments (incl. Word's <!--[if gte mso]>…--> cruft). The
  // single-bracket <![if !supportLists]> list markers aren't <!-- so they survive
  // to DOMParser as comment nodes, where stripMsoMarker() consumes them.
  const cleaned = String(html).replace(/<!--[\s\S]*?-->/g, "");
  const doc = new DOMParser().parseFromString(cleaned, "text/html");
  convertMsoLists(doc);
  normalize(doc);
  let md = td.turndown(doc.body.innerHTML);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

const RICH_RE = /<(h[1-6]|strong|b|em|i|u|s|del|ul|ol|li|blockquote|table|thead|tbody|tr|td|th|pre|code|a\b|img)\b/i;

/** Only convert when the HTML carries real structure/formatting; otherwise let
 *  CodeMirror do its normal plain-text paste (don't mangle plain copies). */
export function looksRich(html) {
  if (!html) return false;
  if (RICH_RE.test(html)) return true;
  return /style=("|')[^"']*(font-weight|font-style|text-decoration)/i.test(html);
}
