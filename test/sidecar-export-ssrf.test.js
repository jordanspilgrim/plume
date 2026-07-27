"use strict";

// Export SSRF (adversarial re-run HIGH): html-to-docx fetches every remote
// <img src> — twice per image, following redirects — and embeds the bytes.
// `![](http://169.254.169.254/…)` in a document you didn't write turned
// "Export to Word" into a blind SSRF whose response landed in the file you
// then shared back.
//
// Rust owns the policy (resolve once through the vetted-address guard, no
// redirects, inline as data: or drop to alt). These tests cover the sidecar's
// categorical backstop: whatever HTML arrives, the docx path must make ZERO
// network requests. They spawn the REAL sidecar and point every hostile src at
// a local listener that records hits — if the gate regresses, the listener
// sees traffic and the test fails.

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { stripRemoteImages } = require("../src/main/export-html.js");

const SIDECAR = path.join(__dirname, "..", "bin", "plume-sidecar.js");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const DATA_URI = "data:image/png;base64," + PNG.toString("base64");

// Listener that records every request and 302s /redirect → /final.png, so a
// followed redirect is distinguishable from a direct fetch.
function startListener() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith("/redirect")) {
      res.writeHead(302, { Location: "/final.png" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(PNG);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ hits, port: server.address().port, close: () => server.close() })
    );
  });
}

function runSidecar(request) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SIDECAR],
      { timeout: 60_000 },
      (err, stdout) => resolve({ err, stdout })
    );
    child.stdin.end(JSON.stringify(request));
  });
}

async function exportDocx(html) {
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "plume-ssrf-test-")),
    "out.docx"
  );
  const { stdout } = await runSidecar({ cmd: "docx", html, out });
  let result = null;
  try { result = JSON.parse(stdout); } catch { /* surfaced by the assertion */ }
  return { result, out, stdout };
}

test("docx export makes NO network request for hostile <img> srcs", async () => {
  const l = await startListener();
  try {
    const b = `http://127.0.0.1:${l.port}`;
    const html = `<html><body>
      <h1>Report</h1>
      <img src="${b}/imds.png" alt="direct http">
      <img src="${b}/redirect" alt="redirecting">
      <img src='${b}/single-quoted.png' alt='single quoted'>
      <img src=${b}/unquoted.png alt=unquoted>
      <img SRC="${b}/uppercase-attr.png" ALT="uppercase">
      <img src="//127.0.0.1:${l.port}/protocol-relative.png" alt="protocol relative">
      <img src="${b}/no-alt.png">
      <p>body text</p>
    </body></html>`;

    const { result, out } = await exportDocx(html);
    assert.ok(result && result.ok === true, `export should succeed, got ${JSON.stringify(result)}`);
    assert.deepEqual(l.hits, [], "sidecar must not have fetched anything");
    assert.ok(fs.statSync(out).size > 0, "a real .docx was produced");
  } finally { l.close(); }
});

test("a data: image still embeds (the Rust-inlined happy path keeps working)", async () => {
  const l = await startListener();
  try {
    const html = `<html><body><h1>Hi</h1><img src="${DATA_URI}" alt="inline"><p>text</p></body></html>`;
    const { result, out } = await exportDocx(html);
    assert.ok(result && result.ok === true, "export should succeed");
    assert.deepEqual(l.hits, [], "no network for a data: URI either");
    // A docx is a zip; the embedded PNG lands in word/media/.
    const bytes = fs.readFileSync(out);
    assert.ok(bytes.length > 0);
    assert.ok(bytes.includes(Buffer.from("word/media/")), "image was embedded, not dropped");
  } finally { l.close(); }
});

