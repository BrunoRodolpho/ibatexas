// r2s9-fixed-subject-claims.e2e.test.ts — the R2-S9 adoption batch at the REAL customer
// turn seam.
//
// ════════════════════════════════════════════════════════════════════════════════
//  WHY THIS SUITE IS SMALL, AND WHY IT COVERS EXACTLY THESE THREE TYPES
// ════════════════════════════════════════════════════════════════════════════════
//
// R2-S9 adopts EIGHT types, and six of them already have a real `handleTurn` proof that
// this slice inherits UNEDITED:
//
//   · MENU_PAIRINGS / MENU_SUBSTITUTIONS — `pairings.e2e.test.ts` (grounded render, the
//     unknown item, the empty relation, the alias, the two-question degrade, the safety
//     negative + control).
//   · MENU_OVERVIEW                      — `menu-diet-guard.e2e.test.ts` (the marked
//     abstain AND the unmarked control that lists the catalog).
//   · MENU_ITEM_ALLERGENS                — `dietary-posture.e2e.test.ts`.
//   · DELIVERY_COVERAGE                  — `dietary-posture.e2e.test.ts`, where it is the
//     `answer-anyway` case and must still ANSWER under a dietary qualifier.
//
// THREE HAD NO PROOF AT THIS DEPTH AT ALL, and they are the three added here. The gap is
// not random: it is the COMPLEMENTARY HALF of two presence-complement pairs plus one whole
// pair, i.e. exactly the surface LE2-002 shipped structurally dead. Its turn-seam tests
// called `renderer-from-claims` `render(...)` DIRECTLY — as `delivery-coverage-claim.test.ts`
// and `coupon-validity-claim.test.ts` still do, correctly, for what they pin — and the
// §O#15 required-completeness gate lives ONE LAYER UP, in `createIbatexasClaimsRenderer`.
// A pair whose registration is missing renders perfectly at the lower seam and degrades
// RENDER→UNKNOWN at the higher one. So a suite that drives the REAL `handleTurn` is the
// only thing that can say these claims reach a customer.
//
// R2-S9 makes that gap sharper rather than milder, and the reason is measured: INV-4's
// forward direction obliges TRIAD-SCOPED types only, and both members of all three pairs
// adopted here are PUBLIC — so unlike R2-S6's cart pair, a `requires` that stopped naming
// the twin would NOT be refused at boot (see `claimdefs/__tests__/generated-drift.test.ts`
// for the measurement and the structural pin). These cases are the behavioural half of
// that same guarantee: if the shared row loses its twin, the negative branch stops
// rendering and this suite says so.
//
// THE ONLY FAKES are the ModelProvider, the triad read backend, and the two per-family
// RESOLVERS (each one admin-transport egress). Everything between the inbound message and
// the reply string is production: real planner, real investigator, real claims kernel, real
// render-from-claims, real precedence lattice, real §O#15 gate.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";

// ── The two resolver egresses (each family's ONE admin read) ──────────────────

vi.mock("../claustrum/coupon-validity-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../claustrum/coupon-validity-resolver.js")
  >();
  return {
    ...actual,
    // Default to the honest-UNKNOWN branch, so a case that forgets to arm the read
    // degrades loudly instead of inheriting a neighbour's fixture.
    resolveCouponValidity: vi.fn(async () => ({ kind: "unknown" }) as const),
  };
});

vi.mock("../claustrum/delivery-coverage-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../claustrum/delivery-coverage-resolver.js")
  >();
  return {
    ...actual,
    resolveDeliveryCoverage: vi.fn(async () => ({ kind: "unknown" }) as const),
  };
});

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  // Dynamic import: a `vi.mock` factory is hoisted above this file's static imports,
  // so it cannot close over one. The builder is type-only against turn-reads.js, so
  // this drags no infrastructure into the factory (see the helper's header).
  const { buildTriadReadBackend } = await import("./helpers/triad-backend-builder.js");
  return {
    ...actual,
    // Every read NOT declared below defaults to a `notUsed` thrower naming itself, so
    // an unexpected read fails loudly instead of returning a fabricated value.
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        readStoreHours: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHoliday: async () => null,
        readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        // Someone asking whether a coupon works, or whether the store delivers to a CEP,
        // owns nothing relevant. Present-with-0 keeps §O#15 from force-requiring an
        // owner-scoped companion and turning every assertion below into a degrade.
        listActiveOrderIds: async () => [],
        listActiveReservationIds: async () => [],
        countActivePayments: async () => 0,
      }),
  };
});

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
} = await import("./customer-e2e-harness.js");
const {
  clearCouponValidityMemoForTests,
  composeCouponInvalidText,
  composeCouponValidText,
  resolveCouponValidity,
} = await import("../claustrum/coupon-validity-resolver.js");
const { clearDeliveryCoverageMemoForTests, composeDeliveryNoCoverageText, resolveDeliveryCoverage } =
  await import("../claustrum/delivery-coverage-resolver.js");

