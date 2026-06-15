import * as esbuild from "esbuild";

const ctx = await esbuild.context({
  entryPoints: ["src/renderer/renderer.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "renderer",
  format: "esm",
  splitting: true,
  platform: "browser",
  target: ["chrome120"],
  sourcemap: true,
  logLevel: "info",
  // KaTeX ships its fonts as CSS url() refs; inline them as data: URIs so they
  // load under the file:// CSP (font-src 'self' data:) with no path juggling.
  loader: {
    ".woff2": "dataurl",
    ".woff": "dataurl",
    ".ttf": "dataurl",
  },
});

if (process.argv.includes("--watch")) {
  await ctx.watch();
  console.log("[esbuild] watching renderer…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
