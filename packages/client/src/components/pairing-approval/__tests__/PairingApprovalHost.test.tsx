/**
 * Pairing approval host (change: add-pairing-approval-dialog, test-plan
 * F4 handled-elsewhere, F5, F8, F9, F10, X10). Exemplar:
 * access-grant/__tests__/GrantPromptHost.test.tsx.
 */
import type {
  GrantRequestMessage,
  ServerToBrowserMessage,
} from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrantPromptStore } from "../../../lib/access-grants/grant-prompt-store.js";
import type { PendingPairing } from "../../../lib/pairing/pairing-approval-api.js";
import { PairingApprovalStore } from "../../../lib/pairing/pairing-approval-store.js";
import { PairingApprovalHost } from "../PairingApprovalHost.js";

type Handler = (msg: ServerToBrowserMessage) => void;
const FAKE_WS = {} as WebSocket;
const HINT: ServerToBrowserMessage = { type: "pair_pending_changed" };

function entry(id: string, createdAt = Date.now()): PendingPairing {
  return {
    pendingId: id,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    viaHost: `${id}.example`,
    remoteAddress: "10.0.0.1",
    createdAt,
    expiresAt: createdAt + 60_000,
    attemptsLeft: 5,
  };
}

function setup(opts: { list?: () => Promise<PendingPairing[]>; bearer?: string | null } = {}) {
  const handlers = new Set<Handler>();
  let current: PendingPairing[] = [];
  const api = {
    listPending: vi.fn(opts.list ?? (async () => current)),
    approvePending: vi.fn(async () => ({ ok: false as const, error: "mismatch" as const, attemptsLeft: 4 })),
    denyPending: vi.fn(async () => ({ ok: true })),
  };
  const store = new PairingApprovalStore();
  const grantStore = new GrantPromptStore();
  const props = {
    onMessage: (h: Handler) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    store,
    grantStore,
    api,
    getBearer: () => opts.bearer ?? null,
    checkOperator: async () => true,
  };
  const view = render(<PairingApprovalHost {...props} ws={null} />);
  return {
    api,
    store,
    grantStore,
    setList: (l: PendingPairing[]) => {
      current = l;
    },
    hint: () => act(() => handlers.forEach((h) => h(HINT))),
    connect: (ws: WebSocket | null = FAKE_WS) => view.rerender(<PairingApprovalHost {...props} ws={ws} />),
  };
}

const grant = (id: string): GrantRequestMessage => ({
  type: "grant_request",
  promptId: id,
  plane: "filesystem",
  subject: `/repo/${id}`,
  expiresAt: Date.now() + 60_000,
  copy: { mode: "held", verdicts: ["allow-once", "allow-always", "deny"], store: "access-grants.json" },
});

afterEach(() => cleanup());

