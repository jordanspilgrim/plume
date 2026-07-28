"use strict";

// Per-document settings via front matter. A leading `---` fence at the very top
// of the document, then `key: value` lines, then a closing `---`. Only a small
// whitelist of presentation settings is honored; everything else is ignored.
//
// This is a deliberately tiny line parser, not a YAML engine. The app carries
// @codemirror/lang-yaml for *highlighting* only, and the surface here is a
// handful of scalars, so a full YAML dependency would be over-engineering.
//
// CommonJS (unlike its ESM editor/ siblings) so `node --test` can require() it
// directly, matching the src/main/gdocs.js pattern; esbuild bundles it into the
// ESM renderer through its CJS interop.

const FONT_IDS = ["inter", "system", "newyork", "charter", "iowan", "mono"];
const THEMES = ["system", "light", "dark"];
const MAX_SCAN_BYTES = 4096;
const MAX_SCAN_LINES = 50;

function stripQuotes(s) {
  const m = /^(['"])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : s;
}

function parseBool(v) {
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0") return false;
  return null;
}

// parseFrontMatter(text) -> { settings, endLine } | null
//   settings: validated subset of { theme, font, wide, focus }
//   endLine:  0-based index of the closing `---` line (for styling the block)
//
// Matches ONLY when the opening `---` is the document's very first line
// (offset 0). A `---` after any content is a setext heading underline or a
// thematic break, never front matter, so those are left to the markdown
// renderer. An unclosed fence is likewise not front matter (it stays an <hr>).
function parseFrontMatter(text) {
  if (typeof text !== "string" || text.length < 7) return null; // min "---\n---"
  const scan = text.slice(0, MAX_SCAN_BYTES);
  const lines = scan.split("\n");
  // Opening fence must be the first line, exactly `---` (trailing spaces ok, no
  // indentation). Rejects "----", "  ---", a leading blank line, and a BOM.
  if (lines[0].replace(/\r$/, "").trimEnd() !== "---") return null;

  const settings = {};
  let endLine = -1;
  const limit = Math.min(lines.length, MAX_SCAN_LINES + 1);
  for (let i = 1; i < limit; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trimEnd() === "---") { endLine = i; break; }
    // A recognized setting must be a top-level scalar. An indented line is
    // nested YAML (e.g. `author:\n  theme: dark`) or block-scalar content, so it
    // is never a Plume setting — skip it rather than read the nested key.
    if (/^[ \t]/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // blank line, comment, or no key before the colon
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = stripQuotes(line.slice(colon + 1).trim()).toLowerCase();
    if (!key) continue;
    if (key === "theme") { if (THEMES.includes(val)) settings.theme = val; }
    else if (key === "font") { if (FONT_IDS.includes(val)) settings.font = val; }
    else if (key === "width") { if (val === "wide") settings.wide = true; else if (val === "narrow") settings.wide = false; }
    else if (key === "focus") { const b = parseBool(val); if (b !== null) settings.focus = b; }
    // unknown keys are ignored on purpose
  }
  if (endLine === -1) return null; // unclosed fence => not front matter
  return { settings, endLine };
}

// Remove a leading front-matter block so it never reaches copy/export HTML
// (Plume settings are not document content, and MarkdownIt would otherwise
// render the fences as an <hr> plus a setext <h2>). Returns the text unchanged
// when there is no front matter.
function stripFrontMatter(text) {
  const fm = parseFrontMatter(text);
  if (!fm) return text;
  const rest = text.split("\n").slice(fm.endLine + 1).join("\n");
  return rest.replace(/^\n+/, ""); // drop blank lines left where the block was
}

module.exports = { parseFrontMatter, stripFrontMatter, FONT_IDS, THEMES };
