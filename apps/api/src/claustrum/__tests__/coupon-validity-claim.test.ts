// coupon-validity-claim.test.ts — LE2-019 / spec Decision 18: the customer-plane
// COUPON_VALID / COUPON_INVALID claims.
//
// WHAT THIS TICKET SHIPS: "o cupom X1234 vale?" is answered from a GROUNDED
// promotion lookup — valid codes render with their real discount terms, invalid
// codes get an honest no, an unreadable lookup gets an honest UNKNOWN — and
// validity is discoverable WITHOUT attempting an apply (Decision 18). Decision 14
// bounds it: `coupon_on_placed_order` ships OFF, so nothing here applies a coupon,
// mutates a cart, or adjusts a price.
//
//   1. Registry rows (public fixed-key, live, W6-complete, C6-bound) + plane scope.
//   2. Proposable AND renderable — both templates — plus the DECISION 14 negative
//      space asserted as a property of the whole registry, not a comment.
//   3. The span classifier: validity questions fire; an APPLY imperative does not.
//   4. Investigator recording: exactly one of the complementary pair, the
//      needs-CODE marker for the clarify branch, and NOTHING on an unreadable read.
//   5. THE TURN SEAM, THROUGH THE PRODUCTION `claims-renderer-adapter` — all three
//      branches plus unresolvable input.
//
// WHY THE ADAPTER AND NOT `renderer-from-claims` DIRECTLY (the LE2-002 lesson,
// found and fixed on this branch): the §O#15 required-completeness gate lives in
// `createIbatexasClaimsRenderer`, one layer ABOVE the pure renderer. LE2-002's
// suite called `render(...)` directly, so its complementary pair could be — and
// was — missing from PRESENCE_COMPLEMENT_PAIRS while every renderer-level test
// stayed green: the feature was structurally dead through the gate (every coverage
// turn degraded RENDER→UNKNOWN) and CI never noticed. Every render assertion below
// therefore goes through the REAL adapter, which is the only place that defect can
// surface. The pair's PRESENCE_COMPLEMENT_PAIRS registration is asserted directly
// too, so a future deletion trips a NAMED test rather than a mystery.
//
// The resolver's own four-branch behaviour, the shared rejection classes and the
// feasibility predicate live in the sibling `coupon-validity-resolver.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceLedger, runClaimsKernel } from "@adjudicate/core";
import type {
  ClaimPlannerInput,
  ClaimsRendererPort,
  CognitiveState,
  Completion,
  InvestigateInput,
  ModelProvider,
  Plan,
} from "@claustrum/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import {
  CLAIM_REGISTRY,
  CUSTOMER_CLAIM_SCOPE,
  REGISTRY_SPECS,
  selectCandidateClaim,
} from "../claim-registry.js";
import {
  SAFE_CLARIFY_COUPON_CODE_TEMPLATE,
  SAFE_TEMPLATES,
  VALIDATED_TEMPLATES,
} from "../slot-grammar.js";
import {
  checkRequiredClaimCompleteness,
  classifyRequestSpans,
  decomposeRequiredClaims,
  isCouponValidityAsk,
} from "../required-claim-decomposer.js";
import {
  CLASSIFY_ONLY_ELIGIBLE_TYPES,
  CLASSIFY_ONLY_READS_ENABLED_ENV,
  buildClassifyOnlyCandidates,
  classifyOnlyRequiredTypes,
  couponValidityNeedsCode,
} from "../classify-only-reads.js";
import { createIbatexasClaimsRenderer } from "../claims-renderer-adapter.js";
import { createIbatexasPlanner, PROPOSE_CLAIM_TOOL } from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import {
  buildPerTurnOwnsFromLedger,
  createPerTurnClaimsKernelDeps,
} from "../ibatexas-claims-kernel-deps.js";
import {
  createFirstPartyTurnReads,
  createIbatexasInvestigator,
} from "../ibatexas-investigator.js";
import type { TriadReadBackend } from "../turn-reads.js";
import {
  composeCouponInvalidText,
  composeCouponValidText,
  COUPON_INVALID_KEY,
  COUPON_NEEDS_CODE_MARKER_KEY,
  COUPON_VALID_KEY,
  evaluateCouponFeasibility,
  resolveCouponValidity,
  type CouponValidityResolution,
} from "../coupon-validity-resolver.js";

// Mock ONLY the resolver seam the investigator/planner consume (the one IO edge —
// the promotion lookup); everything else in the module stays real, so the composed
// scalars under test are the REAL ones.
vi.mock("../coupon-validity-resolver.js", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("../coupon-validity-resolver.js")>();
  return {
    ...orig,
    resolveCouponValidity: vi.fn(async () => ({ kind: "unknown" }) as const),
  };
});

