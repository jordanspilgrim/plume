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

function readStdin() {
  return new Promise((resolve) => {
    let d = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
  });
}

(async () => {
  // request via argv[2] (small) or stdin (large HTML)
  const raw = process.argv[2] || (await readStdin());
  let req;
  try { req = JSON.parse(raw || "{}"); } catch { done({ ok: false, error: "bad request" }); }

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
