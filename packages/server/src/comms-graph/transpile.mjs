/**
 * Transpile the comms-graph modules to plain .js for a runtime with no toolchain.
 *
 * Uses the esbuild that is ALREADY in the repo's node_modules, rather than a
 * hand-rolled regex stripper. The stripper was tried first and threw itself
 * away: it handled `import type`, inline annotations and object types, and then
 * died on a getter's return type (`get size(): number {`). Every rule one adds
 * is a rule one has to be right about, and this job has a real compiler
 * available for free. Use the compiler.
 *
 * Run: node transpile.mjs <srcdir> <outdir>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: transpile.mjs <srcdir> <outdir>");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(src).filter((f) => f.endsWith(".ts"));
await esbuild.build({
  entryPoints: files.map((f) => path.join(src, f)),
  outdir: out,
  format: "esm",
  platform: "node",
  target: "node22",
  bundle: false,
  logLevel: "warning",
});
console.log(`transpiled ${files.length} files -> ${out}`);