const NOW = 20_000;
const COUPON_Q = "o cupom BEMVINDO15 vale?";

/** The live welcome coupon (packages/tools welcome-credit.ts): R$ 15 fixed. */
const VALID_COUPON: CouponValidityResolution = {
  kind: "valid",
  validityText: composeCouponValidText({
    code: "BEMVINDO15",
    termsText: "R$ 15,00 de desconto",
  }),
  code: "BEMVINDO15",
};

const INVALID_COUPON: CouponValidityResolution = {
  kind: "invalid",
  invalidityText: composeCouponInvalidText("XPTO123"),
  code: "XPTO123",
};

/** The THREE branch renders, verbatim — the customer-facing contract this ticket
 *  ships. A change to any of these strings is a deliberate copy decision. */
const VALID_RENDER =
  "Sim, o cupom BEMVINDO15 está válido — R$ 15,00 de desconto. " +
  "É só informar o código no checkout.";
const INVALID_RENDER =
  "O cupom XPTO123 não está válido — se você tiver outro código, me manda que eu confiro.";
const CLARIFY_FOR_CODE_RENDER =
  "Para conferir o cupom eu preciso do código — me manda o código certinho que eu verifico se está valendo.";
const SAFE_UNKNOWN_RENDER =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";

// ── Harness (the delivery-coverage-claim.test.ts shape) ──────────────────────

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

function state(text = COUPON_Q): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-07-24T00:00:00.000Z" },
    memory: {} as CognitiveState["memory"],
    retrieval: {} as CognitiveState["retrieval"],
    tenantId: "t1",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  };
}

function claimCall(
  input: unknown,
  id = "tc-1",
): NonNullable<Completion["toolCalls"]>[number] {
  return { id, name: PROPOSE_CLAIM_TOOL, input };
}

function planner(toolCalls: Completion["toolCalls"]) {
  return createIbatexasPlanner({
    model: mockModel(toolCalls),
    modelId: "mock",
    capabilityPlanners: [],
  });
}

function stubBackend(): TriadReadBackend {
  return {
    readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
    readScheduleOverride: async () => null,
    readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
    readHoliday: async () => null,
    readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
    readHolidayForDate: async () => null,
    readScheduleOverrideForDate: async () => null,
    readOrderFulfillment: async () => null,
    readPaymentStatus: async () => null,
    readReservation: async () => null,
    readPaymentRefund: async (orderId) => ({
      orderId,
      refunded: false,
      refundedAmountCentavos: 0,
      status: "",
    }),
    readPaymentChargeback: async (orderId) => ({ orderId, disputed: false, status: "" }),
    readCartContents: async () => ({ itemsSummaryText: "", hasItems: false }),
    readOrderHistory: async () => ({ historySummaryText: "", hasHistory: false }),
    readPaymentHistory: async () => ({ historySummaryText: "", hasHistory: false }),
    listActiveOrderIds: async () => [],
    listActiveReservationIds: async () => [],
    countActivePayments: async () => 0,
  };
}

function investigateInput(
  ledger: EvidenceLedger,
  text: string,
  customerId = "guest:abc",
): InvestigateInput {
  return {
    cognition: state(text),
    plan: { envelopes: [] } as Plan,
    customerId,
    channel: "web",
    ledger,
  };
}

async function investigate(
  text: string,
  customerId = "guest:abc",
): Promise<EvidenceLedger> {
  const ledger = new EvidenceLedger(`t-${text.slice(0, 12)}-${customerId}`);
  const investigator = createIbatexasInvestigator({
    gatherReads: createFirstPartyTurnReads(stubBackend()),
    now: () => NOW,
  });
  await investigator.investigate(investigateInput(ledger, text, customerId));
  return ledger;
}

/**
 * Drive the REAL turn seam for a coupon question: investigator → claim-planner
 * adapter (the MODEL path, so the constrained-generation wall runs) → kernel. The
 * proposals stand in for the 4B's `propose_claim` tags; the VALUES are derived
 * first-party by the planner, never model-authored.
 */
