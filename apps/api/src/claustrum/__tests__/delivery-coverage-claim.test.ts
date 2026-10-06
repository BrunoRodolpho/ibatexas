// delivery-coverage-claim.test.ts — LE2-002 / tracker NEW-007: the customer-plane
// DELIVERY_COVERAGE / DELIVERY_NO_COVERAGE claims.
//
// THE BUG THIS PINS SHUT: on 2026-07-20 a coverage question ("vocês entregam em
// Ibaté?") reached the lie-capable prose path and shipped an UNGROUNDED "Sim,
// entregamos em Ibate" with no zone read behind it. The delivery subsystem was
// DONE — the estimation tool and the admin zone CRUD both shipped — but neither was
// wired to a turn. Every assertion below exists so that sentence can only ever be
// emitted when a VALIDATED, ledger-bound zone read licenses it.
//
//   1. Registry rows (public fixed-key, live, W6-complete, C6-bound) + plane scope.
//   2. Proposable AND renderable — both templates, and the SOFT CAVEAT is LITERAL
//      frame text, never a proposition.
//   3. The span classifier: coverage questions fire; a customer's OWN delivery
//      ("cadê minha entrega?") does NOT (it stays an order-status question).
//   4. Investigator recording: exactly one of the complementary pair, the needs-CEP
//      MARKER for the clarify branch, and NOTHING at all on an unreadable read.
//   5. THE TURN SEAM — all three branches end to end (grounded yes incl. the live
//      "Ibaté" case / clarify-for-CEP / honest no), plus the honest-unknown degrade.
//
// The resolver's own four-branch behaviour + the admin-edit cache-invalidation seam
// live in the sibling `delivery-coverage-resolver.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceLedger, runClaimsKernel } from "@adjudicate/core";
import type {
  ClaimPlannerInput,
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
  SAFE_CLARIFY_DELIVERY_CEP_TEMPLATE,
  SAFE_TEMPLATES,
  VALIDATED_TEMPLATES,
} from "../slot-grammar.js";
import {
  classifyRequestSpans,
  decomposeRequiredClaims,
  isDeliveryCoverageAsk,
} from "../required-claim-decomposer.js";
import {
  CLASSIFY_ONLY_ELIGIBLE_TYPES,
  CLASSIFY_ONLY_READS_ENABLED_ENV,
  buildClassifyOnlyCandidates,
  classifyOnlyRequiredTypes,
  deliveryCoverageNeedsCep,
} from "../classify-only-reads.js";
import { createIbatexasPlanner, PROPOSE_CLAIM_TOOL } from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import {
  buildPerTurnOwnsFromLedger,
  createPerTurnClaimsKernelDeps,
} from "../ibatexas-claims-kernel-deps.js";
import { render, renderRenderables } from "../renderer-from-claims.js";
import {
  createFirstPartyTurnReads,
  createIbatexasInvestigator,
} from "../ibatexas-investigator.js";
import type { TriadReadBackend } from "../turn-reads.js";
import {
  composeDeliveryCoverageText,
  composeDeliveryNoCoverageText,
  DELIVERY_COVERAGE_KEY,
  DELIVERY_NEEDS_CEP_MARKER_KEY,
  DELIVERY_NO_COVERAGE_KEY,
  resolveDeliveryCoverage,
  type DeliveryCoverageResolution,
} from "../delivery-coverage-resolver.js";

// Mock ONLY the resolver seam the investigator/planner consume (the two IO edges —
// the zone projection + the estimation tool); everything else in the module stays
// real, so the composed scalars under test are the REAL ones.
vi.mock("../delivery-coverage-resolver.js", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("../delivery-coverage-resolver.js")>();
  return {
    ...orig,
    resolveDeliveryCoverage: vi.fn(async () => ({ kind: "unknown" }) as const),
  };
});

const NOW = 20_000;
const COVERAGE_Q = "vocês entregam em Ibaté?";

