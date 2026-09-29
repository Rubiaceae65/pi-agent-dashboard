import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
// Import via a relative workspace path so vite's esbuild config-loader bundles
// the plugin (and its transitive .ts deps) into the temp config bundle. Using
// the package specifier "@blackbelt-technology/dashboard-plugin-runtime"
// instead would externalize the module and hit ERR_MODULE_NOT_FOUND because
// the runtime ships raw .ts (no compiled dist) and Node can't resolve
// `.js`-extensioned internal imports back to `.ts` at runtime.
import { viteDashboardPluginsPlugin } from "../dashboard-plugin-runtime/src/vite-plugin/index.js";

/**
 * Resolve the dashboard HTTP port for Vite proxy targets.
 *
 * Resolution order:
 *   1. PI_DASHBOARD_PORT env var (if set and parseable as 1–65535)
 *   2. /tmp/dash-dev-port marker file (dash-dev.sh writes this)
 *   3. port field from ~/.pi/dashboard/config.json
 *   4. Fallback: 8000
 *
 * Errors (missing config, bad JSON, invalid env) are silently swallowed;
 * the dev server starts with the fallback port.
 */
function resolveDashboardPort(): number {
  // 1. Env var
  const envPort = process.env.PI_DASHBOARD_PORT;
  if (envPort !== undefined) {
    const parsed = parseInt(envPort, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  // 2. dash-dev.sh marker file
  try {
    const raw = fs.readFileSync("/tmp/dash-dev-port", "utf-8").trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  } catch {
    // File missing or unreadable — fall through
  }
  // 3. Config file
  try {
    const configPath = path.join(os.homedir(), ".pi", "dashboard", "config.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw);
    if (typeof cfg.port === "number" && Number.isFinite(cfg.port) && cfg.port >= 1 && cfg.port <= 65535) {
      return cfg.port;
    }
  } catch {
    // Missing file, bad JSON, wrong shape — fall through
  }
  // 4. Fallback
  return 8000;
}

const DASHBOARD_PORT = resolveDashboardPort();

/**
 * Keep documentation out of the SERVED tree.
 *
 * `publicDir` is copied VERBATIM into `dist/`, and `dist/` is what
 * `@fastify/static` serves at `/`. So every file under `public/` is published
 * at a guessable URL — including the repo's own directory index.
 * `public/AGENTS.md` (a per-directory index this repo's convention REQUIRES,
 * see docs/AGENTS.md) has therefore been reachable at `/AGENTS.md` since it was
 * added, and `public/mobile/README.md` was reachable at `/mobile/README.md`,
 * describing the API surface and the `lastSeq` resume contract to anyone who
 * could open the socket.
 *
 * Vite has no filter hook for `publicDir`, so the files are removed after the
 * copy. Only documentation extensions are touched: `manifest.json`, the icons,
 * `sw.js` and the sub-app bundles are all left alone, and nothing here reads
 * or rewrites a file.
 *
 * Deliberately NOT solved by deleting `public/AGENTS.md`. The index belongs next
 * to the files it indexes; what is wrong is publishing it, not keeping it.
 *
 * Paired with the test `no documentation is placed in the served tree` in
 * packages/server/src/routes/__tests__/static-subapp-route.test.ts, which
 * asserts the outcome (nothing doc-shaped in the build) rather than this
 * mechanism. See change: guard-static-subapps.
 */
function stripDocsFromPublicDir(): Plugin {
  const DOC = /\.(?:md|markdown|txt|rst|adoc)$/i;
  return {
    name: "dashboard:strip-docs-from-public-dir",
    // `closeBundle` runs after the publicDir copy and after the bundle write,
    // so the files it removes are not regenerated afterwards.
    closeBundle() {
      const outDir = path.resolve(__dirname, "dist");
      if (!fs.existsSync(outDir)) return;
      const removed: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(abs);
          } else if (DOC.test(entry.name)) {
            fs.rmSync(abs);
            removed.push(path.relative(outDir, abs));
          }
        }
      };
      walk(outDir);
      if (removed.length > 0) {
        // Loud on purpose: if this list ever grows a file the app needs, the
        // build log is where it should be noticed, not in a 404 at runtime.
        this.warn(`stripped documentation from the served tree: ${removed.join(", ")}`);
      }
    },
  };
}
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteDashboardPluginsPlugin(path.resolve(__dirname, "../..")),
    stripDocsFromPublicDir(),
  ],
  root: "src",
  // publicDir is resolved relative to `root` (= packages/client/src/), so three
  // `../` hops are needed to reach the project-root public/ directory which
  // holds icon-192.png, manifest.json, sw.js, etc.
  publicDir: "../../../public",
  resolve: {
    alias: {
      "@blackbelt-technology/pi-dashboard-shared": path.resolve(__dirname, "../shared/src"),
      "@blackbelt-technology/pi-dashboard-client-utils": path.resolve(__dirname, "../client-utils/src"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Split the main bundle so no single chunk exceeds ~500 KB. This avoids
    // zrok / free-tunnel aborts on large static assets and improves caching
    // (only changed chunks invalidate).
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const chunks: Record<string, string[]> = {
            "react-vendor": ["react", "react-dom"],
            // react-syntax-highlighter is folded into `markdown` (not a
            // standalone chunk) because MarkdownContent.tsx statically imports
            // both — a separate `syntax` chunk only re-created a
            // `syntax → markdown → syntax` circular-chunk warning.
            "markdown": ["react-markdown", "remark-gfm", "rehype-raw", "dompurify", "react-syntax-highlighter"],
            // D1 (change: add-lazy-terminal-diff-bootstrap): the npm `diff`
            // package is split OUT of the `diff` chunk. `lineDelta.ts` and the
            // mobile HomegrownDiff path import it on the always-hot chat path,
            // so keeping it beside `@git-diff-view/*` pinned the whole rich
            // viewer family into the entry graph and no lazy boundary could
            // pay off. `jsdiff` is a cheap standalone chunk; the chunk key must
            // NOT start with `diff` (the build guard matches /^diff-/).
            "diff": [
              "@git-diff-view/core",
              "@git-diff-view/file",
              "@git-diff-view/lowlight",
              "@git-diff-view/react",
            ],
            "jsdiff": ["diff"],
            "xterm": [
              "@xterm/xterm",
              "@xterm/addon-attach",
              "@xterm/addon-fit",
            ],
            "dnd": [
              "@dnd-kit/core",
              "@dnd-kit/sortable",
              "@dnd-kit/utilities",
            ],
            "util": ["fuse.js", "qrcode", "wouter", "ansi-to-react"],
            // Monaco is heavy + only referenced by the lazily-imported
            // MonacoBuffer, so this chunk is fetched on first text-file open.
            // See change: add-internal-monaco-editor-pane.
            "monaco": ["monaco-editor", "@monaco-editor/react"],
            // No `@mdi/js` entry on purpose: named icon imports tree-shake
            // into `index`, and the full set loads lazily via
            // `@mdi/js/commonjs/mdi.js` (client-utils `mdi-by-key`). A matcher
            // here would pull that lazy module back into an eager chunk.
            // See change: harden-ios-safari-memory-and-ws-diagnostics.
          };
          for (const [chunk, deps] of Object.entries(chunks)) {
            if (deps.some((dep) => id.includes(`/node_modules/${dep}/`))) {
              return chunk;
            }
          }
        },
      },
    },
    // Raise the warning limit — mermaid and cytoscape chunks are already
    // code-split by vite's dynamic-import detection and don't need further
    // splitting.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 3000,
    hmr: {
      // HMR WebSocket must connect directly to Vite's port, not the dashboard's.
      clientPort: 3000,
    },
    proxy: {
      "/api": `http://localhost:${DASHBOARD_PORT}`,
      "/ws": {
        target: `ws://localhost:${DASHBOARD_PORT}`,
        ws: true,
      },
    },
  },
});
