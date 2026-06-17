"use strict";

// Shell-agnostic local control channel.
//
// Plume's main process owns a unix-domain socket at ~/.plume/plume.sock and
// speaks newline-delimited JSON. The `plume` CLI and the MCP server (Wave 2)
// are the clients. Deliberately NOT Electron IPC: a future Tauri/Rust shell can
// serve the exact same socket + protocol, so the CLI and MCP never change.
//
//   request:  {"cmd":"open","path":"/abs/file.md","line":12}\n
//   response: {"ok":true}\n

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SOCK_DIR = path.join(os.homedir(), ".plume");
const SOCK_PATH = path.join(SOCK_DIR, "plume.sock");

/**
 * Start the control server. `handlers` maps cmd → (req) => response|Promise.
 * Returns the net.Server (or null if the socket is already owned by another
 * live instance — single-instance should prevent that, but we fail soft).
 */
function startControlServer(handlers) {
  try { fs.mkdirSync(SOCK_DIR, { recursive: true }); } catch { /* ignore */ }
  try { fs.unlinkSync(SOCK_PATH); } catch { /* no stale socket */ }

  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch {
          sock.write(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
          continue;
        }
        const fn = handlers[req.cmd];
        Promise.resolve()
          .then(() => (fn ? fn(req) : { ok: false, error: `unknown cmd: ${req.cmd}` }))
          .then((res) => sock.write(JSON.stringify(res ?? { ok: true }) + "\n"))
          .catch((err) => sock.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }) + "\n"));
      }
    });
    sock.on("error", () => { /* client vanished */ });
  });

  server.on("error", () => { /* another instance owns it; fail soft */ });
  server.listen(SOCK_PATH);
  return server;
}

function stopControlServer(server) {
  if (server) { try { server.close(); } catch { /* ignore */ } }
  try { fs.unlinkSync(SOCK_PATH); } catch { /* ignore */ }
}

module.exports = { startControlServer, stopControlServer, SOCK_PATH };