async function driveTurn(args: {
  text: string;
  resolution: CouponValidityResolution;
  customerId?: string;
}) {
  vi.mocked(resolveCouponValidity).mockResolvedValue(args.resolution);
  const customerId = args.customerId ?? "guest:abc";
  const ledger = new EvidenceLedger(`turn-${args.text.slice(0, 8)}`);
  const investigator = createIbatexasInvestigator({
    gatherReads: createFirstPartyTurnReads(stubBackend()),
    now: () => NOW,
  });
  await investigator.investigate(investigateInput(ledger, args.text, customerId));

  const adapter = createIbatexasClaimPlanner(
    planner(
      [
        { type: "COUPON_VALID", subject: "" },
        { type: "COUPON_INVALID", subject: "" },
      ].map((p, i) => claimCall(p, `tc-${i + 1}`)),
    ),
  );
  const input: ClaimPlannerInput = {
    cognition: state(args.text),
    plan: { envelopes: [] } as Plan,
    customerId,
    ledger,
  };
  const { candidates } = normalizeClaimPlannerResult(await adapter.propose(input));

  const base = createPerTurnClaimsKernelDeps({
    now: NOW,
    ownership: { principal: customerId, ownedResources: new Set() },
    outcomes: [],
  });
  const deps = buildPerTurnOwnsFromLedger({ ledger, customerId, base });
  return { ledger, candidates, result: runClaimsKernel(ledger, candidates, deps) };
}

/**
 * THE PRODUCTION RENDER SEAM. `createIbatexasClaimsRenderer` is what `handleTurn`
 * stage 6a calls, and it is where the §O#15 required-completeness gate runs — the
 * layer `renderer-from-claims` sits BELOW and cannot see. Every render assertion in
 * this file goes through here; none calls the pure renderer.
 */
const productionRenderer: ClaimsRendererPort = createIbatexasClaimsRenderer();

function renderThroughAdapter(
  result: Awaited<ReturnType<typeof driveTurn>>["result"],
  requestText: string,
): string {
  return productionRenderer.render(result, { requestText }).text;
}

beforeEach(() => {
  vi.mocked(resolveCouponValidity).mockReset();
  vi.mocked(resolveCouponValidity).mockResolvedValue({ kind: "unknown" });
});

// ── (1) Registry rows + plane scope ───────────────────────────────────────────

describe("LE2-019 — the coupon-validity registry rows", () => {
  it("both types are registered proposable CUSTOMER-plane types", () => {
    expect(CLAIM_REGISTRY).toContain("COUPON_VALID");
    expect(CLAIM_REGISTRY).toContain("COUPON_INVALID");
    // CUSTOMER-scoped by construction: the customer scope IS the customer registry,
    // so the customer planner advertises them and the wall admits them.
    expect(CUSTOMER_CLAIM_SCOPE.types).toContain("COUPON_VALID");
    expect(CUSTOMER_CLAIM_SCOPE.types).toContain("COUPON_INVALID");
    // BKL-057 naming: UPPER_SNAKE, and NO `OPS_` prefix (a coupon question is a
    // customer question; the ops plane reaches these only via its superset scope).
    for (const type of ["COUPON_VALID", "COUPON_INVALID"]) {
      expect(type).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(type.startsWith("OPS_")).toBe(false);
    }
  });

  it("declares the PUBLIC fixed-key LIVE read_claim shape (no cacheable staleness)", () => {
    for (const spec of [REGISTRY_SPECS.COUPON_VALID, REGISTRY_SPECS.COUPON_INVALID]) {
      expect(spec.kind).toBe("read_claim");
      // A promotion is store policy — the same code is valid or not regardless of
      // who asks, so this is never customer-scoped and never owner-gated.
      expect(spec.customerScoped).toBe(false);
      expect("perResourceKey" in spec).toBe(false);
      const evidence = spec.requiredEvidence[0];
      expect(evidence?.ownershipPolicy).toBe("not_applicable");
      // LIVE, never cacheable: a campaign budget exhausts on someone ELSE's
      // checkout, so the kernel is never licensed to accept a stale entry.
      expect(evidence?.freshnessPolicy).toBe("must_read_this_turn");
    }
  });

  it("uses COMPLEMENTARY evidence keys, so at most one can ever validate", () => {
    expect(REGISTRY_SPECS.COUPON_VALID.requiredEvidence[0]?.key).toBe(COUPON_VALID_KEY);
    expect(REGISTRY_SPECS.COUPON_INVALID.requiredEvidence[0]?.key).toBe(
      COUPON_INVALID_KEY,
    );
    expect(COUPON_VALID_KEY).not.toBe(COUPON_INVALID_KEY);
  });

  it("declares honest falsifier-completeness with the deliberately-unread arm", () => {
    for (const spec of [REGISTRY_SPECS.COUPON_VALID, REGISTRY_SPECS.COUPON_INVALID]) {
      expect(spec.falsifierComplete).toBe(true);
      expect(spec.falsifiers?.map((f) => f.key)).toEqual(["coupon:promotions_changed"]);
    }
  });

  it("binds each rendered scalar to its own read field (C6)", () => {
    expect(REGISTRY_SPECS.COUPON_VALID.valueBinding).toEqual({
      key: COUPON_VALID_KEY,
      path: ["validityText"],
    });
    expect(REGISTRY_SPECS.COUPON_INVALID.valueBinding).toEqual({
      key: COUPON_INVALID_KEY,
      path: ["invalidityText"],
    });
  });

  it("both are classify-only eligible with a DETERMINISTIC (fixed-key) subject", () => {
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("COUPON_VALID")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("COUPON_INVALID")).toBe(true);
    const candidate = selectCandidateClaim({
      type: "COUPON_VALID",
      subject: "",
      actor: { principal: "guest:abc", sessionId: "conv-1" },
      value: undefined,
    });
    expect(candidate?.soundness.requiredEvidence[0]?.key).toBe(COUPON_VALID_KEY);
  });
});

