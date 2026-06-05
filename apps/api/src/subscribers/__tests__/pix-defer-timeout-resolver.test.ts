// Unit tests for the PIX defer-timeout resolver subscriber — audit-2026-05-24 P1-7.
//
// Coverage:
//   - signal_mismatch → skipped (other DEFER kinds share the channel)
//   - missing intentHash → skipped (malformed minimal timeout)
//   - PIX signal + intentHash → audit record emitted with supersedes chain
//
// The PIX resolver bridges `intent.defer.timeout` (published by the
// defer-timeout-sweeper) to the audit trail for PIX parks whose customer
// never paid. It is intentionally NOT a DB-mutation path — pix-expiry-checker
// owns the kernel-gated `payment.status.transition`.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const mockAuditSinkEmit = vi.hoisted(() => vi.fn(async () => undefined));

// WS5 (claustrum-on-dev): the SUT (`pix-defer-timeout-resolver.ts`) reads
// `getAuditSink` from `@ibatexas/audit-sink` (the real one is fail-closed before
// boot wiring), so the audit spy must be installed there. The
// `@ibatexas/llm-provider` mock is kept import-safe so we don't drag in the full
// LLM tool registry / @ibatexas/domain via any transitive import.
vi.mock("@ibatexas/audit-sink", () => ({
  getAuditSink: () => ({ emit: mockAuditSinkEmit }),
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: mockAuditSinkEmit }),
}));

vi.mock("twilio", () => ({
  default: () => ({}),
}));

// ── SUT ────────────────────────────────────────────────────────────────────

import { handlePixDeferTimeout } from "../pix-defer-timeout-resolver.js";
import { PIX_CONFIRMATION_SIGNAL } from "@adjudicate/pack-payments-pix";

function makeEvent(
  overrides?: Partial<{
    signal: string;
    sessionId: string;
    intentHash: string;
    parkedAt: string;
  }>,
) {
  return {
    eventType: "intent.defer.timeout" as const,
    sessionId: overrides?.sessionId ?? "sess_pix_01",
    intentHash:
      overrides?.intentHash ?? "ih_pix_01".padEnd(64, "0"),
    signal: overrides?.signal ?? PIX_CONFIRMATION_SIGNAL,
    parkedAt: overrides?.parkedAt ?? "2026-05-22T12:00:00Z",
    timestamp: "2026-05-22T12:15:00Z",
  };
}

describe("handlePixDeferTimeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skipped on signal_mismatch — other DEFER kinds share the timeout channel", async () => {
    // The anonymize-grace channel uses the same NATS subject; this resolver
    // MUST filter by signal so the two paths don't double-handle each other.
    const event = makeEvent({
      signal: "customer.anonymize.confirmed_after_grace",
    });
    const out = await handlePixDeferTimeout(event);

    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("signal_mismatch");
    }
    expect(mockAuditSinkEmit).not.toHaveBeenCalled();
  });

  it("skipped on missing intentHash — malformed minimal timeout has no anchor to audit", async () => {
    // The sweeper publishes a minimal timeout when the parked blob is
    // malformed (no intentHash). We can't build a supersedes chain without
    // it, so we skip the audit emit and rely on the log line for visibility.
    const event = makeEvent({ intentHash: "" });
    const out = await handlePixDeferTimeout(event);

    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("missing_intent_hash");
    }
    expect(mockAuditSinkEmit).not.toHaveBeenCalled();
  });

  it("audited on PIX signal + intentHash — emits a record linking the timeout to the parked envelope", async () => {
    const event = makeEvent();
    const out = await handlePixDeferTimeout(event);

    expect(out.kind).toBe("audited");
    if (out.kind === "audited") {
      expect(out.sessionId).toBe(event.sessionId);
      expect(out.intentHash).toBe(event.intentHash);
    }

    // The audit record is emitted via `void getAuditSink().emit(...)` so
    // the promise is fire-and-forget. The mock still captures the call
    // synchronously because the emit is invoked before the function returns.
    expect(mockAuditSinkEmit).toHaveBeenCalledOnce();
    const record = (mockAuditSinkEmit.mock.calls as unknown as Array<
      [unknown]
    >)[0]![0] as {
      envelope: { kind: string; actor: { principal: string }; taint: string };
      supersedes?: {
        predecessorIntentHash: string;
        predecessorAt: string;
        reason: string;
      };
      decision: { kind: string };
    };

    // System-actor shape (CLAUDE.md rule #9).
    expect(record.envelope.actor.principal).toBe("system");
    expect(record.envelope.taint).toBe("SYSTEM");

    // The decision is EXECUTE because the timeout itself IS the
    // authorization for the audit record (not gated through adjudicate;
    // pix-expiry-checker owns the DB mutation path).
    expect(record.decision.kind).toBe("EXECUTE");

    // The supersedes chain points back to the parked envelope. We use the
    // framework's `defer_resumed` reason (the closest existing
    // SupersessionReason); the framework enum doesn't include a dedicated
    // `defer_timeout` value. Same convention as anonymize-grace-resolver.
    expect(record.supersedes).toBeTruthy();
    expect(record.supersedes!.predecessorIntentHash).toBe(event.intentHash);
    expect(record.supersedes!.predecessorAt).toBe(event.parkedAt);
    expect(record.supersedes!.reason).toBe("defer_resumed");
  });
});