// The LIVE Ibaté row (packages/domain/src/seed-delivery.ts): R$ 15,00 / 50 min.
const IBATE_COVERAGE: DeliveryCoverageResolution = {
  kind: "covered",
  coverageText: composeDeliveryCoverageText({
    zoneName: "Ibaté",
    feeInCentavos: 1500,
    estimatedMinutes: 50,
  }),
  zoneName: "Ibaté",
  feeInCentavos: 1500,
  estimatedMinutes: 50,
};

const OUT_OF_ZONE: DeliveryCoverageResolution = {
  kind: "not_covered",
  noCoverageText: composeDeliveryNoCoverageText("01001000"),
};

/** The THREE branch renders, verbatim — the customer-facing contract this ticket
 *  ships. A change to any of these strings is a deliberate copy decision. */
const GROUNDED_YES_RENDER =
  "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos. " +
  "Confirmo certinho pelo endereço no checkout.";
const HONEST_NO_RENDER =
  "Ainda não entregamos no CEP 01001-000 — mas você pode retirar aqui no restaurante, se preferir.";
const CLARIFY_FOR_CEP_RENDER =
  "Para confirmar a entrega eu preciso do CEP — me manda o CEP do endereço que eu verifico a taxa e o prazo certinhos.";
const SAFE_UNKNOWN_RENDER =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";

// ── Harness (the cart-empty-claim.test.ts shape, verbatim) ────────────────────

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

function state(text = COVERAGE_Q): CognitiveState {
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
 * Drive the REAL turn seam for a coverage question: investigator → claim-planner
 * adapter (the MODEL path, so the constrained-generation wall runs) → kernel →
 * renderer. The proposals stand in for the 4B's `propose_claim` tags; the VALUES
 * are derived first-party by the planner, never model-authored.
 */
async function driveTurn(args: {
  text: string;
  resolution: DeliveryCoverageResolution;
  customerId?: string;
}) {
  vi.mocked(resolveDeliveryCoverage).mockResolvedValue(args.resolution);
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
        { type: "DELIVERY_COVERAGE", subject: "" },
        { type: "DELIVERY_NO_COVERAGE", subject: "" },
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

beforeEach(() => {
  vi.mocked(resolveDeliveryCoverage).mockReset();
  vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "unknown" });
});

// ── (1) Registry rows + plane scope ───────────────────────────────────────────