test("gdocs publish carries alt text only — never fetches image bytes", async () => {
  // Confirms the third export path is not exposed (be-dev's fact #1, verified
  // independently here): with no credentials the publish stops at NO_CREDS, and
  // markdownToDocsRequests turns ![alt](url) into alt text, so nothing is fetched.
  const l = await startListener();
  try {
    const markdown = `# Title\n\n![the alt text](http://127.0.0.1:${l.port}/gdocs-probe.png)\n`;
    const { stdout } = await runSidecar({ cmd: "gdocs", markdown, defaultName: "t" });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.code, "NO_CREDS", "stops at credentials, before any Google call");
    assert.deepEqual(l.hits, [], "no image fetch on the publish path");

    const { markdownToDocsRequests } = require("../src/main/gdocs.js");
    const { requests } = markdownToDocsRequests(markdown);
    const inserted = requests.find((r) => r.insertText)?.insertText.text || "";
    assert.match(inserted, /the alt text/, "image becomes its alt text");
    assert.doesNotMatch(inserted, /gdocs-probe\.png/, "the URL is not carried into the doc");
  } finally { l.close(); }
});

test("stripRemoteImages: keeps data:, reduces everything else to alt text", () => {
  assert.equal(
    stripRemoteImages(`<img src="${DATA_URI}" alt="keep">`),
    `<img src="${DATA_URI}" alt="keep">`,
    "data: URIs pass through untouched"
  );
  assert.equal(stripRemoteImages('<img src="http://x/a.png" alt="Chart">'), "Chart");
  assert.equal(stripRemoteImages('<img src="https://x/a.png" alt="Chart">'), "Chart");
  assert.equal(stripRemoteImages('<img src="//x/a.png" alt="Chart">'), "Chart");
  assert.equal(stripRemoteImages('<img src="file:///etc/passwd" alt="local">'), "local");
  assert.equal(stripRemoteImages("<img src=http://x/a.png>"), "", "no alt → nothing left");
  assert.equal(stripRemoteImages("<IMG SRC='http://x/a.png' ALT='Up'>"), "Up", "case-insensitive");
  assert.equal(
    stripRemoteImages('<img src="  data:image/png;base64,AAA" alt="x">'),
    '<img src="  data:image/png;base64,AAA" alt="x">',
    "leading whitespace in a data: src still counts as data:"
  );
  // Fail-closed: an obfuscated src doesn't read as data: here, so it's stripped.
  assert.equal(stripRemoteImages('<img src="&#100;ata:image/png;base64,AAA" alt="sneaky">'), "sneaky");
  // A crafted alt can't inject markup when it replaces the tag.
  assert.equal(
    stripRemoteImages('<img src="http://x/a.png" alt="<script>alert(1)</script>">'),
    "&lt;script&gt;alert(1)&lt;/script&gt;"
  );
  // Surrounding content is preserved.
  assert.equal(
    stripRemoteImages('<p>before</p><img src="http://x/a.png" alt="mid"><p>after</p>'),
    "<p>before</p>mid<p>after</p>"
  );
});

test("stripRemoteImages: no parser differential via quoted attribute values", () => {
  // A `>` inside a quoted value must not end the tag early, and a fake
  // `src=data:` hidden inside another attribute must not make the REAL remote
  // src look safe. A naive <img[^>]*> matcher passes both of these through.
  const smuggled = '<img alt="<img src=data:image/png;base64,AAA>" src="http://attacker/x.png">';
  assert.equal(
    stripRemoteImages(smuggled),
    "&lt;img src=data:image/png;base64,AAA&gt;",
    "the real remote src is stripped, not shielded by the crafted alt"
  );
  assert.doesNotMatch(stripRemoteImages(smuggled), /attacker/, "no remote URL survives");

  // Same shape with single quotes, and with the decoy after the real src.
  assert.doesNotMatch(
    stripRemoteImages(`<img src='http://attacker/y.png' title='src=data:image/png;base64,AAA>'>`),
    /attacker/
  );
  // Duplicate src: first wins for HTML parsers, so a trailing data: decoy
  // must not rescue a leading remote src.
  assert.doesNotMatch(
    stripRemoteImages('<img src="http://attacker/z.png" src="data:image/png;base64,AAA" alt="dup">'),
    /attacker/
  );
  // ...and the reverse ordering keeps a genuinely-inlined image.
  assert.match(
    stripRemoteImages('<img src="data:image/png;base64,AAA" src="http://attacker/z.png" alt="dup">'),
    /^<img /,
    "leading data: src is honored (first-attribute-wins, same as the parser)"
  );
});
