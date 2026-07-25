#!/usr/bin/env node
"use strict";

// Node sidecar for the Tauri build: handles the two export paths that reuse
// existing verified Node code (html-to-docx, gdocs.js) rather than reimplement
// them in Rust. esbuild-bundled into a single standalone CJS (dist-sidecar/
// plume-sidecar.cjs), spawned by the Rust side. Reads a JSON request as argv[2],
// prints a JSON result.
//
//   {cmd:"docx", html, out}                 -> writes a .docx, prints {ok,path}
//   {cmd:"gdocs", markdown, defaultName}    -> publishes, prints {ok,url}

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const HTMLtoDOCX = require("html-to-docx");
const { publishToGoogleDocs } = require("../src/main/gdocs.js");

function done(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }

// Watchdog: a sidecar invocation must never outlive its caller as an orphan —
// even if the parent forgets to reap it or the OAuth consent tab is abandoned.
// gdocs allows for the 5-minute consent window (gdocs.js OAUTH_TIMEOUT_MS) plus
// network headroom; everything else is mechanical and bounded tightly.
const WATCHDOG_MS = { docx: 2 * 60_000, gdocs: 7 * 60_000 };
let watchdog = setTimeout(timeoutExit, WATCHDOG_MS.gdocs);
function timeoutExit() { done({ ok: false, error: "sidecar timed out", code: "SIDECAR_TIMEOUT" }); }

function readStdin(timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let d = ""; process.stdin.setEncoding("utf8");
    // If the caller never writes/closes stdin, give up with what we have.
    const t = setTimeout(() => resolve(d), timeoutMs);
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => { clearTimeout(t); resolve(d); });
  });
}

(async () => {
  // request via argv[2] (small) or stdin (large HTML)
  const raw = process.argv[2] || (await readStdin());
  let req;
  try { req = JSON.parse(raw || "{}"); } catch { done({ ok: false, error: "bad request" }); }

  if (WATCHDOG_MS[req.cmd] && WATCHDOG_MS[req.cmd] !== WATCHDOG_MS.gdocs) {
    clearTimeout(watchdog);
    watchdog = setTimeout(timeoutExit, WATCHDOG_MS[req.cmd]);
  }

  if (req.cmd === "docx") {
    try {
      const buf = await HTMLtoDOCX(req.html || "");
      fs.writeFileSync(req.out, Buffer.from(buf));
      done({ ok: true, path: req.out });
    } catch (e) { done({ ok: false, error: String(e.message || e) }); }
  } else if (req.cmd === "gdocs") {
    try {
      const url = await publishToGoogleDocs(
        req.markdown || "",
        req.defaultName,
        (u) => { try { spawn("open", [u], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ } }
      );
      done({ ok: true, url });
    } catch (e) { done({ ok: false, error: String(e.message || e), code: e.code || null }); }
  } else {
    done({ ok: false, error: "unknown cmd" });
  }
})();