// ── (2) Renderable + the Decision 14 negative space ──────────────────────────

describe("LE2-019 — proposable AND renderable, with proposition-free frames", () => {
  it("the VALID template binds exactly ONE proposition and carries the hint as LITERAL text", () => {
    const template = VALIDATED_TEMPLATES.COUPON_VALID;
    expect(template?.claimType).toBe("COUPON_VALID");
    expect(template?.posture).toBe("validated");
    const props = template?.slots.filter((s) => s.kind === "PROPOSITION") ?? [];
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ claimType: "COUPON_VALID", field: "validityText" });
    const literals = (template?.slots ?? [])
      .filter((s) => s.kind === "LITERAL")
      .map((s) => (s.kind === "LITERAL" ? s.text : ""))
      .join("");
    expect(literals).toContain("É só informar o código no checkout.");
    // DECISION 14: the frame tells the CUSTOMER what to do; it never promises that
    // the SYSTEM will apply anything (there is no capability to promise).
    expect(literals).not.toMatch(/apliquei|vou aplicar|já apliquei|apliquei o cupom/);
  });

  it("the INVALID template binds exactly ONE proposition and offers to check another code", () => {
    const template = VALIDATED_TEMPLATES.COUPON_INVALID;
    expect(template?.claimType).toBe("COUPON_INVALID");
    expect(template?.posture).toBe("validated");
    const props = template?.slots.filter((s) => s.kind === "PROPOSITION") ?? [];
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      claimType: "COUPON_INVALID",
      field: "invalidityText",
    });
  });

  it("the CLARIFY-for-code template is proposition-free (asserts validity in NEITHER direction)", () => {
    expect(SAFE_CLARIFY_COUPON_CODE_TEMPLATE.posture).toBe("clarify");
    expect(
      SAFE_CLARIFY_COUPON_CODE_TEMPLATE.slots.every((s) => s.kind === "LITERAL"),
    ).toBe(true);
    const text = SAFE_CLARIFY_COUPON_CODE_TEMPLATE.slots
      .map((s) => (s.kind === "LITERAL" ? s.text : ""))
      .join("");
    expect(text).toBe(CLARIFY_FOR_CODE_RENDER);
    expect(text).not.toMatch(/está válido|não está válido|desconto de/);
  });

  it("DECISION 14 — the registry contains NO coupon apply / price-adjustment claim", () => {
    // Asserted as a property of the whole enum, not a comment: validity is a READ,
    // and the swap-for-coupon branch stays closed catalog data.
    const couponTypes = CLAIM_REGISTRY.filter((t) => t.startsWith("COUPON_"));
    expect([...couponTypes].sort()).toEqual(["COUPON_INVALID", "COUPON_VALID"]);
    for (const type of couponTypes) {
      expect(REGISTRY_SPECS[type].kind).toBe("read_claim");
    }
    // And nothing anywhere in the enum names an apply/adjust action.
    expect(
      CLAIM_REGISTRY.filter((t) => /APPLY|APPLIED|DISCOUNT|PRICE_ADJUST/.test(t)),
    ).toEqual([]);
  });
});

// ── (3) The span classifier ───────────────────────────────────────────────────

