"use strict";

// Minimal harness for driving bin/plume-mcp.js over stdio in tests, plus a fake
// control-socket server that speaks Plume's newline-JSON protocol. DLB-style: no
// real Plume, no real ports — everything is a temp socket under the test's control.

const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const MCP_BIN = path.join(__dirname, "..", "bin", "plume-mcp.js");

// Spawn the MCP server and expose request(method, params) → Promise<result>.
function startMcp({ env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [MCP_BIN], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg); waiters.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiters.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`timeout: ${method}`)); } }, 5000);
  });
  const callTool = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args || {} });
    return r.content && r.content[0] ? r.content[0].text : "";
  };
  return { child, request, callTool, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

// A fake Plume control server on a private unix socket. `handler(req)` returns the
// response object. Records every request it received in `.received`.
function startFakeSocket(handler) {
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "plume-sock-")), "plume.sock");
  const received = [];
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        received.push(req);
        sock.write(JSON.stringify(handler(req) ?? { ok: true }) + "\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(sockPath, () => resolve({
      sockPath, received,
      stop: () => new Promise((r) => server.close(r)),
    }));
  });
}

module.exports = { startMcp, startFakeSocket };