describe("LE2-002 — the delivery-coverage registry rows", () => {
  it("both types are registered proposable CUSTOMER-plane types", () => {
    expect(CLAIM_REGISTRY).toContain("DELIVERY_COVERAGE");
    expect(CLAIM_REGISTRY).toContain("DELIVERY_NO_COVERAGE");
    // CUSTOMER-scoped by construction: the customer scope IS the customer registry,
    // so the customer planner advertises them and the wall admits them.
    expect(CUSTOMER_CLAIM_SCOPE.types).toContain("DELIVERY_COVERAGE");
    expect(CUSTOMER_CLAIM_SCOPE.types).toContain("DELIVERY_NO_COVERAGE");
    // BKL-057 naming: UPPER_SNAKE, and NO `OPS_` prefix (that namespace is the ops
    // plane's — LE2-013 owns the ops-plane delivery answers, not this ticket).
    for (const type of ["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"]) {
      expect(type).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(type.startsWith("OPS_")).toBe(false);
    }
  });

  it("declares the PUBLIC fixed-key LIVE read_claim shape (no cacheable staleness)", () => {
    for (const spec of [
      REGISTRY_SPECS.DELIVERY_COVERAGE,
      REGISTRY_SPECS.DELIVERY_NO_COVERAGE,
    ]) {
      expect(spec.kind).toBe("read_claim");
      // A delivery ZONE is store policy — owned by nobody, never customer-scoped.
      expect(spec.customerScoped).toBe(false);
      expect("perResourceKey" in spec).toBe(false);
      const evidence = spec.requiredEvidence[0];
      expect(evidence?.ownershipPolicy).toBe("not_applicable");
      // LIVE, never cacheable: an admin fee edit must show up in the NEXT answer,
      // so the kernel is never licensed to accept a stale entry.
      expect(evidence?.freshnessPolicy).toBe("must_read_this_turn");
    }
  });

  it("uses COMPLEMENTARY evidence keys, so at most one can ever validate", () => {
    expect(REGISTRY_SPECS.DELIVERY_COVERAGE.requiredEvidence[0]?.key).toBe(
      DELIVERY_COVERAGE_KEY,
    );
    expect(REGISTRY_SPECS.DELIVERY_NO_COVERAGE.requiredEvidence[0]?.key).toBe(
      DELIVERY_NO_COVERAGE_KEY,
    );
    expect(DELIVERY_COVERAGE_KEY).not.toBe(DELIVERY_NO_COVERAGE_KEY);
  });

  it("declares honest falsifier-completeness with the deliberately-unread zones_changed arm", () => {
    for (const spec of [
      REGISTRY_SPECS.DELIVERY_COVERAGE,
      REGISTRY_SPECS.DELIVERY_NO_COVERAGE,
    ]) {
      expect(spec.falsifierComplete).toBe(true);
      expect(spec.falsifiers?.map((f) => f.key)).toEqual(["delivery:zones_changed"]);
    }
  });

  it("binds each rendered scalar to its own read field (C6)", () => {
    expect(REGISTRY_SPECS.DELIVERY_COVERAGE.valueBinding).toEqual({
      key: DELIVERY_COVERAGE_KEY,
      path: ["coverageText"],
    });
    expect(REGISTRY_SPECS.DELIVERY_NO_COVERAGE.valueBinding).toEqual({
      key: DELIVERY_NO_COVERAGE_KEY,
      path: ["noCoverageText"],
    });
  });

  it("both are classify-only eligible with a DETERMINISTIC (fixed-key) subject", () => {
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("DELIVERY_COVERAGE")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("DELIVERY_NO_COVERAGE")).toBe(true);
    // Fixed-key ⇒ the candidate subject is "" and the keys are never parameterized,
    // so the evidence resolves at exactly the bare key the investigator records.
    const candidate = selectCandidateClaim({
      type: "DELIVERY_COVERAGE",
      subject: "",
      actor: { principal: "guest:abc", sessionId: "conv-1" },
      value: undefined,
    });
    expect(candidate?.soundness.requiredEvidence[0]?.key).toBe(DELIVERY_COVERAGE_KEY);
  });
});

// ── (2) Renderable — and the caveat is FRAME, not proposition ────────────────

describe("LE2-002 — proposable AND renderable, with a proposition-free caveat", () => {
  it("the grounded-YES template binds exactly ONE proposition and carries the soft caveat as LITERAL text", () => {
    const template = VALIDATED_TEMPLATES.DELIVERY_COVERAGE;
    expect(template?.claimType).toBe("DELIVERY_COVERAGE");
    expect(template?.posture).toBe("validated");
    const props = template?.slots.filter((s) => s.kind === "PROPOSITION") ?? [];
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ claimType: "DELIVERY_COVERAGE", field: "coverageText" });
    // The caveat is STATIC: it describes what the SYSTEM will do, and asserts no
    // world fact — so it can never be an unbacked proposition.
    const literals = (template?.slots ?? [])
      .filter((s) => s.kind === "LITERAL")
      .map((s) => (s.kind === "LITERAL" ? s.text : ""))
      .join("");
    expect(literals).toContain("Confirmo certinho pelo endereço no checkout.");
  });

  it("the honest-NO template binds exactly ONE proposition and offers pickup", () => {
    const template = VALIDATED_TEMPLATES.DELIVERY_NO_COVERAGE;
    expect(template?.claimType).toBe("DELIVERY_NO_COVERAGE");
    expect(template?.posture).toBe("validated");
    const props = template?.slots.filter((s) => s.kind === "PROPOSITION") ?? [];
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      claimType: "DELIVERY_NO_COVERAGE",
      field: "noCoverageText",
    });
  });

  it("the CLARIFY-for-CEP template is proposition-free (asserts coverage in NEITHER direction)", () => {
    expect(SAFE_CLARIFY_DELIVERY_CEP_TEMPLATE.posture).toBe("clarify");
    expect(
      SAFE_CLARIFY_DELIVERY_CEP_TEMPLATE.slots.every((s) => s.kind === "LITERAL"),
    ).toBe(true);
    const text = SAFE_CLARIFY_DELIVERY_CEP_TEMPLATE.slots
      .map((s) => (s.kind === "LITERAL" ? s.text : ""))
      .join("");
    expect(text).toBe(CLARIFY_FOR_CEP_RENDER);
    // It never says "sim", never says "não", and never names a nearby zone.
    expect(text).not.toMatch(/entregamos|não entregamos|Ibaté/);
  });
});

