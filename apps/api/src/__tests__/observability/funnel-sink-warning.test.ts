// BKL-266 half (b) — the api must say ONE loud thing at boot when the funnel
// telemetry sink is absent.
//
// Why a unit test on the wiring function rather than a booted api: the dev box
// runs a SHARED stack, and booting a second api against it is the BKL-263 trap
// (port contention + a readiness timeout as the only signature). The function is
// the whole behaviour — server.ts does nothing but `void` it — so driving it
// directly with an injected logger and fetch is the honest seam.
//
// The properties under test are exactly the constraints the ticket set: exactly
// one warn line, never more; the consequence stated in plain words; no boot
// refusal; no retry loop; a single bounded probe; and total silence when the
// sink is healthy.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  warnIfFunnelSinkAbsent,
  resetFunnelSinkWarningForTests,
} from "../../observability/log-streams.js";

/** Minimal logger double capturing (obj, msg) warn calls. */
function makeLog() {
  const warn = vi.fn<(obj: object, msg: string) => void>();
  return { log: { warn }, warn };
}

const okResponse = { ok: true, status: 200 } as Response;

beforeEach(() => {
  resetFunnelSinkWarningForTests();
});

describe("warnIfFunnelSinkAbsent — sink UNSET", () => {
  it("emits EXACTLY ONE warn line", async () => {
    const { log, warn } = makeLog();
    const fetchImpl = vi.fn();

    await warnIfFunnelSinkAbsent({ log, url: undefined, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("states the consequence plainly and tags the line for LogsQL", async () => {
    const { log, warn } = makeLog();

    await warnIfFunnelSinkAbsent({ log, url: undefined });

    const [obj, msg] = warn.mock.calls[0]!;
    expect(msg).toContain("zero-call funnel records will not be written anywhere");
    expect(msg).toContain("VICTORIALOGS_URL is UNSET");
    expect(obj).toMatchObject({
      component: "observability.funnel-sink",
      event: "absent",
      reason: "unset",
    });
  });

  it("does NOT probe the network — there is nothing to probe", async () => {
    const { log } = makeLog();
    const fetchImpl = vi.fn();

    await warnIfFunnelSinkAbsent({ log, url: undefined, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a blank/whitespace URL as unset", async () => {
    const { log, warn } = makeLog();

    await warnIfFunnelSinkAbsent({ log, url: "" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ reason: "unset" });
  });
});

describe("warnIfFunnelSinkAbsent — sink SET but UNREACHABLE", () => {
  it("emits exactly one warn after a single failed probe", async () => {
    const { log, warn } = makeLog();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));

    await warnIfFunnelSinkAbsent({
      log,
      url: "http://localhost:9428",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // ONE probe — never a retry loop
    const [obj, msg] = warn.mock.calls[0]!;
    expect(msg).toContain("zero-call funnel records will not be written anywhere");
    expect(obj).toMatchObject({ reason: "unreachable", url: "http://localhost:9428" });
  });

  it("treats a non-ok status as absent and records the status", async () => {
    const { log, warn } = makeLog();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);

    await warnIfFunnelSinkAbsent({
      log,
      url: "http://localhost:9428",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ reason: "unreachable", probeError: "HTTP 503" });
  });

  it("probes /health with a bounded abort signal", async () => {
    const { log } = makeLog();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse);

    await warnIfFunnelSinkAbsent({
      log,
      url: "http://localhost:9428",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://localhost:9428/health");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("strips a trailing slash so a configured base cannot probe //health (the BKL-109 false-positive)", async () => {
    const { log, warn } = makeLog();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse);

    await warnIfFunnelSinkAbsent({
      log,
      url: "http://localhost:9428///",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl.mock.calls[0]![0]).toBe("http://localhost:9428/health");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("warnIfFunnelSinkAbsent — sink HEALTHY", () => {
  it("says nothing at all", async () => {
    const { log, warn } = makeLog();
    const fetchImpl = vi.fn().mockResolvedValue(okResponse);

    await warnIfFunnelSinkAbsent({
      log,
      url: "http://localhost:9428",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves the latch UNSET, so a later outage can still warn once", async () => {
    const { log, warn } = makeLog();
    const healthy = vi.fn().mockResolvedValue(okResponse);
    await warnIfFunnelSinkAbsent({ log, url: "http://localhost:9428", fetchImpl: healthy as unknown as typeof fetch });
    expect(warn).not.toHaveBeenCalled();

    const down = vi.fn().mockRejectedValue(new Error("down"));
    await warnIfFunnelSinkAbsent({ log, url: "http://localhost:9428", fetchImpl: down as unknown as typeof fetch });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("warnIfFunnelSinkAbsent — not repeated, never fatal", () => {
  it("warns ONCE across repeated calls (a re-built server cannot spam)", async () => {
    const { log, warn } = makeLog();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));

    for (let i = 0; i < 5; i++) {
      await warnIfFunnelSinkAbsent({
        log,
        url: "http://localhost:9428",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    }

    expect(warn).toHaveBeenCalledTimes(1);
    // and it stops probing too — the latch short-circuits before the fetch
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves (never rejects) when the logger itself throws — a warning must not break boot", async () => {
    const log = {
      warn: () => {
        throw new Error("logger exploded");
      },
    };

    await expect(warnIfFunnelSinkAbsent({ log, url: undefined })).resolves.toBeUndefined();
  });
});
