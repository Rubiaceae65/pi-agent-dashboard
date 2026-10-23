/**
 * zrok is an OPT-IN image component (docker/Dockerfile `ARG INCLUDE_ZROK`,
 * default 0): release images ship without `zrok2`. With the binary absent the
 * server must boot normally — with `--no-tunnel` AND with a tunnel requested —
 * and report the tunnel as unavailable instead of crashing or retrying.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";
import { _resetBinaryCache, _setBinaryAvailable, TUNNEL_UNAVAILABLE_NO_ZROK } from "../tunnel/tunnel.js";

describe("zrok binary absent (release image, INCLUDE_ZROK=0)", () => {
  let handle: TestServerHandle | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _setBinaryAvailable(false);
    warn = vi.spyOn(console, "warn");
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    warn.mockRestore();
    _resetBinaryCache();
  });

  const tunnelWarnings = () =>
    warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes(TUNNEL_UNAVAILABLE_NO_ZROK));

  it("--no-tunnel: boots, /api/health ok, tunnel status unavailable, no tunnel warning", async () => {
    handle = await createTestServer({ tunnel: false });
    const base = `http://127.0.0.1:${handle.httpPort}`;

    const health = await fetch(`${base}/api/health`);
    expect(health.ok).toBe(true);

    const status = await (await fetch(`${base}/api/tunnel-status`)).json();
    expect(status.status).toBe("unavailable");
    expect(tunnelWarnings()).toHaveLength(0);
  });

  it("tunnel requested: boots, logs 'tunnel unavailable: zrok not installed' once, connect reports it", async () => {
    handle = await createTestServer({ tunnel: true });
    const base = `http://127.0.0.1:${handle.httpPort}`;

    const health = await fetch(`${base}/api/health`);
    expect(health.ok).toBe(true);

    const status = await (await fetch(`${base}/api/tunnel-status`)).json();
    expect(status.status).toBe("unavailable");
    expect(status.url).toBeUndefined();

    // Logged once at boot — degraded, not looping.
    expect(tunnelWarnings()).toHaveLength(1);

    const connect = await fetch(`${base}/api/tunnel-connect`, {
      method: "POST",
      headers: { Origin: base },
    });
    const body = await connect.json();
    expect(body).toEqual({ ok: false, error: TUNNEL_UNAVAILABLE_NO_ZROK });
    expect(tunnelWarnings()).toHaveLength(1);
  });
});
