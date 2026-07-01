"use strict";
// Stage the canonical zero-dependency CLIs into ./bin so `npm publish`/`npm pack`
// ships them. The source of truth stays at repo-root bin/; this copy is generated
// (bin/ is gitignored) so the published package can never drift from the app's CLIs.

const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "..", "bin");
const dst = path.join(__dirname, "bin");
fs.mkdirSync(dst, { recursive: true });

for (const f of ["plume-mcp.js", "plume.js"]) {
  const from = path.join(src, f);
  const to = path.join(dst, f);
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755); // executable — both files carry a `#!/usr/bin/env node` shebang
}

console.log("plume-mcp: staged bin/plume-mcp.js + bin/plume.js for publish");