describe("LE2-019 — the COUPON_VALIDITY_Q span (a read, never an apply)", () => {
  const MUST_FIRE = [
    "o cupom BEMVINDO15 vale?",
    "esse cupom ainda vale?",
    "o código de desconto FRETEGRATIS ainda funciona?",
    "cupom X1234 tá valendo?",
    "meu voucher PROMO2026 é válido?",
    "esse cupom expirou?",
    "quero saber se o cupom BEMVINDO15 serve",
    "dá pra usar o cupom BEMVINDO15?",
    "posso usar esse cupom ainda?",
    "cupom BEMVINDO15?",
  ];

  const MUST_NOT_FIRE = [
    // APPLY imperatives — mutations, not this read.
    "aplica o cupom BEMVINDO15 no meu carrinho",
    "usa o cupom BEMVINDO15",
    "coloca o código BEMVINDO15",
    // A cart-verb mutation is caught by the shared BKL-201 net too.
    "tira o cupom do carrinho",
    // A bare "código" is not a coupon.
    "qual o código do meu pedido?",
    "me manda o código de rastreio",
    // Unrelated families.
    "vocês estão abertos?",
    "quanto custa a costela?",
    "vocês entregam em Ibaté?",
    "cadê minha entrega?",
  ];

  it.each(MUST_FIRE)("fires COUPON_VALIDITY_Q for %j", (text) => {
    expect(classifyRequestSpans(text)).toContain("COUPON_VALIDITY_Q");
  });

  it.each(MUST_NOT_FIRE)("does NOT fire COUPON_VALIDITY_Q for %j", (text) => {
    expect(classifyRequestSpans(text)).not.toContain("COUPON_VALIDITY_Q");
  });

  it("an APPLY imperative is excluded, but the MODAL question form is not", () => {
    expect(isCouponValidityAsk("aplica o cupom BEMVINDO15")).toBe(false);
    expect(isCouponValidityAsk("posso aplicar o cupom BEMVINDO15?")).toBe(true);
  });

  it("a coupon question does NOT force the owner-scoped ORDER/PAYMENT companions", () => {
    const required = decomposeRequiredClaims(classifyRequestSpans(COUPON_Q));
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(false);
    expect(required.has("PAYMENT_STATUS")).toBe(false);
  });

  it("the closure row requires the COMPLEMENTARY PAIR", () => {
    const required = decomposeRequiredClaims(["COUPON_VALIDITY_Q"]);
    expect([...required].sort()).toEqual(["COUPON_INVALID", "COUPON_VALID"]);
  });

  it("a coupon turn is classify-only eligible WHOLESALE (the deterministic path)", () => {
    const types = classifyOnlyRequiredTypes(COUPON_Q);
    expect(types).toBeDefined();
    expect([...(types ?? [])].sort()).toEqual(["COUPON_INVALID", "COUPON_VALID"]);
  });
});

// ── (3b) THE LE2-002 DEFECT, PINNED SHUT ─────────────────────────────────────

describe("LE2-019 — the pair is a PRESENCE-COMPLEMENT (the LE2-002 defect, pre-empted)", () => {
  it("either member VALIDATING satisfies the §O#15 required set on its own", () => {
    // This is the assertion whose ABSENCE let LE2-002 ship a structurally-dead
    // feature: the closure row requires BOTH, exactly one can ever validate, so
    // without the PRESENCE_COMPLEMENT_PAIRS registration completeness is
    // unsatisfiable and EVERY coupon turn degrades RENDER→UNKNOWN.
    const required = decomposeRequiredClaims(["COUPON_VALIDITY_Q"]);
    expect(
      checkRequiredClaimCompleteness(
        required,
        new Map([
          ["COUPON_VALID", "VALIDATED" as const],
          ["COUPON_INVALID", "UNKNOWN" as const],
        ]),
      ),
    ).toEqual({ complete: true, unsatisfied: [] });
    expect(
      checkRequiredClaimCompleteness(
        required,
        new Map([
          ["COUPON_VALID", "UNKNOWN" as const],
          ["COUPON_INVALID", "VALIDATED" as const],
        ]),
      ),
    ).toEqual({ complete: true, unsatisfied: [] });
  });

  it("NEITHER validating is still INCOMPLETE (the gate is not disabled, only paired)", () => {
    const required = decomposeRequiredClaims(["COUPON_VALIDITY_Q"]);
    const out = checkRequiredClaimCompleteness(
      required,
      new Map([
        ["COUPON_VALID", "UNKNOWN" as const],
        ["COUPON_INVALID", "UNKNOWN" as const],
      ]),
    );
    expect(out.complete).toBe(false);
    expect([...out.unsatisfied].sort()).toEqual(["COUPON_INVALID", "COUPON_VALID"]);
  });
});

// ── (4) Investigator recording states ─────────────────────────────────────────

