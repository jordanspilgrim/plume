#!/usr/bin/env node
"use strict";

// plume — open files in the Plume editor from your shell / agent.
//
//   plume notes.md                 open (or focus) a file
//   plume report.md --line 42      open and jump to a line
//   plume a.md b.md                open several
//   plume .                        open a folder in the sidebar
//   plume --new draft.md           force a new window
//   plume                          just bring Plume to the front
//
// Talks to a running Plume over ~/.plume/plume.sock (newline-delimited JSON).
// If Plume isn't running, launches it, waits for the socket, then sends.
// Pure Node built-ins — no dependencies, survives the Tauri reshell.

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// Unix domain socket on macOS/Linux; Windows named pipe (matches the Rust side).
const SOCK = process.platform === "win32"
  ? "\\\\.\\pipe\\plume.sock"
  : path.join(os.homedir(), ".plume", "plume.sock");

function sendOnce(reqs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    const out = [];
    let buf = "";
    sock.setTimeout(4000, () => { sock.destroy(); reject(new Error("timeout")); });
    sock.on("connect", () => { for (const r of reqs) sock.write(JSON.stringify(r) + "\n"); });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) out.push(JSON.parse(line));
        if (out.length >= reqs.length) { sock.end(); resolve(out); return; }
      }
    });
    sock.on("error", reject);
  });
}

async function send(reqs) {
  try {
    return await sendOnce(reqs);
  } catch {
    // Not running — launch Plume, poll for the socket, then send.
    if (process.platform === "darwin") spawn("open", ["-a", "Plume"], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", "Plume"], { stdio: "ignore", detached: true }).unref();
    // Linux: rely on Plume already running (launch-by-name varies by DE).
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      try { return await sendOnce(reqs); } catch { /* keep polling */ }
    }
    console.error("plume: couldn't reach Plume. Is Plume.app installed in /Applications?");
    process.exit(1);
  }
}

function help() {
  process.stdout.write(
    "plume — open files in the Plume editor\n\n" +
    "Usage:\n" +
    "  plume <file...>          open or focus files\n" +
    "  plume <file> --line N    open and jump to line N\n" +
    "  plume .                  open a folder in the sidebar\n" +
    "  plume --new <file>       force a new window\n" +
    "  plume                    bring Plume to the front\n\n" +
    "Flags: --new/-n, --line/-l N, --version/-v, --help/-h\n"
  );
}

(async function main() {
  const args = process.argv.slice(2);
  let newWindow = false, line, wantVersion = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--new" || a === "-n") newWindow = true;
    else if (a === "--line" || a === "-l") line = parseInt(args[++i], 10) || undefined;
    else if (a === "--help" || a === "-h") { help(); return; }
    else if (a === "--version" || a === "-v") wantVersion = true;
    else files.push(a);
  }

  if (wantVersion) {
    try { const [r] = await sendOnce([{ cmd: "ping" }]); console.log("Plume " + (r.version || "")); }
    catch { console.log("Plume (not running)"); }
    return;
  }

  if (files.length === 0) { await send([{ cmd: "focus" }]); return; }

  const reqs = files.map((f) => {
    const abs = path.resolve(process.cwd(), f);
    let dir = false;
    try { dir = fs.statSync(abs).isDirectory(); } catch { /* maybe a new file */ }
    return dir ? { cmd: "open", dir: abs } : { cmd: "open", path: abs, line, newWindow };
  });
  await send(reqs);
})();
