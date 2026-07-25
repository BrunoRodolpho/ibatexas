// BKL-211 — security-probe incident emission, at the subscriber seam.
//
// Drives the REAL subscriber handler against the REAL `withDedup` (fake Redis) —
// the incident-subscriber.test.ts precedent — so the exactly-once claim is proven
// by the actual dedup code path, not a mock of it.
//
// The suite is deliberately weighted toward NEGATIVES. Emitting on an ordinary
// refusal would flood the staff inbox with false attacks and train reviewers to
// ignore the row, which is strictly worse than not having it. Every non-attack
// shape that can reach this subject gets its own pinning test.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockOpenIncidentInline = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisDel = vi.hoisted(() => vi.fn());

const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
      return { unsubscribe: () => {} };
    },
  ),
}));

vi.mock("@ibatexas/domain", () => ({
  SECURITY_PROBE_KIND: "security_probe",
}));

vi.mock("../../conversation/no-delivery.js", () => ({
  openIncidentInline: mockOpenIncidentInline,
}));

// Drive the REAL withDedup against a fake Redis so the committed TTLs are
// observable: EX=300 (in-flight claim) vs EX=604800 (7-day "processed").
vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({ set: mockRedisSet, del: mockRedisDel })),
  rk: (k: string) => `test:${k}`,
}));

import {
  startSecurityProbeSubscriber,
  classifySecurityProbe,
  SECURITY_BASIS_CODES,
} from "../../subscribers/security-probe-subscriber.js";
import { EXTRACTION_FAILURE_KIND } from "../../claustrum/model-call-defaults.js";

const FULL_TTL = 604_800;
const SESSION = "wa:5511999999999";

/** An audit record for a customer-plane turn. Defaults to the SCN-109 shape. */
function auditRecord(over: Record<string, unknown> = {}) {
  return {
    intentHash: "hash_1",
    at: "2026-07-25T12:00:00.000Z",
    envelope: {
      kind: "order.status.read",
      actor: { principal: "llm", sessionId: SESSION },
    },
    decision: { kind: "REFUSE" },
    decision_basis: [{ category: "auth", code: "scope_insufficient" }],
    ...over,
  };
}

async function getHandler(): Promise<(payload: unknown) => Promise<void>> {
  await startSecurityProbeSubscriber();
  return natsHandlers["audit.intent.decision.v1"]!;
}

function committedFullTtl(): boolean {
  return mockRedisSet.mock.calls.some(
    ([, , opts]) => (opts as { EX?: number } | undefined)?.EX === FULL_TTL,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedisSet.mockResolvedValue("OK"); // phase-1 claim (SET NX) succeeds
  mockOpenIncidentInline.mockResolvedValue({ kind: "opened", incidentId: "inc_sec" });
});

describe("classifySecurityProbe — POSITIVE: the SCN-106/109 refusal classes", () => {
  it("[SCN-109] a cross-customer scope refusal on a customer turn qualifies", () => {
    const out = classifySecurityProbe(auditRecord());
    expect(out).not.toBeNull();
    expect(out?.sessionId).toBe(SESSION);
    expect(out?.matchedBasis).toEqual(["auth.scope_insufficient"]);
  });

  it("[SCN-106] a taint-floor refusal on a customer turn qualifies", () => {
    const out = classifySecurityProbe(
      auditRecord({
        envelope: { kind: "payment.refund.confirm", actor: { principal: "llm", sessionId: SESSION } },
        decision_basis: [{ category: "taint", code: "level_insufficient" }],
      }),
    );
    expect(out?.matchedBasis).toEqual(["taint.level_insufficient"]);
  });

  it("every member of the closed set qualifies on its own", () => {
    for (const entry of SECURITY_BASIS_CODES) {
      const [category, code] = entry.split(".");
      const out = classifySecurityProbe(
        auditRecord({ decision_basis: [{ category, code }] }),
      );
      expect(out, `expected ${entry} to qualify`).not.toBeNull();
    }
  });

  it("picks the security basis out of a mixed basis array", () => {
    const out = classifySecurityProbe(
      auditRecord({
        decision_basis: [
          { category: "business", code: "rule_violated" },
          { category: "taint", code: "level_insufficient" },
        ],
      }),
    );
    expect(out?.matchedBasis).toEqual(["taint.level_insufficient"]);
  });
});

