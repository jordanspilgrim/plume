import * as esbuild from "esbuild";

const ctx = await esbuild.context({
  entryPoints: ["src/renderer/renderer.js"],
  bundle: true,
  outfile: "dist/renderer.js",
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: true,
  logLevel: "info",
});

if (process.argv.includes("--watch")) {
  await ctx.watch();
  console.log("[esbuild] watching renderer…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