describe("PairingApprovalHost", () => {
  it("F5: one dialog, oldest first, with +1 more waiting; after A resolves B opens without the chip", async () => {
    const h = setup();
    h.setList([entry("aaa", 1), entry("bbb", 2)]);
    h.connect();
    await waitFor(() => expect(screen.getByTestId("pairing-dialog-via").textContent).toBe("aaa.example"));
    expect(screen.getAllByTestId("pairing-dialog")).toHaveLength(1);
    expect(screen.getByTestId("pairing-dialog-queued").textContent).toBe("+1 more waiting");

    h.setList([entry("bbb", 2)]);
    await h.hint();
    await waitFor(() => expect(screen.getByTestId("pairing-dialog-via").textContent).toBe("bbb.example"));
    expect(screen.queryByTestId("pairing-dialog-queued")).toBeNull();
  });

  it("F4/D6: an open request answered elsewhere closes with a handled-elsewhere toast", async () => {
    const h = setup();
    h.setList([entry("aaa")]);
    h.connect();
    await screen.findByTestId("pairing-dialog");
    h.setList([]);
    await h.hint();
    await waitFor(() => expect(screen.queryByTestId("pairing-dialog")).toBeNull());
    expect(screen.getByText("Pairing request handled in another window.")).toBeTruthy();
  });

  it("F8: fetches on mount, and again on reconnect with no hint frame, then shows the dialog", async () => {
    const h = setup();
    await waitFor(() => expect(h.api.listPending).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("pairing-dialog")).toBeNull();
    h.setList([entry("aaa")]);
    h.connect();
    await waitFor(() => expect(h.api.listPending).toHaveBeenCalledTimes(2));
    await screen.findByTestId("pairing-dialog");
  });

  it("an older list response resolving after a newer one never overwrites it", async () => {
    const resolvers: Array<(l: PendingPairing[]) => void> = [];
    const h = setup({ list: () => new Promise<PendingPairing[]>((r) => resolvers.push(r)) });
    await waitFor(() => expect(resolvers).toHaveLength(1)); // mount fetch (stale)
    await h.hint(); // newer fetch
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[1]([entry("aaa")]));
    await screen.findByTestId("pairing-dialog");
    await act(async () => resolvers[0]([]));
    expect(h.store.getState().pending.map((p) => p.pendingId)).toEqual(["aaa"]);
    expect(screen.getByTestId("pairing-dialog")).toBeTruthy();
  });

  it("F9: waits while a grant dialog is open, opens right after, and is never dismissed", async () => {
    const h = setup();
    act(() => h.grantStore.apply(grant("g1")));
    h.setList([entry("aaa")]);
    h.connect();
    await waitFor(() => expect(h.api.listPending).toHaveBeenCalled());
    await waitFor(() => expect(h.store.getState().pending).toHaveLength(1));
    expect(screen.queryByTestId("pairing-dialog")).toBeNull();

    act(() => {
      h.grantStore.claim("g1");
    });
    await screen.findByTestId("pairing-dialog");
    expect(h.store.getState().dismissed.has("aaa")).toBe(false);
  });

  it("deny answered elsewhere (no_pending) closes with the handled-elsewhere notice", async () => {
    const h = setup();
    h.api.denyPending.mockResolvedValueOnce({ ok: false, error: "no_pending" } as never);
    h.setList([entry("aaa")]);
    h.connect();
    await screen.findByTestId("pairing-dialog");
    fireEvent.click(screen.getByTestId("pairing-deny"));
    await waitFor(() => expect(screen.queryByTestId("pairing-dialog")).toBeNull());
    expect(screen.getByText("Pairing request handled in another window.")).toBeTruthy();
  });

  it("F10: a paired-device browser never fetches and never renders", async () => {
    const h = setup({ bearer: "device-token" });
    h.setList([entry("aaa")]);
    h.connect();
    await h.hint();
    expect(h.api.listPending).not.toHaveBeenCalled();
    expect(screen.queryByTestId("pairing-dialog")).toBeNull();
  });

  // rc-suites RC 0011 recheck: an owner behind the front door is not an
  // operator, and every page load used to GET /api/pair/pending → 401 (console
  // error in every engine). The default wiring asks GET /auth/status once and
  // fetches the operator list only on `operator: true`.
  describe("operator gate (real fetch wiring)", () => {
    function stubFetch(status: Record<string, unknown>) {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const u = String(input);
          calls.push(u);
          const body = u.endsWith("/auth/status") ? status : { success: true, data: [entry("aaa")] };
          return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
      return calls;
    }
    function mount() {
      const handlers = new Set<Handler>();
      render(
        <PairingApprovalHost
          onMessage={(h) => {
            handlers.add(h);
            return () => handlers.delete(h);
          }}
          ws={null}
          store={new PairingApprovalStore()}
          grantStore={new GrantPromptStore()}
          getBearer={() => null}
        />,
      );
      return { hint: () => act(() => handlers.forEach((h) => h(HINT))) };
    }
    afterEach(() => vi.unstubAllGlobals());
    /** Drain the status fetch → json → operator check → (maybe) list chain. */
    const settle = () =>
      act(async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      });

    it("operator=false (front-door owner): no GET /api/pair/pending, on mount or on a hint", async () => {
      const calls = stubFetch({ authenticated: true, authEnabled: false, operator: false });
      const m = mount();
      await waitFor(() => expect(calls.some((u) => u.endsWith("/auth/status"))).toBe(true));
      await m.hint();
      await settle();
      expect(calls.filter((u) => u.includes("/api/pair/pending"))).toEqual([]);
      expect(calls.filter((u) => u.endsWith("/auth/status"))).toHaveLength(1);
      expect(screen.queryByTestId("pairing-dialog")).toBeNull();
    });

    it("operator absent (older server): treated as not an operator", async () => {
      const calls = stubFetch({ authenticated: true, authEnabled: false });
      mount();
      await waitFor(() => expect(calls.some((u) => u.endsWith("/auth/status"))).toBe(true));
      await settle();
      expect(calls.filter((u) => u.includes("/api/pair/pending"))).toEqual([]);
    });

    it("operator=true: the list is still fetched and the dialog shows", async () => {
      const calls = stubFetch({ authenticated: true, operator: true });
      mount();
      await screen.findByTestId("pairing-dialog");
      expect(calls.filter((u) => u.includes("/api/pair/pending")).length).toBeGreaterThanOrEqual(1);
    });
  });

  it.each([
    ["network error", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["HTTP 500", async () => Promise.reject(Object.assign(new Error("HTTP 500"), { status: 500 }))],
  ])("X10: %s on the list fetch → no dialog, no throw; the next hint retries", async (_n, fail) => {
    let calls = 0;
    const h = setup({
      list: async () => {
        calls += 1;
        return calls === 1 ? fail() : [entry("aaa")];
      },
    });
    // The mount fetch is the failing one.
    await waitFor(() => expect(h.api.listPending).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("pairing-dialog")).toBeNull();
    await h.hint();
    await waitFor(() => expect(h.api.listPending).toHaveBeenCalledTimes(2));
    await screen.findByTestId("pairing-dialog");
  });

  it("closing keeps the request pending (dismissed) and Review reopens it", async () => {
    const h = setup();
    h.setList([entry("aaa")]);
    h.connect();
    await screen.findByTestId("pairing-dialog");
    fireEvent.click(screen.getByTestId("pairing-dialog-close"));
    await waitFor(() => expect(screen.queryByTestId("pairing-dialog")).toBeNull());
    expect(h.store.getState().dismissed.has("aaa")).toBe(true);
    expect(h.api.denyPending).not.toHaveBeenCalled();
    act(() => h.store.review("aaa"));
    await screen.findByTestId("pairing-dialog");
  });

  it("a non-terminal approve failure (e.g. 401) keeps handled-elsewhere detection armed", async () => {
    const h = setup();
    h.api.approvePending.mockResolvedValueOnce({ ok: false, error: "operator credential required" } as never);
    h.setList([entry("aaa")]);
    h.connect();
    await screen.findByTestId("pairing-dialog");
    fireEvent.change(screen.getByTestId("pairing-code-input"), { target: { value: "12345678" } });
    fireEvent.click(screen.getByTestId("pairing-approve"));
    await screen.findByTestId("pairing-dialog-error");
    h.setList([]);
    await h.hint();
    await waitFor(() => expect(screen.queryByTestId("pairing-dialog")).toBeNull());
    expect(screen.getByText("Pairing request handled in another window.")).toBeTruthy();
  });

  it("deny calls the API for the open request and closes without a toast", async () => {
    const h = setup();
    h.setList([entry("aaa")]);
    h.connect();
    await screen.findByTestId("pairing-dialog");
    fireEvent.click(screen.getByTestId("pairing-deny"));
    await waitFor(() => expect(h.api.denyPending).toHaveBeenCalledWith("aaa"));
    await waitFor(() => expect(screen.queryByTestId("pairing-dialog")).toBeNull());
    h.setList([]);
    await h.hint();
    expect(screen.queryByText("Pairing request handled in another window.")).toBeNull();
  });
});
