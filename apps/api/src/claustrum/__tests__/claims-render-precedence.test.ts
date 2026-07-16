// claims-render-precedence tests (BKL-155 / BKL-153; @claustrum/core 0.7.0).
//
// The RATIFIED precedence lattice (termprecdesign 2026-07-10) decides whether the
// claims render supersedes the responder draft. These tests pin, against the LINKED
// `@adjudicate/core` / `@claustrum/core` types (no stubs):
//   - each of the 4 lattice rules, TOP-WINS ordering, and the two tonight-live
//     acceptance fixtures (BKL-155 confirm-prompt survival; BKL-153 statement prose);
//   - NO regression of the two hard invariants the lattice must never weaken —
//     rule 1 (suppression / ESCALATE → safe render, no leak) and BKL-078 (an
//     info-question still safe-degrades on the render branch), plus BKL-110 (a
//     smalltalk 0/15 turn keeps its prose);
//   - the seam factory (`createIbatexasClaimsRenderPrecedence`) — the exact port
//     handleTurn 6a calls — returns the lattice's `render`/`keep_draft` and emits
//     ONE observe-only PII-free `claims.render_precedence` telemetry line.

import { describe, expect, it, vi } from "vitest";
import type {
  ClaimsKernelResult,
  ConsistencyClaim,
  Decision,
  IntentEnvelope,
  SuppressionRecord,
  TurnTerminal,
} from "@adjudicate/core";
import { buildEnvelope } from "@adjudicate/core";
import type { Plan } from "@claustrum/core";
import { logger } from "../../lib/logger.js";
import {
  decideRenderPrecedence,
  type RenderPrecedenceContext,
} from "../claims-render-precedence.js";
import { createIbatexasClaimsRenderPrecedence } from "../claims-renderer-adapter.js";

// ── Fixture builders (minimal, typed — the lattice reads only `claims.terminal`,
// `claims.consistency.suppressions`, `decision.kind`, `plan.envelopes.length`,
// `requestText`; everything else is filled to satisfy the published types). ──────

/** A minimal proposition-free set-gate suppression record (§O#5). */
function suppression(): SuppressionRecord {
  return {
    subject: "order-1",
    conflictTypes: ["ORDER_FULFILLMENT_STAGE", "PURCHASE_COMPLETED"],
    reason: "MUTUAL_EXCLUSION_CONFLICT",
    terminal: "UNKNOWN",
  };
}

/**
 * A minimal `ClaimsKernelResult` for the given terminal. `renderable` /
 * `renderableCanonical` / `perClaim` stay empty — the lattice reads neither; only
 * `terminal` and `consistency.suppressions` steer it.
 */
function claimsResult(
  terminal: TurnTerminal,
  suppressions: readonly SuppressionRecord[] = [],
): ClaimsKernelResult {
  const renderable: readonly ConsistencyClaim[] = [];
  return {
    perClaim: [],
    renderable,
    terminal,
    consistency: { renderable, terminal, suppressions },
    renderableCanonical: [],
  };
}

const execute = (): Decision => ({ kind: "EXECUTE", basis: [] });
const requestConfirmation = (): Decision => ({
  kind: "REQUEST_CONFIRMATION",
  prompt: "Identifiquei o item mais recente do seu pedido. Confirma o cancelamento?",
  basis: [],
});
const escalate = (): Decision => ({
  kind: "ESCALATE",
  to: "human",
  reason: "customer handoff",
  basis: [],
});
const refuse = (): Decision => ({
  kind: "REFUSE",
  refusal: {
    kind: "BUSINESS_RULE",
    code: "order.cancel.forbidden",
    userFacing: "Não é possível.",
  },
  basis: [],
});

function envelope(nonce: string): IntentEnvelope {
  return buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_1" },
    actor: { principal: "user", sessionId: "sess-1" },
    taint: "UNTRUSTED",
    nonce,
  });
}

/** A `Plan` carrying exactly `n` envelopes (only its length steers the lattice). */
function plan(n: number): Plan {
  return { envelopes: Array.from({ length: n }, (_, i) => envelope(`n-${i}`)) };
}

function ctx(over: Partial<RenderPrecedenceContext>): RenderPrecedenceContext {
  return {
    decision: over.decision ?? execute(),
    plan: over.plan ?? plan(0),
    claims: over.claims ?? claimsResult("UNKNOWN"),
    requestText: over.requestText ?? "",
  };
}

// ── Rule 1 — safety-first / no-leak (HARD invariant, checked FIRST) ─────────────

