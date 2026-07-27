"use strict";

// Export-HTML hardening for the docx sidecar path.
//
// html-to-docx walks <img> tags and FETCHES any http(s) src (twice per image,
// following redirects) to embed the bytes. On a document you didn't write,
// `![](http://169.254.169.254/…)` turns "Export to Word" into a blind SSRF
// whose response gets baked into the file you then share back.
//
// The POLICY layer — which remote images may be inlined — lives in Rust, which
// resolves each host once through the vetted-address guard, refuses redirects,
// and hands the sidecar data: URIs (or drops the image to its alt text). This
// module is the categorical backstop underneath it: whatever reaches the
// converter, anything that isn't already a data: URI is reduced to alt text.
//
// Tag and attribute scanning is done with a small tokenizer rather than
// `<img[^>]*>` + per-attribute regexes on purpose. Both shortcuts terminate at
// the first `>` (or match an `attr=` sequence) INSIDE a quoted value, which
// creates a parser differential: a crafted alt like
//   <img alt="<img src=data:image/png;base64,AAA>" src="http://attacker/x.png">
// reads as "already a data: URI, leave it alone" to a naive matcher while the
// converter's real parser sees — and fetches — the remote src. Quoted values
// are consumed atomically here so the two agree.

// Split a tag's attributes into a map. First occurrence wins, matching how
// HTML parsers resolve duplicate attributes.
function parseAttrs(tag) {
  const attrs = Object.create(null);
  // Skip `<img` (or any tag name); stop before the closing `>`.
  let i = tag.search(/\s/);
  if (i < 0) return attrs;
  const end = tag.length - 1; // the trailing '>'
  while (i < end) {
    const ch = tag[i];
    if (/\s/.test(ch) || ch === "/") { i++; continue; }
    let name = "";
    while (i < end && !/[\s=/>]/.test(tag[i])) name += tag[i++];
    if (!name) { i++; continue; }
    while (i < end && /\s/.test(tag[i])) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < end && /\s/.test(tag[i])) i++;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        i++;
        while (i < end && tag[i] !== quote) value += tag[i++];
        i++; // closing quote
      } else {
        while (i < end && !/[\s>]/.test(tag[i])) value += tag[i++];
      }
    }
    const key = name.toLowerCase();
    if (!(key in attrs)) attrs[key] = value;
  }
  return attrs;
}

function escapeText(s) {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}

// Matches a whole <img> tag, consuming quoted attribute values atomically so a
// `>` inside a value can't end the match early.
const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

// Reduce every <img> that isn't a data: URI to its alt text. Fail-closed on the
// raw attribute text: an entity-encoded or otherwise obfuscated src doesn't
// read as `data:` here and is therefore stripped, which is the safe direction.
function stripRemoteImages(html) {
  return String(html).replace(IMG_TAG, (tag) => {
    const attrs = parseAttrs(tag);
    if (/^data:/i.test((attrs.src || "").trim())) return tag;
    const alt = attrs.alt || "";
    return alt ? escapeText(alt) : "";
  });
}

module.exports = { stripRemoteImages, parseAttrs };
