"use strict";

// Contract tests for the connected layer (P2-9): the MCP server talking to a fake
// Plume over the control socket. Verifies the wire shape (cmd names, the `root`
// field that powers the Rust backstop) and that containment + structured error
// codes are honored end-to-end through the real stdio loop.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMcp, startFakeSocket } = require("./helpers.js");

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plume-cwd-")));

test("open_in_plume relays an `open` command and reports success", async () => {
  const fake = await startFakeSocket(() => ({ ok: true }));
  const mcp = startMcp({ env: { PLUME_SOCK: fake.sockPath }, cwd: WS });
  try {
    const out = await mcp.callTool("open_in_plume", { path: path.join(WS, "a.md"), line: 3 });
    assert.match(out, /Opened/);
    const open = fake.received.find((r) => r.cmd === "open");
    assert.ok(open, "fake Plume received an open command");
    assert.equal(open.line, 3);
  } finally { mcp.stop(); await fake.stop(); }
});

test("write_document inside the workspace reaches Plume WITH a root field", async () => {
  const written = [];
  const fake = await startFakeSocket((req) => {
    if (req.cmd === "listOpenFiles") return { ok: true, files: [] };
    if (req.cmd === "writeDocument") { written.push(req); return { ok: true, path: req.path }; }
    return { ok: true };
  });
  const mcp = startMcp({ env: { PLUME_SOCK: fake.sockPath }, cwd: WS });
  try {
    const target = path.join(WS, "draft.md");
    const out = await mcp.callTool("write_document", { path: target, content: "hi" });
    assert.match(out, /Wrote/);
    assert.equal(written.length, 1);
    // The Rust backstop relies on this field — its absence would weaken containment.
    assert.equal(written[0].root, WS, "writeDocument carries the workspace root");
    assert.equal(written[0].content, "hi");
  } finally { mcp.stop(); await fake.stop(); }
});

test("write_document OUTSIDE the workspace is refused before touching the socket", async () => {
  let hitWrite = false;
  const fake = await startFakeSocket((req) => {
    if (req.cmd === "listOpenFiles") return { ok: true, files: [] };
    if (req.cmd === "writeDocument") { hitWrite = true; return { ok: true }; }
    return { ok: true };
  });
  const mcp = startMcp({ env: { PLUME_SOCK: fake.sockPath }, cwd: WS });
  try {
    const evil = path.join(os.homedir(), ".ssh", "authorized_keys");
    const out = await mcp.callTool("write_document", { path: evil, content: "pwned" });
    assert.match(out, /Refused/);
    assert.equal(hitWrite, false, "the write never reached Plume");
  } finally { mcp.stop(); await fake.stop(); }
});

test("a dirty_conflict from Plume surfaces as a clear, actionable message", async () => {
  const fake = await startFakeSocket((req) => {
    if (req.cmd === "listOpenFiles") return { ok: true, files: [] };
    if (req.cmd === "writeDocument") return { ok: false, code: "dirty_conflict", error: "unsaved" };
    return { ok: true };
  });
  const mcp = startMcp({ env: { PLUME_SOCK: fake.sockPath }, cwd: WS });
  try {
    const out = await mcp.callTool("write_document", { path: path.join(WS, "x.md"), content: "y" });
    assert.match(out, /unsaved changes/);
    assert.match(out, /save or discard/);
  } finally { mcp.stop(); await fake.stop(); }
});

test("get_active_document round-trips through the socket", async () => {
  const fake = await startFakeSocket((req) => {
    if (req.cmd === "getActiveDocument") return { ok: true, path: "/p.md", mode: "md", dirty: false, content: "# Hi" };
    return { ok: true };
  });
  const mcp = startMcp({ env: { PLUME_SOCK: fake.sockPath }, cwd: WS });
  try {
    const out = await mcp.callTool("get_active_document", {});
    assert.match(out, /# Hi/);
  } finally { mcp.stop(); await fake.stop(); }
});