// ── The customer-facing contracts, verbatim ──────────────────────────────────
//
// Each is the C6-bound scalar (composed IN CODE by its resolver, from the promotion
// record's own terms / the zone data — never model-authored) plus its template's OWN
// static frame. Asserting the WHOLE string is what makes the frame half non-vacuous: a
// bound value that rendered without its frame, or a frame that rendered with an empty
// value, both fail here.

const COUPON_VALID_RENDER =
  "Sim, o cupom BEMVINDO15 está válido — R$ 15,00 de desconto. " +
  "É só informar o código no checkout.";
const COUPON_INVALID_RENDER =
  "O cupom XPTO123 não está válido — se você tiver outro código, me manda que eu confiro.";
const DELIVERY_NO_COVERAGE_RENDER =
  "Ainda não entregamos no CEP 01001-000 — mas você pode retirar aqui no restaurante, se preferir.";

/** The generic abstain. Every case below asserts the reply is NOT this — which is the
 *  ENTIRE LE2-002 failure mode, and the one a renderer-level test cannot see. */
const SAFE_UNKNOWN_RENDER =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";

const VALID_COUPON = {
  kind: "valid",
  validityText: composeCouponValidText({
    code: "BEMVINDO15",
    termsText: "R$ 15,00 de desconto",
  }),
  code: "BEMVINDO15",
} as const;

const INVALID_COUPON = {
  kind: "invalid",
  invalidityText: composeCouponInvalidText("XPTO123"),
  code: "XPTO123",
} as const;

const OUT_OF_ZONE = {
  kind: "not_covered",
  noCoverageText: composeDeliveryNoCoverageText("01001000"),
} as const;

// ── The scripted planner ─────────────────────────────────────────────────────

/** Claim-planner-only scripted model: the intent leg proposes nothing, and the claim leg
 *  proposes the PAIR. The VALUES are derived first-party by the planner from the same
 *  per-turn read the investigator recorded — never from anything in this array, which is
 *  why every fixture above lives in the RESOLVER mock and not here. */
function claimsScriptedModel(
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): ModelProvider {
  return {
    complete: vi.fn(async (req: CompletionRequest): Promise<Completion> => {
      const toolNames = (req.tools ?? []).map((t) => t.name);
      const base = {
        model: "mock",
        stopReason: "end_turn",
        inputTokens: 5,
        outputTokens: 4,
      } as const;
      if (toolNames.includes(PROPOSE_CLAIM_TOOL)) {
        return {
          ...base,
          text: "",
          toolCalls: claims.map((c, i) => ({
            id: `claim-${i}`,
            name: PROPOSE_CLAIM_TOOL,
            input: { ...c },
          })),
        };
      }
      return { ...base, text: "ok (mock planner pass — nothing to propose)", toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

/** Both members are proposed on every turn — they are a presence complement, so at most
 *  one can ever be PRESENT and the other resolves UNKNOWN and is dropped by the kernel's
 *  §D filter. Proposing both is also what makes the completeness gate the thing under
 *  test rather than the planner's choice. */
const COUPON_PAIR = [
  { type: "COUPON_VALID", subject: "" },
  { type: "COUPON_INVALID", subject: "" },
] as const;
const DELIVERY_PAIR = [
  { type: "DELIVERY_COVERAGE", subject: "" },
  { type: "DELIVERY_NO_COVERAGE", subject: "" },
] as const;

let turnSeq = 0;

async function runTurn(
  text: string,
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): Promise<string> {
  turnSeq += 1;
  const harness = composeCustomerConductor({
    model: claimsScriptedModel(claims),
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
  });
  const out = await runCustomerTurn(harness, {
    customerId: `cust-r2s9-${turnSeq}`,
    conversationId: `conv-r2s9-${turnSeq}`,
    text,
  });
  return out.response;
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  clearCouponValidityMemoForTests();
  clearDeliveryCoverageMemoForTests();
  vi.mocked(resolveCouponValidity).mockReset();
  vi.mocked(resolveCouponValidity).mockResolvedValue({ kind: "unknown" });
  vi.mocked(resolveDeliveryCoverage).mockReset();
  vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "unknown" });
});

// ── (1) COUPON — the family with NO real-seam proof at any depth before this ──

describe("R2-S9 e2e — COUPON_VALID reaches the customer through the real turn", () => {
  it("renders the promotion record's OWN terms plus the checkout hint", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue(VALID_COUPON);
    const response = await runTurn("o cupom BEMVINDO15 vale?", [...COUPON_PAIR]);

    expect(response).toBe(COUPON_VALID_RENDER);
    // The §O#15 gate did NOT degrade the turn. This is the assertion the whole suite
    // exists for: the pair's PRESENCE_COMPLEMENT registration is what makes a row
    // requiring BOTH members satisfiable, and its absence is invisible one layer down.
    expect(response).not.toBe(SAFE_UNKNOWN_RENDER);
  });

  it("the money comes from the record, formatted R$ XX,XX — never a float or a centavo count", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue(VALID_COUPON);
    const response = await runTurn("o cupom BEMVINDO15 vale?", [...COUPON_PAIR]);
    expect(response).toContain("R$ 15,00");
    expect(response).not.toMatch(/15\.0|1500/);
  });
});