describe("LE2-019 — investigator recording states (the pair + the marker)", () => {
  it("valid → `coupon:valid` PRESENT with the composed scalar; the complement stays ABSENT", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue(VALID_COUPON);
    const ledger = await investigate(COUPON_Q);
    const entry = ledger.resolve(COUPON_VALID_KEY);
    expect(entry.state).toBe("present");
    expect(entry.entry?.value).toEqual({ validityText: VALID_COUPON.validityText });
    expect(ledger.resolve(COUPON_INVALID_KEY).state).toBe("absent");
    expect(ledger.resolve(COUPON_NEEDS_CODE_MARKER_KEY).state).toBe("absent");
    // The SHARED per-turn resolver was consulted with THIS turn's id + text, which
    // is what makes the planner's derived value byte-equal (C6 by construction).
    expect(vi.mocked(resolveCouponValidity)).toHaveBeenCalledWith("turn-1", COUPON_Q);
  });

  it("invalid → `coupon:invalid` PRESENT; the positive stays ABSENT", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue(INVALID_COUPON);
    const ledger = await investigate("o cupom XPTO123 vale?");
    expect(ledger.resolve(COUPON_INVALID_KEY).state).toBe("present");
    expect(ledger.resolve(COUPON_VALID_KEY).state).toBe("absent");
  });

  it("needs_code → ONLY the marker; NEITHER claim key (nothing to assert yet)", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue({ kind: "needs_code" });
    const ledger = await investigate("esse cupom ainda vale?");
    expect(ledger.resolve(COUPON_NEEDS_CODE_MARKER_KEY).state).toBe("present");
    expect(ledger.resolve(COUPON_VALID_KEY).state).toBe("absent");
    expect(ledger.resolve(COUPON_INVALID_KEY).state).toBe("absent");
  });

  it("unknown (an unreadable lookup) → NOTHING recorded, not even the marker (Inv 7)", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue({ kind: "unknown" });
    const ledger = await investigate(COUPON_Q);
    expect(ledger.resolve(COUPON_VALID_KEY).state).toBe("absent");
    expect(ledger.resolve(COUPON_INVALID_KEY).state).toBe("absent");
    // Critically: no needs-code marker either — "could not check" must degrade to
    // the honest UNKNOWN, not to a clarify that implies the code would settle it.
    expect(ledger.resolve(COUPON_NEEDS_CODE_MARKER_KEY).state).toBe("absent");
  });

  it("a NON-coupon turn never consults the resolver and records NO key (the span gate)", async () => {
    const ledger = await investigate("vocês estão abertos?");
    expect(ledger.resolve(COUPON_VALID_KEY).state).toBe("absent");
    expect(vi.mocked(resolveCouponValidity)).not.toHaveBeenCalled();
  });

  it("answers a GUEST (the read sits BEFORE the authenticated gate)", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue(VALID_COUPON);
    const ledger = await investigate(COUPON_Q, "guest:first-timer");
    expect(ledger.resolve(COUPON_VALID_KEY).state).toBe("present");
  });
});

// ── (5) THE TURN SEAM — through the PRODUCTION adapter ───────────────────────

describe("LE2-019 — the turn seam: VALID (the terms come from the promotion record)", () => {
  it("renders the discount terms with the checkout hint", async () => {
    const { result } = await driveTurn({ text: COUPON_Q, resolution: VALID_COUPON });
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("COUPON_VALID")).toBe("VALIDATED");
    // The complement resolves honest UNKNOWN and is dropped by the kernel's §D
    // filter — the pair can never render a contradiction.
    expect(byType.get("COUPON_INVALID")).toBe("UNKNOWN");
    expect(result.terminal).toBe("RENDER");
    // THROUGH THE PRODUCTION ADAPTER: the §O#15 gate runs here, and a missing
    // PRESENCE_COMPLEMENT_PAIRS entry would degrade this to the safe UNKNOWN.
    expect(renderThroughAdapter(result, COUPON_Q)).toBe(VALID_RENDER);
  });

  it("the §O#15 gate did NOT degrade the turn (the LE2-002 failure, asserted directly)", async () => {
    const { result } = await driveTurn({ text: COUPON_Q, resolution: VALID_COUPON });
    const out = renderThroughAdapter(result, COUPON_Q);
    expect(out).not.toBe(SAFE_UNKNOWN_RENDER);
    expect(out).toContain("R$ 15,00");
  });

  it("the rendered amount is composed from INTEGER CENTAVOS (Hard Rule 2)", async () => {
    const { result } = await driveTurn({ text: COUPON_Q, resolution: VALID_COUPON });
    const text = renderThroughAdapter(result, COUPON_Q);
    expect(text).toContain("R$ 15,00");
    // Never a float, never a bare centavo count.
    expect(text).not.toMatch(/15\.0|1500/);
  });

  it("VALIDITY IS DISCOVERABLE WITHOUT AN APPLY — no envelope, no cart touched", async () => {
    // The Decision 18 property, asserted at the seam: the whole answer is produced
    // by a READ. The plan carries no envelopes on the way in and none on the way
    // out, and the only claims minted are read_claims.
    const { result } = await driveTurn({ text: COUPON_Q, resolution: VALID_COUPON });
    for (const c of result.perClaim) {
      expect(REGISTRY_SPECS[c.type as keyof typeof REGISTRY_SPECS].kind).toBe(
        "read_claim",
      );
    }
    expect(renderThroughAdapter(result, COUPON_Q)).toBe(VALID_RENDER);
  });
});

