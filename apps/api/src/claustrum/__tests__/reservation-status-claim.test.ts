/**
 * FE-T17 — the RESERVATION_STATUS claim type: registry row + validator + template
 * + honest-abstain, built over `get_my_reservations` (previously a read tool with
 * no claim/render path). Mirrors the PAYMENT_STATUS / ORDER_FULFILLMENT_STAGE test
 * shape (tracka-tag-derive.test.ts, tracka-fix-actor-subject.test.ts):
 *
 *   1. Registry row shape (SDD §E worked types) + STEP 3 key-alignment.
 *   2. Proposable/renderable subset membership (BKL-112 — the pre-existing
 *      unit-test-only subset the T16 boot gate will later promote).
 *   3. A seeded reservation VALIDATES + renders (all four slots: date, time,
 *      party size, pt-BR-localized status) — driven through the REAL planner +
 *      the LINKED `@adjudicate/core` kernel, not a stub.
 *   4. Absent reservation → SAFE_UNKNOWN (honest-abstain, never a fabricated fact).
 *   5. The validator (the kernel's C6 value-binding conjunct) REJECTS a tampered /
 *      ungrounded reservation claim — a model-authored value that disagrees with
 *      the ledger's licensing evidence → REFUSED, never rendered.
 *   6. Non-owner (IDOR) — a cross-owner read-error and a present-but-unowned value
 *      BOTH degrade SAFE, never leaking another customer's reservation.
 *   7. FIX 2 subject correction generically covers reservations (0 / 1 / ≥2 owned)
 *      because RESERVATION_STATUS is declared `perResourceKey` + ownership
 *      `"required"` — no planner code change was needed for this to work.
 *
 * Pure unit tests — a hand-built `ModelProvider` mock + real `EvidenceLedger`;
 * no DB / no live model.
 */

