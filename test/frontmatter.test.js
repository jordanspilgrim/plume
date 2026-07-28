"use strict";

// parseFrontMatter is the gate for per-document settings: it must honor a
// leading `---` fence ONLY at document offset 0 (so an ordinary thematic break
// or a setext H2 mid-document never hijacks the whole doc), validate every
// value against a whitelist, and refuse an unclosed fence (which stays an <hr>).

const { test } = require("node:test");
const assert = require("node:assert");
const { parseFrontMatter } = require("../src/renderer/editor/frontmatter.js");

test("full valid block: every supported key", () => {
  const r = parseFrontMatter("---\ntheme: dark\nfont: mono\nwidth: wide\nfocus: true\n---\n# Body");
  assert.ok(r);
  assert.deepStrictEqual(r.settings, { theme: "dark", font: "mono", wide: true, focus: true });
  assert.strictEqual(r.endLine, 5);
});

test("empty block: no settings, endLine at the closing fence", () => {
  const r = parseFrontMatter("---\n---\nhi");
  assert.ok(r);
  assert.deepStrictEqual(r.settings, {});
  assert.strictEqual(r.endLine, 1);
});

test("unclosed fence => null (stays an hr)", () => {
  assert.strictEqual(parseFrontMatter("---\ntheme: dark\nno closing fence here"), null);
});

test("`---` not at offset 0 is never front matter (setext H2)", () => {
  assert.strictEqual(parseFrontMatter("A heading\n---\nbody"), null);
  assert.strictEqual(parseFrontMatter("# Title\n\n---\ntheme: dark\n---"), null);
  assert.strictEqual(parseFrontMatter("\n---\ntheme: dark\n---"), null); // leading blank line
});

test("four dashes / indentation are rejected", () => {
  assert.strictEqual(parseFrontMatter("----\ntheme: dark\n----"), null);
  assert.strictEqual(parseFrontMatter("  ---\ntheme: dark\n  ---"), null);
});

test("unknown keys are ignored", () => {
  const r = parseFrontMatter("---\nauthor: Gabriel\ntitle: Notes\ntheme: light\n---");
  assert.deepStrictEqual(r.settings, { theme: "light" });
});

test("invalid values are ignored, valid siblings kept", () => {
  const r = parseFrontMatter("---\ntheme: purple\nfont: comic\nwidth: medium\nfocus: maybe\n---");
  assert.deepStrictEqual(r.settings, {});
});

test("quoted values are unwrapped", () => {
  const r = parseFrontMatter('---\ntheme: "dark"\nfont: \'newyork\'\n---');
  assert.deepStrictEqual(r.settings, { theme: "dark", font: "newyork" });
});

test("width maps to a wide boolean both ways", () => {
  assert.strictEqual(parseFrontMatter("---\nwidth: wide\n---").settings.wide, true);
  assert.strictEqual(parseFrontMatter("---\nwidth: narrow\n---").settings.wide, false);
});

test("focus accepts the usual truthy/falsy spellings", () => {
  assert.strictEqual(parseFrontMatter("---\nfocus: yes\n---").settings.focus, true);
  assert.strictEqual(parseFrontMatter("---\nfocus: off\n---").settings.focus, false);
});

test("CRLF line endings and trailing spaces are tolerated", () => {
  const r = parseFrontMatter("---  \r\ntheme:  dark  \r\n---\r\nbody");
  assert.ok(r);
  assert.deepStrictEqual(r.settings, { theme: "dark" });
  assert.strictEqual(r.endLine, 2);
});

test("case-insensitive keys and values", () => {
  const r = parseFrontMatter("---\nTheme: DARK\nFONT: Mono\n---");
  assert.deepStrictEqual(r.settings, { theme: "dark", font: "mono" });
});

test("non-string and tiny inputs => null", () => {
  assert.strictEqual(parseFrontMatter(null), null);
  assert.strictEqual(parseFrontMatter(""), null);
  assert.strictEqual(parseFrontMatter("---"), null);
});
