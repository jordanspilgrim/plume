"use strict";

// Unit tests for the write_document containment helpers (P0-1). These are pure
// and need neither a running Plume nor the stdio server.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { refuseWrite, withinDir, canonicalize } = require("../bin/plume-mcp.js");

// A real temp workspace so canonicalize() (which realpaths the existing portion)
// behaves like production. On macOS, /tmp and /var symlink — realpath matters.
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plume-ws-")));

test("withinDir: child path is inside", () => {
  assert.equal(withinDir(path.join(WS, "a", "b.md"), WS), true);
});

test("withinDir: the dir itself counts as inside", () => {
  assert.equal(withinDir(WS, WS), true);
});

test("withinDir: sibling/parent path is outside", () => {
  assert.equal(withinDir(path.join(WS, "..", "evil.md"), WS), false);
  assert.equal(withinDir("/etc/passwd", WS), false);
});

test("refuseWrite: allows a new file inside the workspace", () => {
  assert.equal(refuseWrite(path.join(WS, "draft.md"), WS), null);
});

test("refuseWrite: allows a nested new file inside the workspace", () => {
  assert.equal(refuseWrite(path.join(WS, "deep", "nested", "x.md"), WS), null);
});

test("refuseWrite: refuses an absolute path outside the workspace", () => {
  const r = refuseWrite(path.join(os.homedir(), ".ssh", "authorized_keys"), WS);
  assert.equal(typeof r, "string");
  assert.match(r, /Refused/);
});

test("refuseWrite: refuses a ../ escape even though it textually starts with WS", () => {
  const escape = path.join(WS, "..", "outside.md");
  assert.equal(typeof refuseWrite(escape, WS), "string");
});

test("refuseWrite: allows an out-of-workspace path that is open in Plume", () => {
  const openFile = path.join(os.homedir(), "Documents", "open-doc.md");
  assert.equal(refuseWrite(openFile, WS, [openFile]), null);
});

test("refuseWrite: a symlink pointing outside the workspace is refused", () => {
  const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plume-out-")));
  const link = path.join(WS, "sneaky");
  try { fs.symlinkSync(outsideDir, link); } catch { return; } // skip if symlink unsupported
  // A write "inside" the symlinked dir really lands outside WS — must be refused.
  assert.equal(typeof refuseWrite(path.join(link, "x.md"), WS), "string");
});

test("canonicalize: resolves an existing file through realpath", () => {
  const f = path.join(WS, "real.md");
  fs.writeFileSync(f, "hi");
  assert.equal(canonicalize(f), fs.realpathSync(f));
});