import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import type {
  ClaimPlannerInput,
  CognitiveState,
  Completion,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import {
  CLAIM_REGISTRY,
  REGISTRY_SPECS,
  selectCandidateClaim,
} from "../claim-registry.js";
import { CLAIM_DEFINITIONS } from "../claim-definition-registry.js";
import { VALIDATED_TEMPLATES } from "../slot-grammar.js";
import {
  createIbatexasPlanner,
  PROPOSE_CLAIM_TOOL,
  type ClaimAuthContext,
} from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import { createPerTurnClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
import { render } from "../renderer-from-claims.js";

// ── Test doubles ──────────────────────────────────────────────────────────────

function mockModel(toolCalls: Completion["toolCalls"]): ModelProvider {
  return {
    async complete(): Promise<Completion> {
      return {
        model: "mock",
        stopReason: "tool_use",
        text: "",
        toolCalls,
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    stream() {
      throw new Error("not used");
    },
    async embed() {
      return [];
    },
  };
}

function state(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-16T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

function claimCall(input: unknown): NonNullable<Completion["toolCalls"]>[number] {
  return { id: "tc-1", name: PROPOSE_CLAIM_TOOL, input };
}

function planner(toolCalls: Completion["toolCalls"]) {
  return createIbatexasPlanner({
    model: mockModel(toolCalls),
    modelId: "mock",
    capabilityPlanners: [],
  });
}

const NOW = 20_000;

const RESERVATION_VALUE = {
  reservationId: "res-A",
  status: "confirmed",
  partySize: 4,
  date: "2026-07-20",
  startTime: "19:30",
};

/** Record the per-resource RESERVATION_STATUS entry the investigator mints —
 *  keyed `reservation_status:{reservationId}`, value = the whole ReservationRead. */
function recordReservation(
  ledger: EvidenceLedger,
  reservationId: string,
  value: Record<string, unknown> = RESERVATION_VALUE,
): void {
  ledger.record({
    key: `reservation_status:${reservationId}`,
    value: { ...value, reservationId },
    source: "reservation.getById",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

// ── (1) Registry row shape (SDD §E worked types) ────────────────────────────────

describe("FE-T17 — RESERVATION_STATUS registry row", () => {
  it("is a registered proposable type", () => {
    expect(CLAIM_REGISTRY).toContain("RESERVATION_STATUS");
  });

  it("declares the owner-scoped, must-read-this-turn read_claim shape", () => {
    const spec = REGISTRY_SPECS.RESERVATION_STATUS;
    expect(spec.kind).toBe("read_claim");
    expect(spec.customerScoped).toBe(true);
    expect(spec.perResourceKey).toBe(true);
    expect(spec.requiredEvidence).toHaveLength(1);
    expect(spec.requiredEvidence[0]?.key).toBe("reservation_status");
    expect(spec.requiredEvidence[0]?.ownershipPolicy).toBe("required");
    expect(spec.requiredEvidence[0]?.freshnessPolicy).toBe("must_read_this_turn");
    // C0 — requiredEvidence is non-empty (a registry type can never validate vacuously).
    expect(spec.requiredEvidence.length).toBeGreaterThan(0);
  });

  it("declares honest falsifier-completeness (the W6 eligibility cap requirement)", () => {
    const spec = REGISTRY_SPECS.RESERVATION_STATUS;
    // Without this, the kernel caps the claim to UNKNOWN-only forever (soundness.ts
    // "falsifier-completeness... else the all-pass path is CAPPED to UNKNOWN") — a
    // seeded reservation could never VALIDATE without this declaration.
    expect(spec.falsifierComplete).toBe(true);
    expect(spec.falsifiers?.length).toBeGreaterThan(0);
  });

  it("binds the rendered value to the read's `status` field (ledger-sourced)", () => {
    expect(REGISTRY_SPECS.RESERVATION_STATUS.valueBinding).toEqual({
      key: "reservation_status",
      path: ["status"],
    });
    // valueBinding.key stays a member of requiredEvidence (C6 structural guard).
    expect(
      REGISTRY_SPECS.RESERVATION_STATUS.requiredEvidence.map((e) => e.key),
    ).toContain(REGISTRY_SPECS.RESERVATION_STATUS.valueBinding?.key);
  });

  it("STEP 3 key alignment: parameterizes requiredEvidence/falsifiers/valueBinding by subject", () => {
    const candidate = selectCandidateClaim({
      type: "RESERVATION_STATUS",
      subject: "res-42",
      actor: "cust-1",
      value: undefined,
    }) as CandidateClaim;
    expect(candidate.soundness.requiredEvidence[0]?.key).toBe(
      "reservation_status:res-42",
    );
    expect(candidate.soundness.valueBinding?.key).toBe("reservation_status:res-42");
    expect(candidate.soundness.falsifiers?.map((f) => f.key)).toEqual([
      "reservation_cancelled:res-42",
    ]);
  });

  it("every CLAIM_REGISTRY member (including RESERVATION_STATUS) selects", () => {
    for (const type of CLAIM_REGISTRY) {
      expect(
        selectCandidateClaim({ type, subject: "s", actor: null, value: 1 }),
        `registry type ${type} must select`,
      ).toBeDefined();
    }
  });
});

// ── (2) Proposable/renderable subset membership (BKL-112) ──────────────────────

describe("FE-T17 — registered in the proposable/renderable subset", () => {
  it("RESERVATION_STATUS is both proposable (registry) and renderable (a validated template)", () => {
    expect(CLAIM_REGISTRY).toContain("RESERVATION_STATUS");
    expect(Object.keys(VALIDATED_TEMPLATES)).toContain("RESERVATION_STATUS");
  });

  it("is marked Triad-scoped in the assembled ClaimDefinition registry", () => {
    expect(CLAIM_DEFINITIONS.RESERVATION_STATUS.triadScoped).toBe(true);
  });
});

// ── (3) Seeded reservation → VALIDATED render ───────────────────────────────────

describe("FE-T17 — a seeded reservation VALIDATES and renders (end-to-end via the adapter)", () => {
  it("derives actor + subject + value from the authenticated owner-scoped ledger, VALIDATEs, and renders pt-BR text", async () => {
    // The 4B emits TYPE-ONLY with an EMPTY subject — exactly like ORDER/PAYMENT
    // (the tool schema carries no `value`; the model never authors one).
    const adapter = createIbatexasClaimPlanner(
      planner([claimCall({ type: "RESERVATION_STATUS", subject: "" })]),
    );

    const ledger = new EvidenceLedger("turn-1");
    recordReservation(ledger, "res-A");
    const input: ClaimPlannerInput = {
      cognition: state("qual minha reserva?"),
      plan: { envelopes: [] } as Plan,
      customerId: "cust-A",
      ledger,
    };

    const candidates = normalizeClaimPlannerResult(await adapter.propose(input)).candidates;

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0] as CandidateClaim;
    // FIX 1 — actor is the AUTHENTICATED principal, never "llm".
    expect(candidate.soundness.actor).toMatchObject({ principal: "cust-A" });
    // FIX 2 — subject bound from the owner-scoped read (customer owns exactly one).
    expect(candidate.subject).toBe("res-A");
    expect(candidate.soundness.valueBinding?.key).toBe("reservation_status:res-A");
    // Owner-positive close — value is the FIRST-PARTY ledger value (never model-authored).
    expect(candidate.value).toMatchObject({ status: "confirmed", partySize: 4 });

    const result = runClaimsKernel(
      ledger,
      candidates,
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "cust-A", ownedResources: new Set(["res-A"]) },
        outcomes: [],
      }),
    );

    expect(result.perClaim[0]?.verdict).toBe("VALIDATED");
    expect(result.terminal).toBe("RENDER");
    expect(result.renderable).toHaveLength(1);

    const out = render(result.renderableCanonical, result.terminal);
    // F3 — the DISPLAYED status is pt-BR localized; the raw English enum never
    // reaches the customer.
    expect(out.text).toBe("O status da sua reserva é: confirmada.");
    expect(out.text).not.toContain("confirmed");
    // F2 (linked kernel narrowing, kernels.js) — the mint carries ONLY the
    // C6-bound `status` field; the ledger entry's OTHER fields (partySize,
    // reservationId) never reach the renderer, even though they rode in the same
    // first-party read. Proves the single-slot template design is not merely a
    // stylistic choice but load-bearing: those siblings are structurally
    // unreachable via `unwrapCanonical` post-mint.
    expect(out.text).not.toContain("res-A");
    expect(result.renderableCanonical[0]?.value).toEqual({ status: "confirmed" });
  });
});

// ── (4) Absent reservation → SAFE_UNKNOWN (honest-abstain) ─────────────────────

describe("FE-T17 — no reservation on record → SAFE_UNKNOWN, never a fabricated fact", () => {
  it("a candidate with no backing ledger entry degrades to the proposition-free UNKNOWN template", () => {
    const candidate = selectCandidateClaim({
      type: "RESERVATION_STATUS",
      subject: "res-none",
      actor: { principal: "cust-A" },
      value: undefined,
    }) as CandidateClaim;

    // Empty ledger — the read never happened / found nothing this turn.
    const ledger = new EvidenceLedger("turn-2");
    const result = runClaimsKernel(
      ledger,
      [candidate],
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "cust-A", ownedResources: new Set(["res-none"]) },
        outcomes: [],
      }),
    );

    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderableCanonical, result.terminal);
    // Exact-match the safe (proposition-free) template — no reservation fact rides
    // in the epistemic self-report, and the report's own boilerplate wording
    // ("...confirmada agora...") is NOT a leaked status (asserted by exact match,
    // not substring, to avoid a false-positive collision with that wording).
    expect(out.text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
  });
});

// ── (5) The validator REJECTS a tampered / ungrounded reservation claim ────────

describe("FE-T17 — the validator (C6) REJECTS a tampered reservation claim", () => {
  it("REFUSED when a NON-derived (model-authored) value contradicts the ledger's licensing evidence", () => {
    // Bypass the owner-positive value-bind: build the candidate DIRECTLY with a
    // value that disagrees with the ledger (the tamper — e.g. a forged claim
    // asserting "cancelled" while the ledger says "confirmed").
    const tampered = selectCandidateClaim({
      type: "RESERVATION_STATUS",
      subject: "res-A",
      actor: "cust-A",
      resources: { "reservation_status:res-A": "res-A" },
      value: { status: "cancelled" },
    }) as CandidateClaim;

    const ledger = new EvidenceLedger("turn-3");
    recordReservation(ledger, "res-A"); // ledger says "confirmed"

    const result = runClaimsKernel(
      ledger,
      [tampered],
      createPerTurnClaimsKernelDeps({
        now: NOW,
        ownership: { principal: "cust-A", ownedResources: new Set(["res-A"]) },
        outcomes: [],
      }),
    );

    // C6 dominates: an over-claim contradicting its licensing evidence → REFUSED.
    expect(result.perClaim[0]?.verdict).toBe("REFUSED");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).not.toContain("cancelled");
    expect(out.text).not.toContain("cancelada");
  });
});