// ── (3) The span classifier ───────────────────────────────────────────────────

describe("LE2-002 — the DELIVERY_COVERAGE_Q span (capability, not the customer's own order)", () => {
  const MUST_FIRE = [
    "vocês entregam em Ibaté?",
    "voces entregam no Jardim Botânico?",
    "vocês fazem entrega?",
    "fazem entrega pra São Carlos?",
    "entregam no CEP 14815000?",
    "entregam até Araraquara?",
    "qual a taxa de entrega?",
    "quanto custa a entrega pro meu bairro?",
    "quanto tempo demora a entrega?",
    "qual a área de entrega de vocês?",
    "onde vocês entregam?",
    "vocês atendem em Ibaté?",
    "qual o valor do frete?",
  ];

  const MUST_NOT_FIRE = [
    // The customer's OWN in-flight delivery — an ORDER_STATUS question.
    "cadê minha entrega?",
    "minha entrega está atrasada",
    "meu pedido saiu para entrega?",
    // Unrelated families.
    "vocês estão abertos?",
    "o que tem no cardápio?",
    "quanto custa a costela?",
    "aceitam vale-refeição?",
    "quais as formas de pagamento?",
    "quero falar com um atendente",
    // A MUTATION must never ride a read span (BKL-201/206 discipline).
    "cancela a entrega do meu pedido",
  ];

  it.each(MUST_FIRE)("fires DELIVERY_COVERAGE_Q for %j", (text) => {
    expect(classifyRequestSpans(text)).toContain("DELIVERY_COVERAGE_Q");
  });

  it.each(MUST_NOT_FIRE)("does NOT fire DELIVERY_COVERAGE_Q for %j", (text) => {
    expect(classifyRequestSpans(text)).not.toContain("DELIVERY_COVERAGE_Q");
  });

  it("a self-referential delivery question stays an ORDER_STATUS question", () => {
    const spans = classifyRequestSpans("cadê minha entrega?");
    expect(spans).toContain("ORDER_STATUS_Q");
    expect(spans).not.toContain("DELIVERY_COVERAGE_Q");
    expect(isDeliveryCoverageAsk("cadê minha entrega?")).toBe(false);
  });

  it("a coverage question does NOT force the owner-scoped ORDER companion (BKL-204 holds)", () => {
    const required = decomposeRequiredClaims(classifyRequestSpans(COVERAGE_Q));
    expect(required.has("ORDER_FULFILLMENT_STAGE")).toBe(false);
    expect(required.has("PAYMENT_STATUS")).toBe(false);
  });

  it("the closure row requires the COMPLEMENTARY PAIR", () => {
    const required = decomposeRequiredClaims(["DELIVERY_COVERAGE_Q"]);
    expect([...required].sort()).toEqual(["DELIVERY_COVERAGE", "DELIVERY_NO_COVERAGE"]);
  });

  it("a coverage turn is classify-only eligible WHOLESALE (the deterministic path)", () => {
    const types = classifyOnlyRequiredTypes(COVERAGE_Q);
    expect(types).toBeDefined();
    expect([...(types ?? [])].sort()).toEqual([
      "DELIVERY_COVERAGE",
      "DELIVERY_NO_COVERAGE",
    ]);
  });
});