describe("LE2-019 — the turn seam: INVALID (an honest no is a FACT, not an abstain)", () => {
  it("renders the VALIDATED negative with the offer — not an UNKNOWN", async () => {
    const { result } = await driveTurn({
      text: "o cupom XPTO123 vale?",
      resolution: INVALID_COUPON,
    });
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("COUPON_INVALID")).toBe("VALIDATED");
    expect(byType.get("COUPON_VALID")).toBe("UNKNOWN");
    expect(result.terminal).toBe("RENDER");
    const text = renderThroughAdapter(result, "o cupom XPTO123 vale?");
    expect(text).toBe(INVALID_RENDER);
    // The honest no is NOT the generic "não localizei" abstain.
    expect(text).not.toBe(SAFE_UNKNOWN_RENDER);
  });
});

describe("LE2-019 — the turn seam: CLARIFY for the code (the resolver never guesses)", () => {
  it("an unnamed coupon forces CLARIFY and the adapter renders the ask-for-the-code variant", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue({ kind: "needs_code" });
    const text = "esse cupom ainda vale?";
    const ledger = await investigate(text);

    // The deterministic classify-only path sees the marker and forces CLARIFY —
    // never a lookup of a coupon nobody named.
    const required = classifyOnlyRequiredTypes(text);
    expect(required).toBeDefined();
    expect(couponValidityNeedsCode(required!, ledger)).toBe(true);
    const built = buildClassifyOnlyCandidates(
      required!,
      { customerId: "guest:abc" },
      "conv-1",
      ledger,
      text,
    );
    expect(built.forcedTerminal).toBe("CLARIFY");

    // …and the PRODUCTION adapter voices the code ask (the coupon net selects it).
    const { result } = await driveTurn({ text, resolution: { kind: "needs_code" } });
    const clarified = { ...result, terminal: "CLARIFY" as const };
    expect(productionRenderer.render(clarified, { requestText: text }).text).toBe(
      CLARIFY_FOR_CODE_RENDER,
    );
  });

  it("a NON-coupon CLARIFY still renders the generic disambiguation ask (byte-identical)", async () => {
    const generic = SAFE_TEMPLATES.clarify.slots
      .map((s) => (s.kind === "LITERAL" ? s.text : ""))
      .join("");
    const { result } = await driveTurn({ text: COUPON_Q, resolution: { kind: "unknown" } });
    const clarified = { ...result, terminal: "CLARIFY" as const };
    expect(
      productionRenderer.render(clarified, { requestText: "cadê meu pedido?" }).text,
    ).toBe(generic);
  });

  it("a coupon turn with NO extractable code yields NO claim at all", async () => {
    const { result } = await driveTurn({
      text: "esse cupom ainda vale?",
      resolution: { kind: "needs_code" },
    });
    expect(result.perClaim.every((c) => c.verdict !== "VALIDATED")).toBe(true);
  });
});

describe("LE2-019 — the turn seam: unresolvable input degrades to an HONEST UNKNOWN", () => {
  it("an unreadable promotion lookup renders the safe abstain — never 'não está válido'", async () => {
    const { result } = await driveTurn({
      text: COUPON_Q,
      resolution: { kind: "unknown" },
    });
    expect(result.perClaim.every((c) => c.verdict !== "VALIDATED")).toBe(true);
    expect(result.terminal).toBe("UNKNOWN");
    const text = renderThroughAdapter(result, COUPON_Q);
    expect(text).toBe(SAFE_UNKNOWN_RENDER);
    // The load-bearing negative assertion: an unreadable lookup NEVER surfaces as a
    // validity answer in either direction (Inv 7) — this is exactly the case the
    // display route POST /api/coupons/validate collapses to `valid: false`.
    expect(text).not.toMatch(/está válido|não está válido/);
    expect(text).not.toContain("R$");
  });
});