describe("lattice rule 1 — ESCALATE / suppression renders safe (no leak)", () => {
  it("claims terminal ESCALATE → render (safe), regardless of decision", () => {
    const v = decideRenderPrecedence(
      ctx({ decision: requestConfirmation(), claims: claimsResult("ESCALATE") }),
    );
    expect(v).toEqual({ decision: "render", mechanism: "claims_escalate_or_suppression" });
  });

  it("a set-gate suppression → render (safe), even on an UNKNOWN terminal", () => {
    const v = decideRenderPrecedence(
      ctx({ claims: claimsResult("UNKNOWN", [suppression()]) }),
    );
    expect(v).toEqual({ decision: "render", mechanism: "claims_escalate_or_suppression" });
  });

  it("rule 1 WINS over a live REQUEST_CONFIRMATION decision (no-leak > kernel reply)", () => {
    // A genuine suppression must never be withheld behind a kept draft — safety
    // outranks even the confirm-prompt precedence of rule 2.
    const v = decideRenderPrecedence(
      ctx({
        decision: requestConfirmation(),
        claims: claimsResult("UNKNOWN", [suppression()]),
        requestText: "cancela meu pedido",
      }),
    );
    expect(v.decision).toBe("render");
    expect(v.mechanism).toBe("claims_escalate_or_suppression");
  });

  it("rule 1 WINS over a REFUSE-with-envelopes turn (a REFUSE never leaks a suppression)", () => {
    const v = decideRenderPrecedence(
      ctx({ decision: refuse(), plan: plan(1), claims: claimsResult("ESCALATE") }),
    );
    expect(v.decision).toBe("render");
    expect(v.mechanism).toBe("claims_escalate_or_suppression");
  });
});

// ── Rule 2 — a live ACTION decision keeps the deterministic kernel reply ────────

describe("lattice rule 2 — live action decision keeps the draft (BKL-155)", () => {
  it("REQUEST_CONFIRMATION + spurious CLARIFY degrade → keep_draft (confirm prompt survives)", () => {
    // BKL-155: the claim-planner over-proposes a spurious PURCHASE_COMPLETED forcing
    // a CLARIFY degrade; without the lattice its safe copy hid the confirm prompt.
    const v = decideRenderPrecedence(
      ctx({
        decision: requestConfirmation(),
        claims: claimsResult("CLARIFY"),
        requestText: "cancela meu pedido",
      }),
    );
    expect(v).toEqual({ decision: "keep_draft", mechanism: "live_action_decision" });
  });

  it("REQUEST_CONFIRMATION + clean VALIDATED RENDER → keep_draft (wins even over a render)", () => {
    // Clean paid-cancel: no spurious claim, terminal RENDER — the kernel confirm
    // prompt is still the deliverable (rule 2 outranks rule 3).
    const v = decideRenderPrecedence(
      ctx({ decision: requestConfirmation(), claims: claimsResult("RENDER") }),
    );
    expect(v).toEqual({ decision: "keep_draft", mechanism: "live_action_decision" });
  });

  it("ESCALATE decision (human handoff) → keep_draft", () => {
    const v = decideRenderPrecedence(
      ctx({ decision: escalate(), claims: claimsResult("UNKNOWN") }),
    );
    expect(v).toEqual({ decision: "keep_draft", mechanism: "live_action_decision" });
  });

  it("REFUSE WITH ≥1 envelope → keep_draft (verbatim refusal is the deliverable)", () => {
    const v = decideRenderPrecedence(
      ctx({ decision: refuse(), plan: plan(1), claims: claimsResult("UNKNOWN") }),
    );
    expect(v).toEqual({ decision: "keep_draft", mechanism: "live_action_decision" });
  });

  it("REFUSE with an EMPTY plan is NOT a live action decision → falls through", () => {
    // A conversational refusal (no proposed mutation) is not rule 2; with a RENDER
    // terminal it renders the validated fact (rule 3).
    const v = decideRenderPrecedence(
      ctx({ decision: refuse(), plan: plan(0), claims: claimsResult("RENDER") }),
    );
    expect(v).toEqual({ decision: "render", mechanism: "validated_render" });
  });
});

// ── Rule 3 — a validated terminal renders (claims-not-prose) ────────────────────

describe("lattice rule 3 — conversational + VALIDATED RENDER → render", () => {
  it("EXECUTE (conversational) + terminal RENDER → render", () => {
    const v = decideRenderPrecedence(
      ctx({ decision: execute(), claims: claimsResult("RENDER") }),
    );
    expect(v).toEqual({ decision: "render", mechanism: "validated_render" });
  });
});

// ── Rule 4 — a conversational degrade: question renders safe, statement keeps prose

describe("lattice rule 4 — conversational degrade by request SHAPE", () => {
  it("BKL-153 'meu pedido chegou, obrigado!' (statement) → keep_draft (friendly prose)", () => {
    const v = decideRenderPrecedence(
      ctx({
        decision: execute(),
        claims: claimsResult("UNKNOWN"),
        requestText: "meu pedido chegou, obrigado!",
      }),
    );
    expect(v).toEqual({ decision: "keep_draft", mechanism: "conversational_prose" });
  });

  it("an info-question degrade → render (safe degrade — preserves BKL-078)", () => {
    const v = decideRenderPrecedence(
      ctx({
        decision: execute(),
        claims: claimsResult("UNKNOWN"),
        requestText: "vocês têm sushi?",
      }),
    );
    expect(v).toEqual({ decision: "render", mechanism: "safe_degrade" });
  });

  it("a CLARIFY degrade on a statement turn (no live decision) keeps prose", () => {
    const v = decideRenderPrecedence(
      ctx({
        decision: execute(),
        claims: claimsResult("CLARIFY"),
        requestText: "vou pagar com pix",
      }),
    );
    expect(v).toEqual({ decision: "keep_draft", mechanism: "conversational_prose" });
  });
});