// ── (4) Investigator recording states ─────────────────────────────────────────

describe("LE2-002 — investigator recording states (the complementary pair + the marker)", () => {
  it("covered → `delivery:coverage` PRESENT with the composed scalar; the complement stays ABSENT", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(IBATE_COVERAGE);
    const ledger = await investigate(COVERAGE_Q);
    const entry = ledger.resolve(DELIVERY_COVERAGE_KEY);
    expect(entry.state).toBe("present");
    expect(entry.entry?.value).toEqual({ coverageText: IBATE_COVERAGE.coverageText });
    expect(ledger.resolve(DELIVERY_NO_COVERAGE_KEY).state).toBe("absent");
    expect(ledger.resolve(DELIVERY_NEEDS_CEP_MARKER_KEY).state).toBe("absent");
    // The SHARED per-turn resolver was consulted with THIS turn's id + text, which
    // is what makes the planner's derived value byte-equal (C6 by construction).
    expect(vi.mocked(resolveDeliveryCoverage)).toHaveBeenCalledWith("turn-1", COVERAGE_Q);
  });

  it("not_covered → `delivery:no_coverage` PRESENT; the positive stays ABSENT", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(OUT_OF_ZONE);
    const ledger = await investigate("entregam no 01001000?");
    expect(ledger.resolve(DELIVERY_NO_COVERAGE_KEY).state).toBe("present");
    expect(ledger.resolve(DELIVERY_COVERAGE_KEY).state).toBe("absent");
  });

  it("needs_cep → ONLY the marker; NEITHER claim key (nothing to assert yet)", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "needs_cep" });
    const ledger = await investigate("vocês entregam em Matão?");
    expect(ledger.resolve(DELIVERY_NEEDS_CEP_MARKER_KEY).state).toBe("present");
    expect(ledger.resolve(DELIVERY_COVERAGE_KEY).state).toBe("absent");
    expect(ledger.resolve(DELIVERY_NO_COVERAGE_KEY).state).toBe("absent");
  });

  it("unknown (an unreadable read) → NOTHING recorded, not even the marker (Inv 7)", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "unknown" });
    const ledger = await investigate(COVERAGE_Q);
    expect(ledger.resolve(DELIVERY_COVERAGE_KEY).state).toBe("absent");
    expect(ledger.resolve(DELIVERY_NO_COVERAGE_KEY).state).toBe("absent");
    // Critically: no needs-CEP marker either — "could not check" must degrade to the
    // honest UNKNOWN, not to a clarify that implies the CEP would settle it.
    expect(ledger.resolve(DELIVERY_NEEDS_CEP_MARKER_KEY).state).toBe("absent");
  });

  it("a NON-coverage turn never consults the resolver and records NO key (the span gate)", async () => {
    const ledger = await investigate("vocês estão abertos?");
    expect(ledger.resolve(DELIVERY_COVERAGE_KEY).state).toBe("absent");
    expect(vi.mocked(resolveDeliveryCoverage)).not.toHaveBeenCalled();
  });

  it("answers a GUEST (the read sits BEFORE the authenticated gate)", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(IBATE_COVERAGE);
    const ledger = await investigate(COVERAGE_Q, "guest:first-timer");
    expect(ledger.resolve(DELIVERY_COVERAGE_KEY).state).toBe("present");
  });
});

// ── (5) THE TURN SEAM — the three branches ────────────────────────────────────

