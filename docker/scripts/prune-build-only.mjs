#!/usr/bin/env node
// Usage: node docker/scripts/prune-build-only.mjs <app-root> [--dry-run]
//
// Runtime-image prune (docker/Dockerfile stage `prod-deps`, see
// docs/runtime-image.md). Runs AFTER `pnpm install --prod` + the client build.
//
// `pnpm install --prod` already drops every devDependency. What it cannot drop
// are build tools that a workspace declares as a regular dependency on purpose:
// packages/client lists vite, @vitejs/plugin-react and @tailwindcss/vite under
// `dependencies` so a git install with `--omit=dev` can still run the client
// `prepare` build (scripts/verify-release-deps.mjs enforces that). Once the
// client is built to packages/client/dist (static files), nothing at runtime
// loads them. packages/dashboard-plugin-runtime names vite as a peer for its
// build-time Vite plugin; that edge is cut too (see BUILD_ONLY).
//
// This script removes exactly the packages that are reachable ONLY through
// those build-only edges, using Node's own resolution over the real (hoisted)
// node_modules tree:
//   FULL = everything reachable from every workspace manifest's
//          dependencies/optionalDependencies/peerDependencies
//   KEEP = the same walk with the BUILD_ONLY edges cut
//   delete FULL \ KEEP
// Packages not reachable at all (phantoms, orphans) are never touched, and a
// package that any runtime path reaches stays, whatever it is (e.g. esbuild,
// which @earendil-works/chord imports at runtime). It exits non-zero if a
// path it would delete contains a package still in KEEP.
import fs from "node:fs";
import path from "node:path";

const BUILD_ONLY = {
  "packages/client": ["vite", "@vitejs/plugin-react", "@tailwindcss/vite"],
  // Peer only: src/vite-plugin/index.ts has a type-only `import type ... from "vite"`
  // (erased by jiti); the plugin is loaded by the client build, never by the server.
  "packages/dashboard-plugin-runtime": ["vite"],
};

const [rootArg, flag] = process.argv.slice(2);
if (!rootArg) {
  console.error("usage: prune-build-only.mjs <app-root> [--dry-run]");
  process.exit(64);
}
const root = fs.realpathSync(rootArg);
const dryRun = flag === "--dry-run";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// Workspace manifests: the root + packages/* (pnpm-workspace.yaml `packages/*`).
const manifests = [root];
for (const d of fs.readdirSync(path.join(root, "packages"))) {
  const dir = path.join(root, "packages", d);
  if (fs.existsSync(path.join(dir, "package.json"))) manifests.push(dir);
}

/** Node-style lookup of `<name>/package.json` from `fromDir` upward (stops at root's parent). */
function resolvePkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const cand = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(cand, "package.json"))) return fs.realpathSync(cand);
    const up = path.dirname(dir);
    if (up === dir || !up.startsWith(root)) return null;
    dir = up;
  }
}

function depNames(pkgDir) {
  let pj;
  try {
    pj = readJson(path.join(pkgDir, "package.json"));
  } catch {
    return [];
  }
  return [
    ...Object.keys(pj.dependencies ?? {}),
    ...Object.keys(pj.optionalDependencies ?? {}),
    ...Object.keys(pj.peerDependencies ?? {}),
  ];
}

function walk(cutEdges) {
  const seen = new Set();
  const queue = [...manifests];
  for (const m of manifests) seen.add(m);
  while (queue.length) {
    const dir = queue.pop();
    const rel = path.relative(root, dir);
    const cut = cutEdges ? new Set(BUILD_ONLY[rel] ?? []) : new Set();
    for (const name of depNames(dir)) {
      if (cut.has(name)) continue;
      const target = resolvePkgDir(name, dir);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
}

const full = walk(false);
const keep = walk(true);
const drop = [...full].filter((p) => !keep.has(p) && p.includes(`${path.sep}node_modules${path.sep}`)).sort();

for (const p of drop) {
  const inside = [...keep].find((k) => k.startsWith(p + path.sep));
  if (inside) {
    console.error(`prune-build-only: refusing: ${p} contains runtime package ${inside}`);
    process.exit(1);
  }
}

for (const p of drop) {
  const rel = path.relative(root, p);
  if (dryRun) {
    console.log(`would remove ${rel}`);
  } else {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`removed ${rel}`);
  }
}
console.log(`prune-build-only: ${drop.length} build-only package dir(s) ${dryRun ? "found" : "removed"}; ${keep.size} kept reachable`);
