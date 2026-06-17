// Assemble the Tauri frontend into build-tauri/: bundle the window.plume bridge,
// copy the (already built) renderer assets, and rewrite index.html to load them
// locally with the bridge injected before the renderer module.

import esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";

rmSync("build-tauri", { recursive: true, force: true });
mkdirSync("build-tauri", { recursive: true });

// Bundle the bridge as a classic IIFE so it runs before the renderer module.
await esbuild.build({
  entryPoints: ["tauri/tauri-bridge.js"],
  bundle: true,
  format: "iife",
  outfile: "build-tauri/bridge.js",
  platform: "browser",
  target: "es2022",
});

// Copy the whole renderer output — esbuild code-splits, so renderer.js imports
// many sibling chunk-*.js files. Skip sourcemaps to keep the bundle lean.
cpSync("dist", "build-tauri", { recursive: true, filter: (src) => !src.endsWith(".map") });
cpSync("src/renderer/styles.css", "build-tauri/styles.css");

// Bundle the Node export sidecar (html-to-docx + gdocs.js) into one standalone
// CJS, dropped where tauri.conf bundles it as a resource.
mkdirSync("src-tauri/sidecar", { recursive: true });
await esbuild.build({
  entryPoints: ["bin/plume-sidecar.js"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "src-tauri/sidecar/plume-sidecar.cjs",
  logLevel: "error",
});

let html = readFileSync("src/renderer/index.html", "utf8");
html = html
  .replace("../../dist/renderer.css", "renderer.css")
  // CSP differs under Tauri; let tauri.conf manage it.
  .replace(/<meta[^>]+Content-Security-Policy[^>]*>/i, "")
  // inject the bridge as a classic script before the renderer module
  .replace(
    '<script type="module" src="../../dist/renderer.js"></script>',
    '<script src="bridge.js"></script>\n    <script type="module" src="renderer.js"></script>'
  );
writeFileSync("build-tauri/index.html", html);

console.log("build-tauri/ assembled");
