// BKL-092 — staff-auth infra-error SIGNAL: classification + repeat-emission.
//
// Validates:
//   1. classifyStaffLookupError distinguishes P2025 (record-not-found, the ONLY
//      non-infra class) from schema drift / connectivity / other DB failures.
//   2. reportStaffAuthInfraError logs a PII-free structured ERROR and, once the
//      per-window Redis counter crosses the threshold, RAISES a governed
//      `ops.alert.open` (cause ops_staff_auth_infra) — all best-effort (never throws).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((k: string) => `ibatexas:${k}`));
vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
}));

const mockOpenAlertFromEnvelope = vi.hoisted(() => vi.fn());
const mockCreateOpsAlertService = vi.hoisted(() =>
  vi.fn(() => ({ openAlertFromEnvelope: mockOpenAlertFromEnvelope })),
);
vi.mock("@ibatexas/domain", () => ({
  createOpsAlertService: mockCreateOpsAlertService,
  OPS_ALERT_CAUSE_LABELS_PT: {
    ops_staff_auth_infra:
      "falha de infraestrutura na autenticação de funcionários (logins de staff caindo)",
  },
}));

const mockGetAuditSink = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("@ibatexas/audit-sink", () => ({ getAuditSink: mockGetAuditSink }));

import {
  classifyStaffLookupError,
  isStaffAuthInfraError,
  reportStaffAuthInfraError,
  _resetStaffAuthInfraAlert,
} from "../middleware/staff-auth-infra-alert.js";

const prismaErr = (code: string) => Object.assign(new Error("db"), { code });

// ── classifyStaffLookupError ────────────────────────────────────────────────

describe("classifyStaffLookupError", () => {
  it("P2025 → record_not_found (the genuine unknown/deleted staff)", () => {
    expect(classifyStaffLookupError(prismaErr("P2025"))).toBe("record_not_found");
  });
  it("P2022 → schema_drift (the live-validation missing-column finding)", () => {
    expect(classifyStaffLookupError(prismaErr("P2022"))).toBe("schema_drift");
  });
  it("P1xxx → connectivity (via .code)", () => {
    expect(classifyStaffLookupError(prismaErr("P1001"))).toBe("connectivity");
  });
  it("P1xxx → connectivity (via .errorCode on an init error)", () => {
    const err = Object.assign(new Error("init"), { errorCode: "P1000" });
    expect(classifyStaffLookupError(err)).toBe("connectivity");
  });
  it("other P2xxx → query_error", () => {
    expect(classifyStaffLookupError(prismaErr("P2010"))).toBe("query_error");
  });
  it("generic Error without a code → unknown (fail-closed default = infra)", () => {
    expect(classifyStaffLookupError(new Error("boom"))).toBe("unknown");
  });
  it("non-object inputs → unknown", () => {
    expect(classifyStaffLookupError("nope")).toBe("unknown");
    expect(classifyStaffLookupError(null)).toBe("unknown");
    expect(classifyStaffLookupError(undefined)).toBe("unknown");
  });
});

describe("isStaffAuthInfraError", () => {
  it("record_not_found is NOT infra (silent fail-closed path)", () => {
    expect(isStaffAuthInfraError("record_not_found")).toBe(false);
  });
  it("every other class IS infra", () => {
    for (const c of ["schema_drift", "connectivity", "query_error", "unknown"] as const) {
      expect(isStaffAuthInfraError(c)).toBe(true);
    }
  });
});

// ── reportStaffAuthInfraError ───────────────────────────────────────────────