describe("LE2-019 — the turn seam on the DETERMINISTIC classify-only path (the live path)", () => {
  const priorFlag = process.env[CLASSIFY_ONLY_READS_ENABLED_ENV];
  beforeEach(() => {
    process.env[CLASSIFY_ONLY_READS_ENABLED_ENV] = "true";
  });
  afterEach(() => {
    if (priorFlag === undefined) delete process.env[CLASSIFY_ONLY_READS_ENABLED_ENV];
    else process.env[CLASSIFY_ONLY_READS_ENABLED_ENV] = priorFlag;
  });

  /** Drive the REAL adapter with classify-only ON: the candidate pair is FRAMED
   *  deterministically from the span (no `propose_claim` model call at all) and the
   *  values bind from the investigator's OWN ledger entries (C6 byte-equal by
   *  construction). The model spy proves the call was genuinely skipped. */
  async function driveClassifyOnly(text: string, resolution: CouponValidityResolution) {
    vi.mocked(resolveCouponValidity).mockResolvedValue(resolution);
    const ledger = await investigate(text);
    const complete = vi.fn(async (): Promise<Completion> => {
      throw new Error("the model must NOT be called on the classify-only path");
    });
    const adapter = createIbatexasClaimPlanner(
      createIbatexasPlanner({
        model: {
          complete,
          stream: () => {
            throw new Error("unused");
          },
          embed: async () => [],
        },
        modelId: "mock",
        capabilityPlanners: [],
      }),
    );
    const proposal = await adapter.propose({
      cognition: state(text),
      plan: { envelopes: [] } as Plan,
      customerId: "guest:abc",
      ledger,
    });
    const { candidates, forcedTerminal } = normalizeClaimPlannerResult(proposal);
    const base = createPerTurnClaimsKernelDeps({
      now: NOW,
      ownership: { principal: "guest:abc", ownedResources: new Set() },
      outcomes: [],
    });
    const deps = buildPerTurnOwnsFromLedger({ ledger, customerId: "guest:abc", base });
    return {
      complete,
      forcedTerminal,
      result: runClaimsKernel(ledger, candidates, deps),
    };
  }

  it("VALID renders through the adapter WITHOUT any model call", async () => {
    const { complete, forcedTerminal, result } = await driveClassifyOnly(
      COUPON_Q,
      VALID_COUPON,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(forcedTerminal).toBeUndefined();
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("COUPON_VALID")).toBe("VALIDATED");
    expect(byType.get("COUPON_INVALID")).toBe("UNKNOWN");
    expect(renderThroughAdapter(result, COUPON_Q)).toBe(VALID_RENDER);
  });

  it("INVALID renders through the adapter WITHOUT any model call", async () => {
    const text = "o cupom XPTO123 vale?";
    const { complete, result } = await driveClassifyOnly(text, INVALID_COUPON);
    expect(complete).not.toHaveBeenCalled();
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("COUPON_INVALID")).toBe("VALIDATED");
    expect(renderThroughAdapter(result, text)).toBe(INVALID_RENDER);
  });

  it("needs_code forces the CLARIFY terminal through the REAL adapter", async () => {
    const { complete, forcedTerminal } = await driveClassifyOnly(
      "esse cupom ainda vale?",
      { kind: "needs_code" },
    );
    expect(complete).not.toHaveBeenCalled();
    expect(forcedTerminal).toBe("CLARIFY");
  });

  it("an unreadable lookup does NOT force CLARIFY — it degrades to the honest UNKNOWN", async () => {
    const { forcedTerminal, result } = await driveClassifyOnly(COUPON_Q, {
      kind: "unknown",
    });
    expect(forcedTerminal).toBeUndefined();
    expect(result.perClaim.every((c) => c.verdict !== "VALIDATED")).toBe(true);
    expect(renderThroughAdapter(result, COUPON_Q)).toBe(SAFE_UNKNOWN_RENDER);
  });
});

// ── (6) The journey-feasibility predicate, read off a REAL turn ──────────────

describe("LE2-019 — the read is consumable as a journey-feasibility CLAIM PREDICATE", () => {
  /** The per-type verdict map a caller derives from a `ClaimsKernelResult`. */
  const verdictsOf = (result: Awaited<ReturnType<typeof driveTurn>>["result"]) =>
    new Map(result.perClaim.map((c) => [c.type, c.verdict]));

  it("a VALID turn is USABLE; an INVALID turn is NOT_USABLE", async () => {
    const ok = await driveTurn({ text: COUPON_Q, resolution: VALID_COUPON });
    expect(evaluateCouponFeasibility(verdictsOf(ok.result))).toBe("USABLE");
    const no = await driveTurn({
      text: "o cupom XPTO123 vale?",
      resolution: INVALID_COUPON,
    });
    expect(evaluateCouponFeasibility(verdictsOf(no.result))).toBe("NOT_USABLE");
  });

  it("an unreadable lookup is UNKNOWN — a pre-check must not treat it as NOT_USABLE", async () => {
    const out = await driveTurn({ text: COUPON_Q, resolution: { kind: "unknown" } });
    expect(evaluateCouponFeasibility(verdictsOf(out.result))).toBe("UNKNOWN");
  });
});