describe("R2-S9 e2e — COUPON_INVALID is a VALIDATED negative, not an abstain", () => {
  it("renders the honest no with the offer to check another code", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue(INVALID_COUPON);
    const response = await runTurn("o cupom XPTO123 vale?", [...COUPON_PAIR]);

    expect(response).toBe(COUPON_INVALID_RENDER);
    // A definitive not-usable determination off a SUCCESSFUL lookup is a FACT. Rendering
    // it as the generic abstain would be less honest, not more — and it is the branch a
    // de-synced shared row would silently delete.
    expect(response).not.toBe(SAFE_UNKNOWN_RENDER);
    // It states NO reason, by design: why a campaign is exhausted is store-internal.
    expect(response).not.toMatch(/expirou|esgotad|campanha|rascunho/i);
  });

  it("THE CONTROL: an UNREADABLE lookup degrades to the abstain — 'could not check' is never 'invalid'", async () => {
    // Inv 7, and the assertion that keeps the two cases above from being satisfiable by a
    // renderer that says the same thing regardless of the read.
    vi.mocked(resolveCouponValidity).mockResolvedValue({ kind: "unknown" });
    const response = await runTurn("o cupom XPTO123 vale?", [...COUPON_PAIR]);
    expect(response).toBe(SAFE_UNKNOWN_RENDER);
    expect(response).not.toBe(COUPON_INVALID_RENDER);
  });
});

// ── (2) DELIVERY — the NEGATIVE twin, which no real-seam suite drove ──────────

describe("R2-S9 e2e — DELIVERY_NO_COVERAGE reaches the customer through the real turn", () => {
  it("renders the definitive out-of-zone fact with the pickup offer", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(OUT_OF_ZONE);
    const response = await runTurn("vocês entregam no CEP 01001000?", [...DELIVERY_PAIR]);

    expect(response).toBe(DELIVERY_NO_COVERAGE_RENDER);
    expect(response).not.toBe(SAFE_UNKNOWN_RENDER);
    // The pickup offer is the template's own STATIC frame — an offer, not a proposition —
    // and asserting it here is what proves the negative twin's frame is wired, not just
    // its bound value.
    expect(response).toContain("retirar aqui no restaurante");
  });

  it("THE CONTROL: an UNREADABLE zone read degrades — never a wrongly-confident 'não entregamos'", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "unknown" });
    const response = await runTurn("vocês entregam no CEP 01001000?", [...DELIVERY_PAIR]);
    expect(response).toBe(SAFE_UNKNOWN_RENDER);
    expect(response).not.toContain("Ainda não entregamos");
  });
});

// ── (3) THE DISCRIMINATING AXIS the pairs exist for ──────────────────────────
//
// Each pair's two members carry genuinely DIFFERENT static frames — that is the argument
// `claim-registry.ts` makes for why each family is a PAIR rather than one type with a
// validity/coverage field. These two cases are what make that argument falsifiable at the
// seam: the same question, the same proposed pair, ONLY the read differs, and the customer
// hears two different sentences with two different offers.
describe("R2-S9 e2e — one question, two reads, two DIFFERENT frames (why each family is a pair)", () => {
  it("COUPON: the positive ends at checkout, the negative offers another code", async () => {
    vi.mocked(resolveCouponValidity).mockResolvedValue(VALID_COUPON);
    const yes = await runTurn("o cupom BEMVINDO15 vale?", [...COUPON_PAIR]);
    vi.mocked(resolveCouponValidity).mockResolvedValue(INVALID_COUPON);
    const no = await runTurn("o cupom XPTO123 vale?", [...COUPON_PAIR]);

    expect(yes).not.toBe(no);
    expect(yes).toContain("É só informar o código no checkout.");
    expect(no).toContain("me manda que eu confiro");
    // Neither frame leaks into the other — a single type with a boolean field could not
    // achieve this under the frozen single-C6-field kernel, which is the registry's own
    // argument for the pair.
    expect(yes).not.toContain("me manda que eu confiro");
    expect(no).not.toContain("checkout");
  });

  it("DELIVERY: the positive carries the checkout caveat, the negative offers pickup", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue({
      kind: "covered",
      coverageText:
        "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos",
      zoneName: "Ibaté",
      feeInCentavos: 1500,
      estimatedMinutes: 50,
    });
    const yes = await runTurn("vocês entregam em Ibaté?", [...DELIVERY_PAIR]);
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(OUT_OF_ZONE);
    const no = await runTurn("vocês entregam no CEP 01001000?", [...DELIVERY_PAIR]);

    expect(yes).not.toBe(no);
    expect(yes).toContain("Confirmo certinho pelo endereço no checkout.");
    expect(no).toContain("mas você pode retirar aqui no restaurante, se preferir.");
    expect(yes).not.toContain("retirar aqui no restaurante");
    expect(no).not.toContain("Confirmo certinho");
  });
});
