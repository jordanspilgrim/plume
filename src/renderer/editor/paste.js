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

export function htmlToMarkdown(html) {
  const cleaned = String(html).replace(/<!--[\s\S]*?-->/g, "");
  const doc = new DOMParser().parseFromString(cleaned, "text/html");
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