describe("classifySecurityProbe — FALSE-POSITIVE WALL", () => {
  // The single most important test in the suite. An ordinary business refusal is
  // the overwhelmingly common REFUSE on this subject ("we don't deliver there",
  // "that item is 86'd"). If it opened an incident, the security journal would be
  // pure noise within a day.
  it("an ORDINARY BUSINESS REFUSAL creates no incident", () => {
    expect(
      classifySecurityProbe(
        auditRecord({ decision_basis: [{ category: "business", code: "rule_violated" }] }),
      ),
    ).toBeNull();
  });

  it("an extraction-wire failure creates no incident (a model hiccup, not an attack)", () => {
    // Critically, this carries the SAME taint.level_insufficient basis a genuine
    // injection produces — only the sentinel kind tells them apart.
    expect(
      classifySecurityProbe(
        auditRecord({
          envelope: {
            kind: EXTRACTION_FAILURE_KIND,
            actor: { principal: "llm", sessionId: SESSION },
          },
          decision_basis: [{ category: "taint", code: "level_insufficient" }],
        }),
      ),
    ).toBeNull();
  });

  it("a STAFF/ops envelope creates no incident (authenticated internal actor)", () => {
    expect(
      classifySecurityProbe(
        auditRecord({
          envelope: {
            kind: "product.availability.set",
            actor: { principal: "user", sessionId: "admin:staff_7" },
          },
        }),
      ),
    ).toBeNull();
  });

  it("a SYSTEM envelope creates no incident (subscribers/jobs)", () => {
    expect(
      classifySecurityProbe(
        auditRecord({
          envelope: {
            kind: "incident.ticket.open",
            actor: { principal: "system", sessionId: "conversation.no_delivery:t1" },
          },
        }),
      ),
    ).toBeNull();
  });

  it("an EXECUTE carrying a taint basis creates no incident (it was permitted)", () => {
    expect(
      classifySecurityProbe(
        auditRecord({
          decision: { kind: "EXECUTE" },
          decision_basis: [{ category: "taint", code: "level_permitted" }],
        }),
      ),
    ).toBeNull();
  });

  it("state / ledger / schema / identity refusals create no incident", () => {
    for (const b of [
      { category: "state", code: "transition_illegal" },
      { category: "ledger", code: "replay_suppressed" },
      { category: "schema", code: "payload_invalid" },
      { category: "auth", code: "identity_missing" },
      { category: "validation", code: "pii_redacted" },
    ]) {
      expect(
        classifySecurityProbe(auditRecord({ decision_basis: [b] })),
        `expected ${b.category}.${b.code} to be ignored`,
      ).toBeNull();
    }
  });

  it("a malformed record is ignored rather than opening a junk incident", () => {
    expect(classifySecurityProbe({})).toBeNull();
    expect(classifySecurityProbe(auditRecord({ decision_basis: "nope" }))).toBeNull();
    expect(classifySecurityProbe(auditRecord({ intentHash: undefined }))).toBeNull();
    expect(
      classifySecurityProbe(
        auditRecord({ envelope: { kind: "x", actor: { principal: "llm" } } }),
      ),
    ).toBeNull();
  });
});

describe("security-probe-subscriber — emission + exactly-once", () => {
  it("opens EXACTLY ONE incident on the security journal", async () => {
    const handler = await getHandler();
    await handler(auditRecord());

    expect(mockOpenIncidentInline).toHaveBeenCalledTimes(1);
    const [signal, , journalKind] = mockOpenIncidentInline.mock.calls[0]!;
    expect(journalKind).toBe("security_probe");
    expect(signal).toMatchObject({
      sessionId: SESSION,
      cause: "security_probe",
      // The customer WAS answered (with the refusal) — never a ghost.
      customerImpacted: false,
      decisionKind: "REFUSE",
    });
    // The reviewing human needs to see WHAT boundary fired, and it must be
    // kernel vocabulary only — never customer text (no PII in the journal).
    expect(signal.detail).toContain("auth.scope_insufficient");
    expect(signal.detail).toContain("order.status.read");
    expect(committedFullTtl()).toBe(true);
  });

  it("a SECOND identical record does NOT open a duplicate", async () => {
    const handler = await getHandler();
    await handler(auditRecord());
    expect(mockOpenIncidentInline).toHaveBeenCalledTimes(1);

    // Redelivery: the 7-day key is already committed → the claim (SET NX) fails.
    mockRedisSet.mockResolvedValue(null);
    await handler(auditRecord());

    expect(mockOpenIncidentInline).toHaveBeenCalledTimes(1);
  });

  it("an ordinary business refusal reaching the subject opens NOTHING", async () => {
    const handler = await getHandler();
    await handler(
      auditRecord({ decision_basis: [{ category: "business", code: "rule_violated" }] }),
    );

    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
    // Not even a dedup key is burned on a non-probe.
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("does NOT commit the dedup key and rethrows on a transient open failure", async () => {
    mockOpenIncidentInline.mockResolvedValue({ kind: "error", error: new Error("db down") });
    const handler = await getHandler();

    // Surfaced, not swallowed → JetStream redelivers / Core DLQs. A lost security
    // row is the exact failure this subscriber exists to prevent.
    await expect(handler(auditRecord())).rejects.toThrow();
    expect(committedFullTtl()).toBe(false);
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it("commits the dedup key when the domain collapses a duplicate", async () => {
    mockOpenIncidentInline.mockResolvedValue({ kind: "duplicate" });
    const handler = await getHandler();
    await handler(auditRecord());

    expect(committedFullTtl()).toBe(true);
  });

  it("a governance REFUSE of the open itself is surfaced, not retried forever", async () => {
    mockOpenIncidentInline.mockResolvedValue({ kind: "refused", cause: "security_probe", code: "X" });
    const handler = await getHandler();

    await expect(handler(auditRecord())).resolves.toBeUndefined();
    expect(committedFullTtl()).toBe(true);
  });
});
