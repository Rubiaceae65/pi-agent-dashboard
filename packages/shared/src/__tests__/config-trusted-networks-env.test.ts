// PI_DASHBOARD_TRUSTED_NETWORKS — a deployment-declared trusted socket-peer list
// (e.g. the SSO gateway's upstream address). Merged into resolvedTrustedNetworks
// at load time, never persisted, and validated so it can never become blanket
// trust. See change: add-trusted-networks-env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseTrustedNetworksEnv, TRUSTED_NETWORKS_ENV } from "../config.js";

describe("parseTrustedNetworksEnv", () => {
  it("accepts exact IPv4/IPv6 addresses and IPv4 CIDRs, comma or space separated", () => {
    const warn = vi.fn();
    expect(parseTrustedNetworksEnv("10.244.0.243/32, 192.168.1.0/24  10.0.0.7,fd00::1", warn)).toEqual([
      "10.244.0.243/32",
      "192.168.1.0/24",
      "10.0.0.7",
      "fd00::1",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns [] for unset / blank", () => {
    expect(parseTrustedNetworksEnv(undefined)).toEqual([]);
    expect(parseTrustedNetworksEnv("  , ")).toEqual([]);
  });

  it.each([
    ["0.0.0.0/0"],
    ["::/0"],
    ["*"],
    ["10.*"],
    ["10.0.0.*"],
    ["dashboard.example.com"],
    ["localhost"],
    ["10.0.0.0/7"],
    ["10.0.0.0/33"],
    ["10.0.0.0/"],
    ["10.0.0.0/x"],
    ["fd00::/8"],
    ["300.1.1.1"],
  ])("drops %s with a warning naming it, never throws", (entry) => {
    const warn = vi.fn();
    expect(parseTrustedNetworksEnv(`${entry},10.244.0.243/32`, warn)).toEqual(["10.244.0.243/32"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`"${entry}"`);
    expect(warn.mock.calls[0][0]).toContain(TRUSTED_NETWORKS_ENV);
  });

  it("dedupes repeated entries", () => {
    expect(parseTrustedNetworksEnv("10.0.0.1 10.0.0.1", vi.fn())).toEqual(["10.0.0.1"]);
  });
});

describe("loadConfig merges PI_DASHBOARD_TRUSTED_NETWORKS", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string | undefined;
  let origEnv: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-config-env-trusted-"));
    fs.mkdirSync(path.join(testDir, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(testDir, ".pi", "dashboard", "config.json");
    origHome = process.env.HOME;
    origEnv = process.env[TRUSTED_NETWORKS_ENV];
    process.env.HOME = testDir;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origEnv === undefined) delete process.env[TRUSTED_NETWORKS_ENV];
    else process.env[TRUSTED_NETWORKS_ENV] = origEnv;
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("applies with NO config.json (the finca deployment shape)", () => {
    process.env[TRUSTED_NETWORKS_ENV] = "10.244.0.243/32";
    const config = loadConfig();
    expect(config.resolvedTrustedNetworks).toEqual(["10.244.0.243/32"]);
    expect(config.trustedNetworks).toEqual([]);
  });

  it("merges with trustedNetworks + auth.bypassHosts, dedupes, and is NOT in trustedNetworks", () => {
    fs.writeFileSync(
      configFile,
      JSON.stringify({ trustedNetworks: ["192.168.1.0/24"], auth: { bypassHosts: ["10.0.0.5"] } }),
    );
    process.env[TRUSTED_NETWORKS_ENV] = "10.244.0.243/32,192.168.1.0/24";
    const config = loadConfig();
    expect(config.resolvedTrustedNetworks).toEqual(["192.168.1.0/24", "10.0.0.5", "10.244.0.243/32"]);
    // The env list is never part of the persisted/UI-editable field.
    expect(config.trustedNetworks).toEqual(["192.168.1.0/24"]);
  });

  it("drops blanket / invalid entries instead of trusting everyone", () => {
    process.env[TRUSTED_NETWORKS_ENV] = "0.0.0.0/0 * ::/0 gateway.local 10.244.0.243/32";
    expect(loadConfig().resolvedTrustedNetworks).toEqual(["10.244.0.243/32"]);
  });

  it("warns once per distinct value across repeated loads (config reparses)", () => {
    const warn = vi.mocked(console.warn);
    // A value no earlier test used, so the module-level memo starts cold.
    process.env[TRUSTED_NETWORKS_ENV] = "10.9.9.9 0.0.0.0/0";
    loadConfig();
    loadConfig();
    loadConfig();
    const ours = warn.mock.calls.filter((c) => String(c[0]).includes(TRUSTED_NETWORKS_ENV));
    expect(ours).toHaveLength(1);
    expect(String(ours[0][0])).toContain('"0.0.0.0/0"');
  });

  it("is a no-op when unset", () => {
    delete process.env[TRUSTED_NETWORKS_ENV];
    expect(loadConfig().resolvedTrustedNetworks).toEqual([]);
  });
});
