// observability-liveness-checker — unit tests (BKL-109).
//
// Covers the PURE helpers (severity bands, debounce gate, env-driven probe-target
// resolution + the disable gate, pt-BR payload builder) and a thin injected-deps
// integration of `checkObservabilityLiveness` (probe → debounce counter → govern
// raise/AUTO-resolve through the OpsAlertService), plus the start() disable gate.

import { createInMemoryRedis } from "@ibatexas/tools/testing";
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Fake BullMQ queue/worker so start()/stop() need no Redis (integration tests
// inject their own deps and never touch this).
const mockUpsert = vi.hoisted(() => vi.fn());
const mockQueueClose = vi.hoisted(() => vi.fn());
const mockWorkerOn = vi.hoisted(() => vi.fn());
const mockWorkerClose = vi.hoisted(() => vi.fn());
const mockCreateQueue = vi.hoisted(() =>
  vi.fn(() => ({ upsertJobScheduler: mockUpsert, close: mockQueueClose })),
);
const mockCreateWorker = vi.hoisted(() =>
  vi.fn(() => ({ on: mockWorkerOn, close: mockWorkerClose })),
);
vi.mock("../../jobs/queue.js", () => ({
  createQueue: mockCreateQueue,
  createWorker: mockCreateWorker,
}));

vi.mock("@sentry/node", () => ({
  withScope: vi.fn((cb: (s: unknown) => void) => cb({ setTag: vi.fn(), setContext: vi.fn() })),
  captureException: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import { OPS_ALERT_CAUSE_LABELS_PT, type OpsAlertService } from "@ibatexas/domain";
import {
  livenessSeverity,
  shouldRaise,
  requiredDownSweeps,
  resolveProbeTargets,
  counterKey,
  buildObservabilityOpenPayload,
  checkObservabilityLiveness,
  startObservabilityLivenessChecker,
  stopObservabilityLivenessChecker,
} from "../../jobs/observability-liveness-checker.js";

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("livenessSeverity — VL is the incident class", () => {
  it("victorialogs → high (turns become log-unrecoverable), victoriametrics → medium", () => {
    expect(livenessSeverity("victorialogs")).toBe("high");
    expect(livenessSeverity("victoriametrics")).toBe("medium");
  });
});

describe("shouldRaise — the N-consecutive-DOWN gate", () => {
  it("raises only at/over the required sweeps", () => {
    expect(shouldRaise(0, 2)).toBe(false);
    expect(shouldRaise(1, 2)).toBe(false);
    expect(shouldRaise(2, 2)).toBe(true);
    expect(shouldRaise(3, 2)).toBe(true);
  });
});

describe("requiredDownSweeps — env parse with a safe default", () => {
  it("defaults to 2 when unset / non-numeric / sub-1", () => {
    expect(requiredDownSweeps({})).toBe(2);
    expect(requiredDownSweeps({ OPS_OBSERVABILITY_DOWN_SWEEPS: "nope" })).toBe(2);
    expect(requiredDownSweeps({ OPS_OBSERVABILITY_DOWN_SWEEPS: "0" })).toBe(2);
  });
  it("honors a valid override (floored)", () => {
    expect(requiredDownSweeps({ OPS_OBSERVABILITY_DOWN_SWEEPS: "3" })).toBe(3);
    expect(requiredDownSweeps({ OPS_OBSERVABILITY_DOWN_SWEEPS: "4.9" })).toBe(4);
  });
});

describe("resolveProbeTargets — env gate, normalization, VM host policy", () => {
  it("returns [] (disabled) when VICTORIALOGS_URL is unset", () => {
    expect(resolveProbeTargets({})).toEqual([]);
    expect(resolveProbeTargets({ VICTORIAMETRICS_URL: "http://vm:8428" })).toEqual([]);
  });

  // Defect B — trailing slash / whitespace must be normalized. A "//health" probe
  // path is answered HTTP 400 by BOTH VL and VM = a permanent false DOWN on a
  // healthy stack, while the (normalizing) log shipper works fine.
  it("trims whitespace and strips trailing slashes on both vars (Defect B)", () => {
    expect(resolveProbeTargets({ VICTORIALOGS_URL: "  http://localhost:9428/  " })).toEqual([
      { scope: "victorialogs", url: "http://localhost:9428/health" },
      { scope: "victoriametrics", url: "http://localhost:8428/health" },
    ]);
    expect(
      resolveProbeTargets({
        VICTORIALOGS_URL: "http://localhost:9428///",
        VICTORIAMETRICS_URL: "  http://vm:8428/ ",
      }),
    ).toEqual([
      { scope: "victorialogs", url: "http://localhost:9428/health" },
      { scope: "victoriametrics", url: "http://vm:8428/health" },
    ]);
    // A whitespace-only VM URL is treated as unset (falls through to the host policy).
    expect(
      resolveProbeTargets({ VICTORIALOGS_URL: "http://localhost:9428", VICTORIAMETRICS_URL: "   " }),
    ).toEqual([
      { scope: "victorialogs", url: "http://localhost:9428/health" },
      { scope: "victoriametrics", url: "http://localhost:8428/health" },
    ]);
  });

  // Defect C — VM probe host policy.
  it("probes VM when VICTORIAMETRICS_URL is explicitly set, on ANY host (Defect C)", () => {
    expect(
      resolveProbeTargets({
        VICTORIALOGS_URL: "http://vl.remote:9428",
        VICTORIAMETRICS_URL: "http://vm.remote:8428",
      }),
    ).toEqual([
      { scope: "victorialogs", url: "http://vl.remote:9428/health" },
      { scope: "victoriametrics", url: "http://vm.remote:8428/health" },
    ]);
  });

  it("defaults VM to :8428 ONLY when VL is localhost/127.0.0.1 and no VM URL (Defect C)", () => {
    for (const vl of ["http://localhost:9428", "http://127.0.0.1:9428"]) {
      const targets = resolveProbeTargets({ VICTORIALOGS_URL: vl });
      expect(targets.map((t) => t.scope)).toEqual(["victorialogs", "victoriametrics"]);
      expect(targets[1]).toEqual({ scope: "victoriametrics", url: "http://localhost:8428/health" });
    }
  });

  it("probes ONLY VL when VL is a REMOTE host and no VM URL is set (Defect C)", () => {
    expect(resolveProbeTargets({ VICTORIALOGS_URL: "http://logs.internal:9428" })).toEqual([
      { scope: "victorialogs", url: "http://logs.internal:9428/health" },
    ]);
  });

  it("probes VL as given and SKIPS VM when VICTORIALOGS_URL does not parse as a URL (Defect C)", () => {
    expect(resolveProbeTargets({ VICTORIALOGS_URL: "not-a-url" })).toEqual([
      { scope: "victorialogs", url: "not-a-url/health" },
    ]);
  });
});

describe("counterKey — rk()-namespaced, per scope", () => {
  it("is scope-specific and routed through rk()", () => {
    expect(counterKey("victorialogs")).toContain("ops_observability:down:victorialogs");
    expect(counterKey("victoriametrics")).toContain("ops_observability:down:victoriametrics");
    expect(counterKey("victorialogs")).not.toBe(counterKey("victoriametrics"));
  });
});

describe("buildObservabilityOpenPayload — governed open payload (pt-BR)", () => {
  it("builds the exact cause/scope/dedupeKey/severity + pt-BR title for VL", () => {
    const p = buildObservabilityOpenPayload({
      scope: "victorialogs",
      url: "http://vl:9428/health",
      consecutiveDown: 2,
      requiredSweeps: 2,
      probeError: "HTTP 503",
    });
    expect(p).toMatchObject({
      cause: "ops_observability_down",
      severity: "high",
      source: "observability-liveness-checker",
      scope: "victorialogs",
      dedupeKey: "ops_observability_down:victorialogs",
    });
    expect(p.title.startsWith(OPS_ALERT_CAUSE_LABELS_PT.ops_observability_down)).toBe(true);
    expect(p.title).toContain("victorialogs");
    expect(p.detail).toContain("victorialogs");
    expect(p.context).toEqual({
      url: "http://vl:9428/health",
      scope: "victorialogs",
      consecutiveDown: 2,
      requiredSweeps: 2,
      probeError: "HTTP 503",
    });
  });
  it("VM scope → medium severity; omits probeError when absent", () => {
    const p = buildObservabilityOpenPayload({
      scope: "victoriametrics",
      url: "http://vm:8428/health",
      consecutiveDown: 3,
      requiredSweeps: 2,
    });
    expect(p.severity).toBe("medium");
    expect(p.context).not.toHaveProperty("probeError");
  });
});

// ── Injected-deps integration ────────────────────────────────────────────────

type FetchResult = { ok: boolean; status: number } | Error;

function makeFetch(byUrl: Record<string, FetchResult>) {
  return vi.fn(async (url: string) => {
    const r = byUrl[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: true, status: 200 } as Response;
    return r as unknown as Response;
  }) as unknown as typeof fetch;
}

// R5-S7 — the counter store is the canonical in-memory adapter, not an ad-hoc
// number map. What was fiction before: `expire` answered a constant 1 for every
// call, including on keys that do not exist (real EXPIRE reports false), so the
// TTL pin below asserted only that an ARGUMENT was passed to a function that
// did nothing with it. INCR now enforces real integer semantics too.
//
// The commands stay `vi.fn()` DELEGATES rather than the raw client: the spy is
// pure observation (every call runs the adapter's real implementation), which
// keeps this file's call-shaped assertions and its one failure injection
// working unedited. It is also how you spy on this adapter at all — the client
// is a Proxy with no own properties, so `vi.spyOn` has nothing to replace.
function makeRedis(initial: Record<string, number> = {}) {
  const mem = createInMemoryRedis({
    seed: Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, String(v)])),
  });
  return {
    mem,
    incr: vi.fn((key: string) => mem.client.incr(key)),
    expire: vi.fn((key: string, seconds: number) => mem.client.expire(key, seconds)),
    del: vi.fn((key: string) => mem.client.del(key)),
  };
}

function makeSvc(alerts: Array<Record<string, unknown>> = []) {
  const open = vi.fn().mockResolvedValue({ decision: { kind: "EXECUTE" }, result: { opened: true } });
  const resolve = vi.fn().mockResolvedValue({ decision: { kind: "EXECUTE" }, result: {} });
  const list = vi.fn().mockResolvedValue({ alerts, openCount: alerts.length });
  return {
    svc: { openAlertFromEnvelope: open, resolveAlertFromEnvelope: resolve, list } as unknown as OpsAlertService,
    open,
    resolve,
    list,
  };
}

const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

const VL: readonly [{ scope: "victorialogs"; url: string }] = [
  { scope: "victorialogs", url: "http://vl:9428/health" },
];

const ENV_KEYS = ["VICTORIALOGS_URL", "VICTORIAMETRICS_URL", "OPS_OBSERVABILITY_DOWN_SWEEPS"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("checkObservabilityLiveness — injected-deps integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await stopObservabilityLivenessChecker();
  });

  it("gate-off: VICTORIALOGS_URL unset → nothing probed, no alert", async () => {
    delete process.env.VICTORIALOGS_URL;
    delete process.env.VICTORIAMETRICS_URL;
    const fetchImpl = makeFetch({});
    const { svc, open } = makeSvc();
    const redis = makeRedis();

    await checkObservabilityLiveness(makeLog() as never, { fetchImpl, redis, svc });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("1st DOWN sweep → counter=1, no raise; TTL pinned; probe carries an AbortSignal", async () => {
    const fetchImpl = makeFetch({ "http://vl:9428/health": new Error("ECONNREFUSED") });
    const { svc, open, resolve } = makeSvc();
    const redis = makeRedis(); // fresh → incr returns 1

    await checkObservabilityLiveness(makeLog() as never, {
      fetchImpl,
      redis,
      svc,
      targets: VL,
      requiredSweeps: 2,
    });

    // Defect D.3 — the probe MUST carry the abort timeout (dropping it can't pass).
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://vl:9428/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(redis.incr).toHaveBeenCalledWith(counterKey("victorialogs"));
    // Defect D.1 — pin the TTL (900s = 3× the 5-min sweep). A 0/negative or
    // ms-for-seconds regression silently disables the watchdog while staying green.
    expect(redis.expire).toHaveBeenCalledWith(counterKey("victorialogs"), 900);
    expect(open).not.toHaveBeenCalled(); // 1 < 2
    expect(resolve).not.toHaveBeenCalled(); // no open alert to auto-resolve
  });

  it("DOWN under threshold with an OPEN alert seeded → NEITHER resolves NOR raises (Defect A)", async () => {
    // Counter was reset (TTL lapse across api downtime / Redis eviction) so this
    // DOWN sweep is under threshold again — but the alert from the ongoing outage
    // is still OPEN/ACKNOWLEDGED. It must survive: no false AUTO-resolve, no read.
    const fetchImpl = makeFetch({ "http://vl:9428/health": new Error("still down") });
    const { svc, open, resolve, list } = makeSvc([
      { id: "ops_vl", status: "ACKNOWLEDGED", dedupeKey: "ops_observability_down:victorialogs" },
    ]);
    const redis = makeRedis(); // fresh → incr returns 1 (< 2)

    await checkObservabilityLiveness(makeLog() as never, {
      fetchImpl,
      redis,
      svc,
      targets: VL,
      requiredSweeps: 2,
    });

    expect(redis.incr).toHaveBeenCalledWith(counterKey("victorialogs"));
    expect(open).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled(); // the live incident is NOT false-resolved
    expect(list).not.toHaveBeenCalled(); // reconcile skipped entirely (no plane read)
  });

  it("2nd consecutive DOWN → RAISES with exact cause/scope/dedupeKey/severity/pt-BR title", async () => {
    const fetchImpl = makeFetch({ "http://vl:9428/health": new Error("timeout") });
    const { svc, open } = makeSvc();
    const redis = makeRedis({ [counterKey("victorialogs")]: 1 }); // prior sweep → incr returns 2

    await checkObservabilityLiveness(makeLog() as never, {
      fetchImpl,
      redis,
      svc,
      targets: VL,
      requiredSweeps: 2,
    });

    expect(open).toHaveBeenCalledTimes(1);
    const env = open.mock.calls[0]![0] as { kind: string; payload: Record<string, unknown> };
    expect(env.kind).toBe("ops.alert.open");
    expect(env.payload).toMatchObject({
      cause: "ops_observability_down",
      severity: "high",
      scope: "victorialogs",
      dedupeKey: "ops_observability_down:victorialogs",
    });
    expect(String(env.payload.title)).toContain(OPS_ALERT_CAUSE_LABELS_PT.ops_observability_down);
  });

  it("UP after a raise → DELs the counter and AUTO-resolves the open alert", async () => {
    const fetchImpl = makeFetch({ "http://vl:9428/health": { ok: true, status: 200 } });
    const { svc, open, resolve } = makeSvc([
      { id: "ops_vl", status: "OPEN", dedupeKey: "ops_observability_down:victorialogs" },
    ]);
    const redis = makeRedis({ [counterKey("victorialogs")]: 5 });

    await checkObservabilityLiveness(makeLog() as never, {
      fetchImpl,
      redis,
      svc,
      targets: VL,
      requiredSweeps: 2,
    });

    expect(redis.del).toHaveBeenCalledWith(counterKey("victorialogs"));
    expect(redis.incr).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    const env = resolve.mock.calls[0]![0] as { kind: string; payload: Record<string, unknown> };
    expect(env.kind).toBe("ops.alert.resolve");
    expect(env.payload).toMatchObject({ id: "ops_vl", resolutionType: "AUTO" });
  });

  it("VL and VM scopes are independent (per-scope counter + raise decision)", async () => {
    // VL down twice → raise; VM down once → no raise.
    const fetchImpl = makeFetch({
      "http://vl:9428/health": new Error("down"),
      "http://vm:8428/health": new Error("down"),
    });
    const { svc, open } = makeSvc();
    const redis = makeRedis({ [counterKey("victorialogs")]: 1 }); // VL prior=1 → 2; VM fresh → 1

    await checkObservabilityLiveness(makeLog() as never, {
      fetchImpl,
      redis,
      svc,
      targets: [
        { scope: "victorialogs", url: "http://vl:9428/health" },
        { scope: "victoriametrics", url: "http://vm:8428/health" },
      ],
      requiredSweeps: 2,
    });

    expect(open).toHaveBeenCalledTimes(1);
    const env = open.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(env.payload.scope).toBe("victorialogs");
    expect(redis.incr).toHaveBeenCalledWith(counterKey("victoriametrics"));
  });

  it("a non-ok HTTP response counts as DOWN (probeError = HTTP status)", async () => {
    const fetchImpl = makeFetch({ "http://vl:9428/health": { ok: false, status: 503 } });
    const { svc, open } = makeSvc();
    const redis = makeRedis({ [counterKey("victorialogs")]: 1 });

    await checkObservabilityLiveness(makeLog() as never, {
      fetchImpl,
      redis,
      svc,
      targets: VL,
      requiredSweeps: 2,
    });

    expect(open).toHaveBeenCalledTimes(1);
    const env = open.mock.calls[0]![0] as { payload: { context: Record<string, unknown> } };
    expect(env.payload.context.probeError).toBe("HTTP 503");
  });

  it("a non-EXECUTE ops-alert decision is warned, never thrown", async () => {
    const fetchImpl = makeFetch({ "http://vl:9428/health": new Error("down") });
    const { svc, open } = makeSvc();
    open.mockResolvedValue({ decision: { kind: "REFUSE" } });
    const redis = makeRedis({ [counterKey("victorialogs")]: 1 });
    const log = makeLog();

    await expect(
      checkObservabilityLiveness(log as never, { fetchImpl, redis, svc, targets: VL, requiredSweeps: 2 }),
    ).resolves.toBeUndefined();

    expect(open).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("a reconcile that THROWS is warned non-fatal, never breaks the sweep", async () => {
    // UP sweep → resolve path; svc.list rejecting makes reconcileSweepOpsAlert throw.
    const fetchImpl = makeFetch({ "http://vl:9428/health": { ok: true, status: 200 } });
    const { svc, list } = makeSvc();
    list.mockRejectedValueOnce(new Error("db down"));
    const redis = makeRedis();
    const log = makeLog();

    await expect(
      checkObservabilityLiveness(log as never, { fetchImpl, redis, svc, targets: VL, requiredSweeps: 2 }),
    ).resolves.toBeUndefined();

    expect(redis.del).toHaveBeenCalledWith(counterKey("victorialogs"));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "victorialogs" }),
      expect.stringContaining("non-fatal"),
    );
  });

  it("a sweep-level IO error is isolated to its scope → Sentry, next scope still probes (Defect D.2)", async () => {
    const fetchImpl = makeFetch({
      "http://vl:9428/health": new Error("down"),
      "http://vm:8428/health": new Error("down"),
    });
    const { svc } = makeSvc();
    const redis = makeRedis();
    // The FIRST scope's counter INCR explodes; the SECOND scope must be unaffected.
    redis.incr.mockRejectedValueOnce(new Error("redis exploded"));
    const log = makeLog();

    await expect(
      checkObservabilityLiveness(log as never, {
        fetchImpl,
        redis,
        svc,
        targets: [
          { scope: "victorialogs", url: "http://vl:9428/health" },
          { scope: "victoriametrics", url: "http://vm:8428/health" },
        ],
        requiredSweeps: 2,
      }),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalled();
    expect(Sentry.captureException as unknown as Mock).toHaveBeenCalled();
    // Per-scope isolation: the second scope still probed AND counted despite the first throwing.
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://vm:8428/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(redis.incr).toHaveBeenCalledWith(counterKey("victoriametrics"));
  });
});

// ── start() disable gate + registration ──────────────────────────────────────

describe("startObservabilityLivenessChecker — gate + registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await stopObservabilityLivenessChecker();
  });

  it("disabled: VICTORIALOGS_URL unset → logs INFO, registers no queue/worker", () => {
    delete process.env.VICTORIALOGS_URL;
    const log = makeLog();
    startObservabilityLivenessChecker(log as never);

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(String(log.info.mock.calls[0]![1])).toContain("disabled");
    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it("enabled: VICTORIALOGS_URL set → registers the repeatable 5-min sweep", () => {
    process.env.VICTORIALOGS_URL = "http://vl:9428";
    startObservabilityLivenessChecker(makeLog() as never);

    expect(mockCreateQueue).toHaveBeenCalledWith("observability-liveness-checker");
    expect(mockCreateWorker).toHaveBeenCalledWith("observability-liveness-checker", expect.any(Function));
    expect(mockUpsert).toHaveBeenCalledWith("observability-liveness-repeat", { every: 5 * 60 * 1000 });

    // The registered "failed" handler reports to Sentry without rethrowing.
    const failed = mockWorkerOn.mock.calls.find((c) => c[0] === "failed")?.[1] as
      | ((job: unknown, err: Error) => void)
      | undefined;
    expect(failed).toBeTypeOf("function");
    failed?.(undefined, new Error("boom"));
    expect(Sentry.captureException as unknown as Mock).toHaveBeenCalled();
  });
});
