"use strict";

// Protocol smoke test (P2-8): the hand-rolled MCP server is pinned to a specific
// protocol version and tool set. If either drifts, this fails — the version-bump
// checklist (SECURITY.md / docs) points here. No Plume required.

const { test } = require("node:test");
const assert = require("node:assert");
const { startMcp } = require("./helpers.js");
const { PROTOCOL_VERSION, TOOLS } = require("../bin/plume-mcp.js");

const EXPECTED_TOOLS = [
  "open_in_plume", "get_active_document", "get_selection", "list_open_files",
  "get_annotations", "write_document", "get_attachments",
];

test("initialize returns the pinned protocol version + serverInfo", async () => {
  const mcp = startMcp();
  try {
    const r = await mcp.request("initialize", {});
    assert.equal(r.protocolVersion, PROTOCOL_VERSION);
    assert.equal(r.protocolVersion, "2024-11-05");
    assert.equal(r.serverInfo.name, "plume");
    assert.ok(r.capabilities.tools, "advertises tools capability");
  } finally { mcp.stop(); }
});

test("tools/list exposes exactly the expected 7 tools", async () => {
  const mcp = startMcp();
  try {
    const r = await mcp.request("tools/list", {});
    const names = r.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
    for (const t of r.tools) {
      assert.ok(t.description && t.inputSchema, `${t.name} has description + schema`);
    }
  } finally { mcp.stop(); }
});

test("the exported TOOLS table matches the wire tools/list", () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
});

test("unknown method gets a JSON-RPC method-not-found error", async () => {
  const mcp = startMcp();
  try {
    await assert.rejects(() => mcp.request("does/not/exist", {}), /Method not found/);
  } finally { mcp.stop(); }
});
