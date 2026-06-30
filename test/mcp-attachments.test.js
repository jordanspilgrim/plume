"use strict";

// get_attachments quarantine behavior (P2-7): a malformed push must NOT be silently
// unlinked — it's moved to .bad/ so a corrupt write is recoverable, while good
// records are still consumed.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMcp } = require("./helpers.js");

test("good records are returned + consumed; malformed ones are quarantined", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plume-attach-"));
  fs.writeFileSync(path.join(dir, "01-good.json"), JSON.stringify({ name: "ok.md", pushedAt: 1, content: "# Hello" }));
  fs.writeFileSync(path.join(dir, "02-bad.json"), "{ this is not valid json ");

  const mcp = startMcp({ env: { PLUME_ATTACH_DIR: dir } });
  let out;
  try {
    out = await mcp.callTool("get_attachments", {});
  } finally { mcp.stop(); }

  const parsed = JSON.parse(out);
  // With a quarantine, the shape is { attachments, warning }.
  assert.ok(parsed.warning, "warns about the malformed record");
  assert.match(parsed.warning, /\.bad/);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].content, "# Hello");

  // Good one consumed, bad one preserved under .bad/ — nothing lost.
  assert.equal(fs.existsSync(path.join(dir, "01-good.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "02-bad.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".bad", "02-bad.json")), true);
});

test("empty bucket reports nothing pending", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plume-attach-"));
  const mcp = startMcp({ env: { PLUME_ATTACH_DIR: dir } });
  try {
    const out = await mcp.callTool("get_attachments", {});
    assert.match(out, /No pending attachments/);
  } finally { mcp.stop(); }
});