describe("reportStaffAuthInfraError", () => {
  const makeLog = () => ({ error: vi.fn(), warn: vi.fn() });
  let redis: { incr: ReturnType<typeof vi.fn>; expire: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetStaffAuthInfraAlert();
    mockRk.mockImplementation((k: string) => `ibatexas:${k}`);
    redis = { incr: vi.fn(), expire: vi.fn() };
    mockGetRedisClient.mockResolvedValue(redis);
    mockOpenAlertFromEnvelope.mockResolvedValue({ decision: { kind: "EXECUTE" } });
    delete process.env.STAFF_AUTH_INFRA_ALERT_THRESHOLD;
    delete process.env.STAFF_AUTH_INFRA_ALERT_WINDOW_SECONDS;
  });

  it("logs a structured, PII-free ERROR (only component/event/code/classification)", async () => {
    redis.incr.mockResolvedValue(1);
    const log = makeLog();
    await reportStaffAuthInfraError(prismaErr("P2022"), "schema_drift", log as never);

    expect(log.error).toHaveBeenCalledTimes(1);
    const [obj, msg] = log.error.mock.calls[0];
    expect(obj).toMatchObject({
      component: "auth",
      event: "staff_auth.infra_error",
      code: "P2022",
      classification: "schema_drift",
    });
    // No staff id / sub / token ever reaches the log object.
    expect(Object.keys(obj as object).sort()).toEqual([
      "classification",
      "code",
      "component",
      "event",
    ]);
    expect(String(msg)).toContain("failing closed");
  });

  it("does NOT raise an ops-alert below the threshold (signal-only)", async () => {
    redis.incr.mockResolvedValue(1); // 1 < default 3
    await reportStaffAuthInfraError(prismaErr("P2022"), "schema_drift", makeLog() as never);
    expect(redis.expire).toHaveBeenCalledWith("ibatexas:staff_auth:infra_error:window", 300);
    expect(mockOpenAlertFromEnvelope).not.toHaveBeenCalled();
  });

  it("sets the window TTL ONLY on the first increment", async () => {
    redis.incr.mockResolvedValue(2); // not the first → no expire
    await reportStaffAuthInfraError(prismaErr("P2022"), "schema_drift", makeLog() as never);
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("RAISES a governed ops.alert.open at/over the threshold, right cause + dedupeKey", async () => {
    redis.incr.mockResolvedValue(3); // == default threshold
    await reportStaffAuthInfraError(prismaErr("P2022"), "schema_drift", makeLog() as never);

    expect(mockOpenAlertFromEnvelope).toHaveBeenCalledTimes(1);
    const [envelope, state] = mockOpenAlertFromEnvelope.mock.calls[0];
    expect(envelope.kind).toBe("ops.alert.open");
    expect(envelope.actor.principal).toBe("system"); // SYSTEM actor (buildSystemEnvelope)
    expect(envelope.payload).toMatchObject({
      cause: "ops_staff_auth_infra",
      severity: "high",
      source: "staff-auth-middleware",
      scope: null,
      dedupeKey: "ops_staff_auth_infra:global",
    });
    expect(envelope.payload.context).toMatchObject({
      code: "P2022",
      classification: "schema_drift",
      windowCount: 3,
    });
    expect(state).toEqual({});
  });

  it("honors an env-overridden threshold", async () => {
    process.env.STAFF_AUTH_INFRA_ALERT_THRESHOLD = "1";
    redis.incr.mockResolvedValue(1);
    await reportStaffAuthInfraError(prismaErr("P1001"), "connectivity", makeLog() as never);
    expect(mockOpenAlertFromEnvelope).toHaveBeenCalledTimes(1);
  });

  it("is best-effort: a Redis failure never throws (auth still fails closed), ERROR still logged", async () => {
    mockGetRedisClient.mockRejectedValue(new Error("redis down"));
    const log = makeLog();
    await expect(
      reportStaffAuthInfraError(prismaErr("P2022"), "schema_drift", log as never),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1); // signal fired before the emission
    expect(log.warn).toHaveBeenCalled(); // emission failure warned, not thrown
  });

  it("is best-effort: a non-EXECUTE decision is warned, not thrown", async () => {
    redis.incr.mockResolvedValue(5);
    mockOpenAlertFromEnvelope.mockResolvedValue({ decision: { kind: "REFUSE" } });
    const log = makeLog();
    await expect(
      reportStaffAuthInfraError(prismaErr("P2022"), "schema_drift", log as never),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
