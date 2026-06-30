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

// Handshake token Plume writes to ~/.plume/token (0600). Read per send so a
// freshly-launched Plume's token is picked up. PLUME_TOKEN overrides for tests.
function authToken() {
  if (process.env.PLUME_TOKEN !== undefined) return process.env.PLUME_TOKEN;
  try { return fs.readFileSync(path.join(os.homedir(), ".plume", "token"), "utf8").trim(); }
  catch { return ""; }
}

function sendOnce(reqs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    const out = [];
    let buf = "";
    const token = authToken();
    sock.setTimeout(4000, () => { sock.destroy(); reject(new Error("timeout")); });
    sock.on("connect", () => { for (const r of reqs) sock.write(JSON.stringify({ ...r, token }) + "\n"); });
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

// 8-bit Plume wordmark, periwinkle→indigo gradient to match the brand feather.
// Color only when stdout is a TTY, so piping/redirecting stays clean.
const BANNER_ART = [
  "██████╗ ██╗     ██╗   ██╗███╗   ███╗███████╗",
  "██╔══██╗██║     ██║   ██║████╗ ████║██╔════╝",
  "██████╔╝██║     ██║   ██║██╔████╔██║█████╗  ",
  "██╔═══╝ ██║     ██║   ██║██║╚██╔╝██║██╔══╝  ",
  "██║     ███████╗╚██████╔╝██║ ╚═╝ ██║███████╗",
  "╚═╝     ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝",
];
const BANNER_GRAD = [147, 111, 105, 99, 63, 57];
function banner(tagline) {
  const tty = process.stdout.isTTY;
  const paint = (s, c) => (tty ? `\x1b[38;5;${c}m${s}\x1b[0m` : s);
  const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const art = BANNER_ART.map((l, i) => "  " + paint(l, BANNER_GRAD[i] || 105)).join("\n");
  return "\n" + art + "\n\n  " + dim(tagline) + "\n";
}

function help() {
  process.stdout.write(
    banner("the human pane for agentic coding") + "\n" +
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
    if (process.stdout.isTTY) process.stdout.write(banner("the human pane for agentic coding") + "\n");
    try { const [r] = await sendOnce([{ cmd: "ping" }]); console.log("  Plume " + (r.version || "")); }
    catch { console.log("  Plume (not running)"); }
    return;
  }

  if (files.length === 0) { await send([{ cmd: "focus" }]); return; }

  const reqs = files.map((f, idx) => {
    const abs = path.resolve(process.cwd(), f);
    let dir = false;
    try { dir = fs.statSync(abs).isDirectory(); } catch { /* maybe a new file */ }
    // Plume is one-doc-per-window, so several files open in several windows: the
    // first reuses the focused window (unless --new), the rest force new windows.
    // Otherwise each `open` replaces the previous in the same window.
    const win = newWindow || idx > 0;
    return dir ? { cmd: "open", dir: abs } : { cmd: "open", path: abs, line, newWindow: win };
  });
  await send(reqs);
})();
