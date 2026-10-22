/**
 * Chain-order tests for the managed-Node runtime strategy.
 *
 * After change `embed-managed-node-runtime`, the `node` and `npm`
 * strategy chains gain a `managedRuntimeStrategy` between
 * `overrideStrategy` and the existing PATH/where lookup. These tests
 * pin the precedence:
 *
 *   1. override (tool-overrides.json)        — wins
 *   2. managed runtime (<managedDir>/node/)  — preferred over PATH
 *   3. where / PATH                          — fallback
 *
 * `exists` is injected so no real filesystem is touched.
 *
 * See change: embed-managed-node-runtime (task 3.3).
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ToolRegistry,
  registerDefaultTools,
  OverridesStore,
} from "../index.js";

const HOST_EXEC_PATH = "/opt/test-host/bin/node";

function freshRegistry(opts: {
  execPath?: string;
  exists?: (p: string) => boolean;
  which?: (name: string) => string | null;
  overrides?: Record<string, string>;
  platform?: NodeJS.Platform;
}) {
  const store = new OverridesStore({
    filePath: path.join(os.tmpdir(), `mr-test-${Math.random()}.json`),
    warn: () => {},
  });
  for (const [k, v] of Object.entries(opts.overrides ?? {})) store.set(k, v);

  const r = new ToolRegistry({
    overrides: store,
    platform: opts.platform ?? "linux",
  });
  registerDefaultTools(r, {
    exists: opts.exists ?? (() => false),
    which: opts.which ?? (() => null),
    npmRootGlobal: () => "",
    // A fake host interpreter, so the PATH strategy's self-hit rule compares
    // against THIS and not the real process.execPath (which is /usr/bin/node
    // on some hosts - the same path these fixtures return from `which`).
    execPath: opts.execPath ?? HOST_EXEC_PATH,
  });
  return r;
}

const HOME = os.homedir();
const MANAGED_NODE_UNIX = path.join(HOME, ".pi-dashboard", "node", "bin", "node");
const MANAGED_NPM_UNIX = path.join(HOME, ".pi-dashboard", "node", "bin", "npm");
const MANAGED_NODE_WIN = path.join(HOME, ".pi-dashboard", "node", "node.exe");
const MANAGED_NPM_WIN = path.join(HOME, ".pi-dashboard", "node", "npm.cmd");

describe("node: managed-runtime strategy precedence", () => {
  it("managed runtime present → returned over PATH (Unix)", () => {
    const r = freshRegistry({
      platform: "linux",
      exists: (p) => p === MANAGED_NODE_UNIX,
      which: () => "/usr/bin/node",
    });
    const res = r.resolve("node");
    expect(res.ok).toBe(true);
    expect(res.path).toBe(MANAGED_NODE_UNIX);
    expect(res.source).toBe("managed");
  });

  it("managed runtime present → returned over PATH (Windows)", () => {
    const r = freshRegistry({
      platform: "win32",
      exists: (p) => p === MANAGED_NODE_WIN,
      which: () => "C:\\node\\node.exe",
    });
    const res = r.resolve("node");
    expect(res.ok).toBe(true);
    expect(res.path).toBe(MANAGED_NODE_WIN);
    expect(res.source).toBe("managed");
  });

  it("override wins over managed runtime", () => {
    const custom = "/opt/custom/node";
    const r = freshRegistry({
      platform: "linux",
      overrides: { node: custom },
      exists: (p) => p === custom || p === MANAGED_NODE_UNIX,
    });
    const res = r.resolve("node");
    expect(res.ok).toBe(true);
    expect(res.path).toBe(custom);
    expect(res.source).toBe("override");
  });

  it("both absent → falls through to PATH lookup", () => {
    const r = freshRegistry({
      platform: "linux",
      exists: () => false,
      which: (name) => (name === "node" ? "/usr/bin/node" : null),
    });
    const res = r.resolve("node");
    expect(res.ok).toBe(true);
    expect(res.path).toBe("/usr/bin/node");
    expect(res.source).toBe("system");
  });

  it("the PATH self-hit rule reads the injected execPath, not the host's", () => {
    // Pins the seam: when the injected interpreter IS the PATH hit, the where
    // strategy reports a self-hit. Before the seam this depended on where the
    // test host's own node lived.
    const r = freshRegistry({
      platform: "linux",
      execPath: "/usr/bin/node",
      exists: () => false,
      which: (name) => (name === "node" ? "/usr/bin/node" : null),
    });
    const res = r.resolve("node");
    expect(res.ok).toBe(false);
    expect(res.tried.find((t) => t.strategy === "where")?.result).toBe("appimage-self-hit: /usr/bin/node");
  });

  it("nothing present → ok:false with diagnostic trail", () => {
    const r = freshRegistry({ platform: "linux", exists: () => false, which: () => null });
    const res = r.resolve("node");
    expect(res.ok).toBe(false);
    const trailNames = res.tried.map((t) => t.strategy);
    expect(trailNames).toContain("override");
    expect(trailNames).toContain("managed");
    expect(trailNames).toContain("where");
  });
});

describe("npm: managed-runtime strategy precedence", () => {
  it("managed npm present → returned over PATH (Unix)", () => {
    const r = freshRegistry({
      platform: "linux",
      exists: (p) => p === MANAGED_NPM_UNIX,
      which: () => "/usr/bin/npm",
    });
    const res = r.resolve("npm");
    expect(res.ok).toBe(true);
    expect(res.path).toBe(MANAGED_NPM_UNIX);
    expect(res.source).toBe("managed");
  });

  it("managed npm present → returned over PATH (Windows)", () => {
    const r = freshRegistry({
      platform: "win32",
      exists: (p) => p === MANAGED_NPM_WIN,
      which: () => "C:\\node\\npm.cmd",
    });
    const res = r.resolve("npm");
    expect(res.ok).toBe(true);
    expect(res.path).toBe(MANAGED_NPM_WIN);
    expect(res.source).toBe("managed");
  });

  it("override wins over managed npm", () => {
    const custom = "/opt/custom/npm";
    const r = freshRegistry({
      platform: "linux",
      overrides: { npm: custom },
      exists: (p) => p === custom || p === MANAGED_NPM_UNIX,
    });
    const res = r.resolve("npm");
    expect(res.ok).toBe(true);
    expect(res.path).toBe(custom);
    expect(res.source).toBe("override");
  });

  it("npm: managed absent + PATH present → falls through (Unix)", () => {
    const r = freshRegistry({
      platform: "linux",
      exists: () => false,
      which: (name) => (name === "npm" ? "/usr/bin/npm" : null),
    });
    const res = r.resolve("npm");
    expect(res.ok).toBe(true);
    expect(res.path).toBe("/usr/bin/npm");
    expect(res.source).toBe("system");
  });
});
