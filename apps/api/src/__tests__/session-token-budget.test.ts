/**
 * F4 — session token-budget guard semantics (cost cap / ADR-120).
 *
 * Mirrors the guard composed into IBATEXAS_POLICY_PACKS in claustrum-bootstrap.ts
 * (sessionBudget = AGENT_SESSION_TOKEN_BUDGET, reads state.ctx.sessionTokensConsumed,
 * action REFUSE). The real guard is INERT in production until the claustrum
 * republish (TurnRecord token usage) + the planner threads sessionTokensConsumed
 * into the SystemState — see the bootstrap comment. This test locks the crossing
 * semantics enforcement will rely on the moment those land.
 */

import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { createTokenBudgetGuard } from "@adjudicate/primitives";

const BUDGET = 100_000;

// Same shape as the bootstrap guard (kept in sync with claustrum-bootstrap.ts).
const guard = createTokenBudgetGuard<string, unknown, unknown>({
  extractSessionTokens: (state) =>
    (state as { ctx?: { sessionTokensConsumed?: number } }).ctx
      ?.sessionTokensConsumed ?? 0,
  sessionBudget: BUDGET,
  action: "REFUSE",
  userFacing: "limite",
});

const envelope = buildEnvelope({
  kind: "order.note.add",
  payload: {},
  actor: { principal: "llm", sessionId: "s-1" },
  taint: "UNTRUSTED",
  nonce: "n-1",
});

describe("F4 session token-budget guard", () => {
  it("no-op (null) below budget — including the inert 0 / undefined / missing-ctx cases", () => {
    expect(guard(envelope, { ctx: { sessionTokensConsumed: 0 } })).toBeNull();
    expect(guard(envelope, { ctx: {} })).toBeNull();
    expect(guard(envelope, {})).toBeNull();
    expect(
      guard(envelope, { ctx: { sessionTokensConsumed: BUDGET - 1 } }),
    ).toBeNull();
  });

  it("REFUSE at and above budget (>=)", () => {
    expect(
      guard(envelope, { ctx: { sessionTokensConsumed: BUDGET } })?.kind,
    ).toBe("REFUSE");
    expect(
      guard(envelope, { ctx: { sessionTokensConsumed: BUDGET + 50_000 } })?.kind,
    ).toBe("REFUSE");
  });

  it("fails CLOSED on a non-finite meter (+Infinity >= budget → REFUSE)", () => {
    expect(
      guard(envelope, {
        ctx: { sessionTokensConsumed: Number.POSITIVE_INFINITY },
      })?.kind,
    ).toBe("REFUSE");
  });
});