// ── (6) Non-owner (IDOR) degrades SAFE — never another customer's reservation ──

describe("FE-T17 — a non-owner RESERVATION_STATUS degrades SAFE (IDOR-safe)", () => {
  function mallorysCandidate(): CandidateClaim {
    return selectCandidateClaim({
      type: "RESERVATION_STATUS",
      subject: "res-OWNER",
      actor: "mallory",
      resources: { "reservation_status:res-OWNER": "res-OWNER" },
      value: { status: "confirmed" },
    }) as CandidateClaim;
  }

  function mallorysDeps() {
    return createPerTurnClaimsKernelDeps({
      now: NOW,
      // owns is built from MALLORY's owner-confirmed reads — NOT the owner's reservation.
      ownership: { principal: "mallory", ownedResources: new Set(["res-mallory"]) },
      outcomes: [],
    });
  }

  it("read-ERROR (cross-owner read refused) → UNKNOWN, never the owner's data", () => {
    const ledger = new EvidenceLedger("turn-4a");
    ledger.recordError(
      "reservation_status:res-OWNER",
      "reservation_status unavailable for this customer (not owned or absent): res-OWNER",
    );

    const result = runClaimsKernel(ledger, [mallorysCandidate()], mallorysDeps());
    expect(result.perClaim[0]?.verdict).toBe("UNKNOWN");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).not.toContain("confirmed");
  });

  it("present value but owns=false (the owns predicate itself) → not VALIDATED, no leak", () => {
    const ledger = new EvidenceLedger("turn-4b");
    recordReservation(ledger, "res-OWNER");

    const result = runClaimsKernel(ledger, [mallorysCandidate()], mallorysDeps());
    expect(result.perClaim[0]?.verdict).not.toBe("VALIDATED");
    expect(result.renderable).toHaveLength(0);
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).not.toContain("confirmed");
    // Exact-match (not substring) — the safe template's OWN wording happens to
    // contain "confirmada" ("...informação confirmada agora...", unrelated to a
    // reservation status), so a substring check would false-positive here.
    expect(out.text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
  });
});