// ── No-regression corpora (the two hard invariants + smalltalk) ─────────────────
//
// Mirrors the BKL-078 / BKL-110 corpora owned by interrogative-discriminator.test.ts
// (kept local so this file is self-contained). The lattice must route each exactly.

const BKL_078_INFO_QUESTIONS: readonly string[] = [
  "o combo família serve quantas pessoas?",
  "vocês fazem festa de aniversário com decoração?",
  "ainda tem picanha hoje?",
  "qual a promoção de hoje?",
  "vocês têm sushi?",
  "aceitam vale-refeição?",
  "quanto tempo tá demorando um pedido agora?",
  "vocês fazem entrega?",
  "tem estacionamento?",
  "qual o valor da picanha?",
  "me diz o cardápio",
  "quero saber se tem sobremesa",
  "are you open now?",
];

const BKL_110_SMALLTALK: readonly string[] = [
  "oi, tudo bem?",
  "e aí, beleza?",
  "tudo certo?",
  "como vai?",
  "boa noite!",
  "oi",
  "olá",
  "opa",
  "bom dia",
  "beleza?",
  "blz",
  "de boa",
  "obrigado!",
  "valeu",
  "tudo bem?",
];

describe("no-regression — BKL-078 info-questions still safe-degrade on the render branch", () => {
  it("all 13 info-questions render (safe degrade) on a conversational UNKNOWN turn", () => {
    expect(BKL_078_INFO_QUESTIONS).toHaveLength(13);
    for (const requestText of BKL_078_INFO_QUESTIONS) {
      const v = decideRenderPrecedence(
        ctx({ decision: execute(), claims: claimsResult("UNKNOWN"), requestText }),
      );
      expect(v).toEqual({ decision: "render", mechanism: "safe_degrade" });
    }
  });
});

describe("no-regression — BKL-110 smalltalk keeps prose (0/15 safe-degrades)", () => {
  it("all 15 smalltalk turns keep the draft on a conversational UNKNOWN turn", () => {
    expect(BKL_110_SMALLTALK).toHaveLength(15);
    const degraded = BKL_110_SMALLTALK.filter(
      (requestText) =>
        decideRenderPrecedence(
          ctx({ decision: execute(), claims: claimsResult("UNKNOWN"), requestText }),
        ).mechanism === "safe_degrade",
    );
    expect(degraded).toHaveLength(0);
  });
});

// ── The seam factory — the exact port handleTurn 6a calls ───────────────────────

describe("createIbatexasClaimsRenderPrecedence — seam factory + telemetry", () => {
  it("returns keep_draft for the BKL-155 confirm-prompt turn (spurious degrade)", () => {
    const port = createIbatexasClaimsRenderPrecedence();
    const decision = port({
      decision: requestConfirmation(),
      plan: plan(1),
      claims: claimsResult("CLARIFY"),
      requestText: "cancela meu pedido",
    });
    expect(decision).toBe("keep_draft");
  });

  it("returns keep_draft for the BKL-153 statement turn (friendly prose)", () => {
    const port = createIbatexasClaimsRenderPrecedence();
    const decision = port({
      decision: execute(),
      plan: plan(0),
      claims: claimsResult("UNKNOWN"),
      requestText: "meu pedido chegou, obrigado!",
    });
    expect(decision).toBe("keep_draft");
  });

  it("returns render for every BKL-078 info-question (render branch, no regression)", () => {
    const port = createIbatexasClaimsRenderPrecedence();
    for (const requestText of BKL_078_INFO_QUESTIONS) {
      const decision = port({
        decision: execute(),
        plan: plan(0),
        claims: claimsResult("UNKNOWN"),
        requestText,
      });
      expect(decision).toBe("render");
    }
  });

  it("emits ONE PII-free claims.render_precedence line carrying the decision + mechanism", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const port = createIbatexasClaimsRenderPrecedence();
      port({
        decision: requestConfirmation(),
        plan: plan(1),
        claims: claimsResult("CLARIFY"),
        requestText: "cancela meu pedido AGORA por favor",
      });
      const calls = spy.mock.calls.filter(
        (c) => (c[0] as { event?: string })?.event === "claims.render_precedence",
      );
      expect(calls).toHaveLength(1);
      const fields = calls[0]![0] as Record<string, unknown>;
      expect(fields).toMatchObject({
        component: "claims",
        event: "claims.render_precedence",
        decision: "keep_draft",
        mechanism: "live_action_decision",
        decisionKind: "REQUEST_CONFIRMATION",
        kernelTerminal: "CLARIFY",
        suppressionCount: 0,
        envelopeCount: 1,
      });
      // PII-free: neither the request text nor any rendered/claim text is logged.
      const serialized = JSON.stringify(fields);
      expect(serialized).not.toContain("cancela meu pedido");
    } finally {
      spy.mockRestore();
    }
  });
});