describe("LE2-002 — the turn seam: grounded YES (the live Ibaté case)", () => {
  it("renders the zone-grounded fee + ETA with the soft checkout caveat", async () => {
    const { result } = await driveTurn({ text: COVERAGE_Q, resolution: IBATE_COVERAGE });
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("DELIVERY_COVERAGE")).toBe("VALIDATED");
    // The complement resolves honest UNKNOWN and is dropped by the kernel's §D
    // filter — the pair can never render a contradiction.
    expect(byType.get("DELIVERY_NO_COVERAGE")).toBe("UNKNOWN");
    expect(result.terminal).toBe("RENDER");
    expect(render(result.renderableCanonical, result.terminal).text).toBe(
      GROUNDED_YES_RENDER,
    );
  });

  it("the rendered fee comes from INTEGER CENTAVOS, formatted R$ XX,XX (Hard Rule 2)", async () => {
    const { result } = await driveTurn({ text: COVERAGE_Q, resolution: IBATE_COVERAGE });
    const text = render(result.renderableCanonical, result.terminal).text;
    expect(text).toContain("R$ 15,00");
    // Never a float, never a bare centavo count.
    expect(text).not.toMatch(/15\.0|1500/);
  });
});

describe("LE2-002 — the turn seam: honest NO (a definitive out-of-zone CEP is a FACT)", () => {
  it("renders the VALIDATED negative with the pickup offer — not an UNKNOWN", async () => {
    const { result } = await driveTurn({
      text: "vocês entregam no CEP 01001000?",
      resolution: OUT_OF_ZONE,
    });
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("DELIVERY_NO_COVERAGE")).toBe("VALIDATED");
    expect(byType.get("DELIVERY_COVERAGE")).toBe("UNKNOWN");
    expect(result.terminal).toBe("RENDER");
    const text = render(result.renderableCanonical, result.terminal).text;
    expect(text).toBe(HONEST_NO_RENDER);
    // The honest no is NOT the generic "não localizei" abstain.
    expect(text).not.toBe(SAFE_UNKNOWN_RENDER);
  });
});

describe("LE2-002 — the turn seam: CLARIFY for the CEP (the resolver never guesses)", () => {
  it("an unmatched place forces CLARIFY and renders the ask-for-the-CEP variant", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "needs_cep" });
    const text = "vocês entregam em Matão?";
    const ledger = await investigate(text);

    // The deterministic classify-only path sees the marker and forces CLARIFY —
    // never a nearest-neighbour zone pick.
    const required = classifyOnlyRequiredTypes(text);
    expect(required).toBeDefined();
    expect(deliveryCoverageNeedsCep(required!, ledger)).toBe(true);
    const built = buildClassifyOnlyCandidates(
      required!,
      { customerId: "guest:abc" },
      "conv-1",
      ledger,
      text,
    );
    expect(built.forcedTerminal).toBe("CLARIFY");

    // …and the renderer voices the CEP ask (the coverage net selects the variant).
    const out = renderRenderables([], "CLARIFY", [], [], false, false, undefined, true);
    expect(out.text).toBe(CLARIFY_FOR_CEP_RENDER);
    // NEITHER a coverage assertion NOR the generic "qual pedido?" disambiguation.
    expect(out.text).not.toBe(
      SAFE_TEMPLATES.clarify.slots
        .map((s) => (s.kind === "LITERAL" ? s.text : ""))
        .join(""),
    );
  });

  it("a NON-coverage CLARIFY still renders the generic disambiguation ask (byte-identical)", () => {
    const generic = SAFE_TEMPLATES.clarify.slots
      .map((s) => (s.kind === "LITERAL" ? s.text : ""))
      .join("");
    expect(renderRenderables([], "CLARIFY").text).toBe(generic);
    expect(
      renderRenderables([], "CLARIFY", [], [], false, false, undefined, false).text,
    ).toBe(generic);
  });

  it("a coverage turn with NO CEP and NO zone match yields NO claim at all", async () => {
    const { result } = await driveTurn({
      text: "vocês entregam em Matão?",
      resolution: { kind: "needs_cep" },
    });
    // Neither half can validate — there is nothing true to say yet, and the
    // resolver refused to invent one.
    expect(result.perClaim.every((c) => c.verdict !== "VALIDATED")).toBe(true);
  });
});

