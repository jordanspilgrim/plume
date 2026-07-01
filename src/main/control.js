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
// PLUME_SOCK lets a dev/test instance use its own socket; default is the shared one.
const SOCK_PATH = process.env.PLUME_SOCK || path.join(SOCK_DIR, "plume.sock");
const DEV_SOCK_PATH = path.join(SOCK_DIR, "plume-dev.sock");

/**
 * Start the control server. `handlers` maps cmd → (req) => response|Promise.
 *
 * Crucially, this NEVER steals a socket a live Plume already owns. The Electron
 * shell is a dev/test rig that runs alongside the production (Tauri) app; the old
 * unconditional unlink+bind hijacked the production socket, so `plume <file>` got
 * routed here and failed. Now we probe the socket first: a live owner → fall back
 * to a dev socket; a stale socket → clean it and bind.
 */
function startControlServer(handlers) {
  try { fs.mkdirSync(SOCK_DIR, { recursive: true }); } catch { /* ignore */ }

  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 32 * 1024 * 1024) { sock.destroy(); return; } // bound a no-newline flood
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

  // Bind `p`; on EADDRINUSE, probe whether a live owner is listening. If alive,
  // don't steal — fall back to the dev socket (once). If stale/dead, unlink + bind.
  const bind = (p, allowFallback) => {
    server.removeAllListeners("error");
    server.once("error", (err) => {
      if (err && err.code !== "EADDRINUSE") return; // give up, fail soft
      const probe = net.connect(p);
      let settled = false;
      const finish = (live) => {
        if (settled) return; settled = true;
        try { probe.destroy(); } catch { /* ignore */ }
        if (live) {
          if (allowFallback && p !== DEV_SOCK_PATH) bind(DEV_SOCK_PATH, false); // a live Plume owns it
          // else: another dev rig owns even the fallback — fail soft (no control server)
        } else {
          try { fs.unlinkSync(p); } catch { /* ignore */ }
          server.listen(p); // stale socket, safe to reclaim
        }
      };
      probe.setTimeout(600, () => finish(false));
      probe.once("connect", () => finish(true));
      probe.once("error", () => finish(false));
    });
    server.listen(p);
  };
  bind(SOCK_PATH, !process.env.PLUME_SOCK);
  return server;
}

function stopControlServer(server) {
  if (server) { try { server.close(); } catch { /* ignore */ } }
  try { fs.unlinkSync(SOCK_PATH); } catch { /* ignore */ }
}

module.exports = { startControlServer, stopControlServer, SOCK_PATH };