// ── (7) FIX 2 subject correction generically covers reservations ───────────────
//
// No code change was needed in ibatexas-planner.ts: `ownerScopedBaseKey` derives
// the base key from `perResourceKey` + a `required`-ownership requirement, which
// RESERVATION_STATUS's registry row already declares. These tests prove the
// generic mechanism actually reaches reservations.

describe("FE-T17 FIX 2 — exactly ONE owned reservation → auto-bind, never a guess", () => {
  it("an empty model subject resolves to the customer's single owned reservation", async () => {
    const p = planner([claimCall({ type: "RESERVATION_STATUS", subject: "" })]);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["reservation_status", ["res-A"]]]),
    };
    const plan = await p.proposeClaims(state("qual minha reserva?"), auth);
    expect(plan.forcedTerminal).toBeUndefined();
    expect((plan.candidates[0] as CandidateClaim).subject).toBe("res-A");
    expect((plan.candidates[0] as CandidateClaim).soundness.actor).toMatchObject({
      principal: "cust-A",
    });
  });
});

describe("FE-T17 FIX 2 — ZERO owned reservations → kept as-is, kernel refuses (no leak)", () => {
  it("0 owned: the model's (possibly forged) subject is kept, never silently swapped", async () => {
    const p = planner([
      claimCall({ type: "RESERVATION_STATUS", subject: "res-guessed" }),
    ]);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map(), // 0 owned → no admissible owner-scoped subject
    };
    const plan = await p.proposeClaims(state("qual minha reserva?"), auth);
    expect(plan.candidates).toHaveLength(1);
    // Kept AS-IS (not silently swapped for someone else's) — the kernel's owner-scoped
    // owns then refuses it (proven in section 6 above; not re-proven here).
    expect((plan.candidates[0] as CandidateClaim).subject).toBe("res-guessed");
  });
});

describe("FE-T17 FIX 2 — MULTIPLE owned reservations, no unambiguous model match → CLARIFY", () => {
  it("≥2 owned relevant reservations and an empty model subject → CLARIFY, emits no candidate", async () => {
    const p = planner([claimCall({ type: "RESERVATION_STATUS", subject: "" })]);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["reservation_status", ["res-A1", "res-A2"]]]),
    };

    const plan = await p.proposeClaims(state("qual minha reserva?"), auth);

    // Never a guess: the ambiguous owner-scoped proposal is dropped, the turn
    // degrades to CLARIFY (ask which reservation) — exactly like ORDER_FULFILLMENT_STAGE.
    expect(plan.forcedTerminal).toBe("CLARIFY");
    expect(
      plan.candidates.some((c) => c.type === "RESERVATION_STATUS"),
    ).toBe(false);
  });

  it("a model id IS honored when it unambiguously names one of the ≥2 owned reservations", async () => {
    const p = planner([
      claimCall({ type: "RESERVATION_STATUS", subject: "res-A2" }),
    ]);
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["reservation_status", ["res-A1", "res-A2"]]]),
    };
    const plan = await p.proposeClaims(state("como está minha reserva de amanhã?"), auth);
    expect(plan.forcedTerminal).toBeUndefined();
    expect((plan.candidates[0] as CandidateClaim).subject).toBe("res-A2");
  });
});