describe("LE2-002 — the turn seam on the DETERMINISTIC classify-only path (the live path)", () => {
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
  async function driveClassifyOnly(text: string, resolution: DeliveryCoverageResolution) {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(resolution);
    const ledger = await investigate(text);
    const complete = vi.fn(async (): Promise<Completion> => {
      throw new Error("the model must NOT be called on the classify-only path");
    });
    const adapter = createIbatexasClaimPlanner(
      createIbatexasPlanner({
        model: { complete, stream: () => { throw new Error("unused"); }, embed: async () => [] },
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

  it("grounded YES renders WITHOUT any model call (propose_claim skipped)", async () => {
    const { complete, forcedTerminal, result } = await driveClassifyOnly(
      COVERAGE_Q,
      IBATE_COVERAGE,
    );
    expect(complete).not.toHaveBeenCalled();
    expect(forcedTerminal).toBeUndefined();
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("DELIVERY_COVERAGE")).toBe("VALIDATED");
    expect(byType.get("DELIVERY_NO_COVERAGE")).toBe("UNKNOWN");
    expect(render(result.renderableCanonical, result.terminal).text).toBe(
      GROUNDED_YES_RENDER,
    );
  });

  it("honest NO renders WITHOUT any model call", async () => {
    const { complete, result } = await driveClassifyOnly(
      "vocês entregam no CEP 01001000?",
      OUT_OF_ZONE,
    );
    expect(complete).not.toHaveBeenCalled();
    const byType = new Map(result.perClaim.map((c) => [c.type, c.verdict]));
    expect(byType.get("DELIVERY_NO_COVERAGE")).toBe("VALIDATED");
    expect(render(result.renderableCanonical, result.terminal).text).toBe(
      HONEST_NO_RENDER,
    );
  });

  it("needs_cep forces the CLARIFY terminal through the REAL adapter", async () => {
    const { complete, forcedTerminal } = await driveClassifyOnly(
      "vocês entregam em Matão?",
      { kind: "needs_cep" },
    );
    expect(complete).not.toHaveBeenCalled();
    expect(forcedTerminal).toBe("CLARIFY");
  });

  it("an unreadable read does NOT force CLARIFY — it degrades to the honest UNKNOWN", async () => {
    const { forcedTerminal, result } = await driveClassifyOnly(COVERAGE_Q, {
      kind: "unknown",
    });
    expect(forcedTerminal).toBeUndefined();
    expect(result.perClaim.every((c) => c.verdict !== "VALIDATED")).toBe(true);
  });
});

describe("LE2-002 — the turn seam: unresolvable input degrades to an HONEST UNKNOWN", () => {
  it("an unreadable zone projection renders the safe abstain — never 'não entregamos'", async () => {
    const { result } = await driveTurn({
      text: COVERAGE_Q,
      resolution: { kind: "unknown" },
    });
    expect(result.perClaim.every((c) => c.verdict !== "VALIDATED")).toBe(true);
    expect(result.terminal).toBe("UNKNOWN");
    const out = render(result.renderableCanonical, result.terminal);
    expect(out.text).toBe(SAFE_UNKNOWN_RENDER);
    // The load-bearing negative assertion: an unreadable read NEVER surfaces as a
    // coverage answer in either direction (Inv 7).
    expect(out.text).not.toContain("entregamos");
  });

  it("an UNTEMPLATED / unbacked proposition can never fabricate a fee (Inv 6 abstain)", () => {
    // A VALIDATED-shaped claim whose value lacks the C6-bound field is UNFILLABLE:
    // the whole template abstains rather than emit a half-sentence with no price.
    const out = renderRenderables([
      {
        subject: "",
        type: "DELIVERY_COVERAGE",
        value: { somethingElse: "R$ 99,00" },
        verdict: "VALIDATED",
      },
    ], "RENDER");
    expect(out.text).toBe(SAFE_UNKNOWN_RENDER);
    expect(out.lines[0]?.kind).toBe("UNFILLABLE");
  });
});
