/**
 * FE-T18 (FE-3.0 / D1) — the classify-only grounded-read toggle
 * (classify-only-reads.ts) + its wiring into `ibatexas-claim-planner.ts`.
 *
 * Two layers, per the ticket's acceptance criteria:
 *
 *   A. Unit tests of the pure toggle module: the flag reader (default OFF),
 *      the classification/eligibility gate (`classifyOnlyRequiredTypes` —
 *      empty / eligible / ineligible / mixed), and the deterministic subject
 *      resolution (`buildClassifyOnlyCandidates` — one/zero/many owned).
 *
 *   B. Seam-level proof, mirroring FE-T15 (`PAYMENT_STATUS`, "O status do seu
 *      pagamento é: pago.") and FE-T17 (`RESERVATION_STATUS`, "O status da sua
 *      reserva é: confirmada." / the honest-abstain falsifier arm) EXACTLY —
 *      driven through `createIbatexasClaimPlanner`, the real per-turn kernel
 *      deps, and the real `createIbatexasClaimsRenderer` adapter:
 *        - ON, read-classified → the SAME validated render as the pre-change
 *          proofs, with ZERO calls to the planner's `proposeClaims` (the
 *          propose_claim model call), asserted via a call-counting spy;
 *        - ON, 0-owned → the SAME honest SAFE_UNKNOWN abstain, zero model calls;
 *        - ON, ≥2-owned → CLARIFY (the same safe abstain text), zero model calls;
 *        - OFF (default) → the model path runs exactly as before (spy called);
 *        - ON, a non-read / mixed-span turn → falls through to the model path
 *          (requirement: non-read turns and ineligible-mixed turns unchanged).
 *
 * Pure unit tests — a hand-built `ClaimAwarePlannerPort` spy + real
 * `EvidenceLedger`; no DB / no live model.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvidenceLedger,
  runClaimsKernel,
  type CandidateClaim,
} from "@adjudicate/core";
import type { ClaimPlannerInput, CognitiveState, Plan } from "@claustrum/core";
import { normalizeClaimPlannerResult } from "@claustrum/core";
import type {
  ClaimAuthContext,
  ClaimAwarePlannerPort,
  ClaimPlan,
} from "../ibatexas-planner.js";
import { createIbatexasClaimPlanner } from "../ibatexas-claim-planner.js";
import { createPerTurnClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
import { createIbatexasClaimsRenderer } from "../claims-renderer-adapter.js";
import {
  buildClassifyOnlyCandidates,
  CLASSIFY_ONLY_ELIGIBLE_TYPES,
  CLASSIFY_ONLY_READS_ENABLED_ENV,
  classifyOnlyReadsEnabled,
  classifyOnlyRequiredTypes,
  deriveDisambiguationCandidates,
  presentPublicItemIds,
  publicPerItemBaseKey,
  resolveNamedOwnedOrderSubject,
} from "../classify-only-reads.js";
import { ownerScopedBaseKey } from "../claim-registry.js";
import {
  classifyRequestSpans,
  decomposeRequiredClaims,
} from "../required-claim-decomposer.js";

// ── A. Pure toggle-module unit tests ────────────────────────────────────────

describe("classifyOnlyReadsEnabled — flag reader (default OFF)", () => {
  it("is OFF by default and only ON for the exact 'true' string", () => {
    expect(classifyOnlyReadsEnabled({})).toBe(false);
    expect(classifyOnlyReadsEnabled({ [CLASSIFY_ONLY_READS_ENABLED_ENV]: "1" })).toBe(false);
    expect(classifyOnlyReadsEnabled({ [CLASSIFY_ONLY_READS_ENABLED_ENV]: "false" })).toBe(false);
    expect(classifyOnlyReadsEnabled({ [CLASSIFY_ONLY_READS_ENABLED_ENV]: "true" })).toBe(true);
  });
});

describe("classifyOnlyRequiredTypes — the eligibility gate", () => {
  it("smalltalk / no matched span → undefined (not read-shaped)", () => {
    expect(classifyOnlyRequiredTypes("oi, tudo bem?")).toBeUndefined();
  });

  it("a payment-status question → {PAYMENT_STATUS} (FE-T15 shape)", () => {
    expect(classifyOnlyRequiredTypes("meu pagamento foi aprovado?")).toEqual(
      new Set(["PAYMENT_STATUS"]),
    );
  });

  it("a reservation question → {RESERVATION_STATUS} (FE-T17 shape)", () => {
    expect(classifyOnlyRequiredTypes("qual minha reserva?")).toEqual(
      new Set(["RESERVATION_STATUS"]),
    );
  });

  it("BKL-139/BKL-163 — a cart-contents question → the complementary pair (eligible)", () => {
    // BKL-163 — the closure row requires BOTH complements; CART_EMPTY joined the
    // eligible set in LOCKSTEP so the cart turn still classifies-only (omitting it
    // would decline the whole family wholesale).
    expect(classifyOnlyRequiredTypes("o que tem no meu carrinho?")).toEqual(
      new Set(["CART_CONTENTS", "CART_EMPTY"]),
    );
  });

  it("BKL-139 — a cart question co-occurring with a schedule span → undefined (declined wholesale)", () => {
    // "carrinho" alone → the fully-eligible {CART_CONTENTS}; "abertos" alone maps to the
    // ineligible STORE_OPEN_NOW → the mixed turn declines entirely (FE-D12 boundary).
    expect(
      classifyOnlyRequiredTypes("o que tem no meu carrinho e vocês estão abertos?"),
    ).toBeUndefined();
  });

  it("FE-D03 — a history question → {ORDER_HISTORY} / {PAYMENT_HISTORY} (eligible, singular suppressed)", () => {
    expect(classifyOnlyRequiredTypes("meu histórico de pedidos")).toEqual(
      new Set(["ORDER_HISTORY"]),
    );
    expect(classifyOnlyRequiredTypes("meus últimos pagamentos")).toEqual(
      new Set(["PAYMENT_HISTORY"]),
    );
  });

  it("FE-D03 — a history question co-occurring with a schedule span → undefined (declined wholesale)", () => {
    expect(
      classifyOnlyRequiredTypes("meu histórico de pedidos e vocês estão abertos?"),
    ).toBeUndefined();
  });

  it("a bare 'status' (no discriminator) → BOTH order+payment (still fully eligible)", () => {
    expect(classifyOnlyRequiredTypes("qual o status?")).toEqual(
      new Set(["ORDER_FULFILLMENT_STAGE", "PAYMENT_STATUS"]),
    );
  });

  it("a schedule-only question → undefined (STORE_OPEN_NOW is NOT in the eligible set)", () => {
    expect(classifyOnlyRequiredTypes("vocês estão abertos agora?")).toBeUndefined();
  });

  it("FE-D12 pin — an ELIGIBLE span co-occurring with an INELIGIBLE span in ONE message → undefined (declined wholesale, never a half-deterministic mix)", () => {
    // "pagamento"/"aprovad" alone would classify to the fully-eligible
    // {PAYMENT_STATUS}; "abertos" alone maps to the ineligible STORE_OPEN_NOW.
    // The SAME message carrying BOTH must decline entirely — the classify-only
    // path never handles part of a turn deterministically and the rest via the
    // model (see classify-only-reads.ts FE-D12: this is also the boundary that
    // bounds the residual safety-marker tradeoff — a mixed turn always falls
    // through to the model path, where a safety marker CAN still self-report).
    const required = decomposeRequiredClaims(
      classifyRequestSpans("meu pagamento foi aprovado, vocês estão abertos agora?"),
    );
    // Sanity: the underlying classifier DID pick up both — proving this is a
    // genuine mixed-span case, not an accidental miss of the payment marker.
    expect(required.has("PAYMENT_STATUS")).toBe(true);
    expect(required.has("STORE_OPEN_NOW")).toBe(true);
    expect(
      classifyOnlyRequiredTypes("meu pagamento foi aprovado, vocês estão abertos agora?"),
    ).toBeUndefined();
  });

  it("a PICKUP_Q (pulls in the ineligible STORE_OPEN_NOW companion) → undefined (declined wholesale)", () => {
    expect(classifyOnlyRequiredTypes("posso retirar meu pedido agora?")).toBeUndefined();
  });

  it("every eligible type is registered with a DETERMINISTIC subject path (owner-scoped, public per-item, or fixed-key)", () => {
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.size).toBe(11);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("ORDER_FULFILLMENT_STAGE")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("PAYMENT_STATUS")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("RESERVATION_STATUS")).toBe(true);
    // FE-D03 slice C — the owner-scoped list/history reads.
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("ORDER_HISTORY")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("PAYMENT_HISTORY")).toBe(true);
    // BKL-139 — the owner-scoped cart read joined the eligible set.
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("CART_CONTENTS")).toBe(true);
    // BKL-163 — the provable-empty complement joined in lockstep (the closure row
    // requires the pair; omitting it would decline every cart turn wholesale).
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("CART_EMPTY")).toBe(true);
    // BKL-183 — the PUBLIC menu/store reads (per-item subjects off the ledger;
    // fixed-key for overview/store-info).
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("MENU_ITEM_PRICE")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("MENU_ITEM_CONTENTS")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("MENU_OVERVIEW")).toBe(true);
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("STORE_INFO")).toBe(true);
    // The SAFETY carve-out is structural: MENU_ITEM_ALLERGENS is NOT eligible
    // (no decomposer span ever requires it — allergen asks keep the model path).
    expect(CLASSIFY_ONLY_ELIGIBLE_TYPES.has("MENU_ITEM_ALLERGENS")).toBe(false);
  });

  it("BKL-183 — owner-scoped and public-per-item subject mechanisms are mutually exclusive over the eligible set (no type ever needs a model-authored subject)", () => {
    for (const type of CLASSIFY_ONLY_ELIGIBLE_TYPES) {
      const hasOwner = ownerScopedBaseKey(type) !== undefined;
      const hasPublicItem = publicPerItemBaseKey(type) !== undefined;
      // At most one mechanism; NEITHER ⇒ fixed-key (subject "" resolves the
      // bare investigator key). Both ⇒ a registry-shape contradiction.
      expect(hasOwner && hasPublicItem).toBe(false);
    }
    expect(publicPerItemBaseKey("MENU_ITEM_PRICE")).toBe("menu:item_price");
    expect(publicPerItemBaseKey("MENU_ITEM_CONTENTS")).toBe("menu:item_contents");
    // Owner-scoped and fixed-key types have NO public per-item base.
    expect(publicPerItemBaseKey("ORDER_FULFILLMENT_STAGE")).toBeUndefined();
    expect(publicPerItemBaseKey("MENU_OVERVIEW")).toBeUndefined();
    expect(publicPerItemBaseKey("STORE_INFO")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-183 — the PUBLIC menu/store family rides classify-only (the SCN-030 trace
// proved the mechanism bypasses the 4B read-dispatch variance; SCN-006/007's
// flake class). Eligibility-gate + subject-resolution + allergen carve-out.
// ─────────────────────────────────────────────────────────────────────────────
describe("BKL-183 — menu/store classify-only eligibility", () => {
  it("a menu-price question → {MENU_ITEM_PRICE} (the SCN-006 shape)", () => {
    expect(classifyOnlyRequiredTypes("quanto custa o Brisket Americano?")).toEqual(
      new Set(["MENU_ITEM_PRICE"]),
    );
  });

  it("a menu-contents question → {MENU_ITEM_CONTENTS} (the SCN-007 shape)", () => {
    expect(classifyOnlyRequiredTypes("o que vem no Smash Burger Defumado?")).toEqual(
      new Set(["MENU_ITEM_CONTENTS"]),
    );
  });

  it("a menu-overview question → {MENU_OVERVIEW}; store-info → {STORE_INFO}", () => {
    expect(classifyOnlyRequiredTypes("o que tem no cardápio?")).toEqual(
      new Set(["MENU_OVERVIEW"]),
    );
    expect(classifyOnlyRequiredTypes("onde fica o restaurante?")).toEqual(
      new Set(["STORE_INFO"]),
    );
  });

  it("SAFETY carve-out: pure allergen asks decline (model path keeps §O#9 + the BKL-184 offer)", () => {
    expect(classifyOnlyRequiredTypes("o brownie tem amendoim?")).toBeUndefined();
    expect(classifyOnlyRequiredTypes("contém glúten?")).toBeUndefined();
    expect(classifyOnlyRequiredTypes("tem leite na farofa?")).toBeUndefined();
  });

  it("SAFETY carve-out: a MIXED price+allergen ask declines WHOLESALE (never a price render that answers around the allergen half)", () => {
    // "quanto custa" alone → eligible {MENU_ITEM_PRICE}; the allergen noun makes
    // the WHOLE turn decline — the allergen half must keep the model path.
    expect(
      classifyOnlyRequiredTypes("quanto custa o brownie? tem amendoim?"),
    ).toBeUndefined();
  });

  it("a menu span co-occurring with an INELIGIBLE schedule span still declines wholesale", () => {
    expect(
      classifyOnlyRequiredTypes("o que tem no cardápio e vocês estão abertos?"),
    ).toBeUndefined();
  });
});

describe("BKL-183 — public per-item subject resolution (ledger-derived, never model-authored)", () => {
  const stubLedger = (entries: Record<string, "present" | "absent">) => ({
    keys: () => Object.keys(entries),
    resolve: (key: string) => ({ state: entries[key] ?? "absent" }),
  });
  const auth: ClaimAuthContext = { customerId: "cust-A", ownedByBaseKey: new Map() };

  it("presentPublicItemIds — present-only, prefix-exact, deduped", () => {
    const ledger = stubLedger({
      "menu:item_price:prod-1": "present",
      "menu:item_price:prod-gone": "absent",
      "menu:item_contents:prod-2": "present",
      "menu:item_price:": "present", // empty suffix never yields a subject
    });
    expect(presentPublicItemIds(ledger, "menu:item_price")).toEqual(["prod-1"]);
    expect(presentPublicItemIds(ledger, "menu:item_contents")).toEqual(["prod-2"]);
  });

  it("ONE present menu-item read → the candidate subject is that productId (keys parameterized to match the investigator)", () => {
    const ledger = stubLedger({ "menu:item_price:prod-1": "present" });
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["MENU_ITEM_PRICE"]),
      auth,
      "conv-1",
      ledger,
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subject).toBe("prod-1");
  });

  it("NO present read (unresolved item) → empty subject → honest UNKNOWN downstream, never an arbitrary product", () => {
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["MENU_ITEM_CONTENTS"]),
      auth,
      "conv-1",
      stubLedger({}),
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subject).toBe("");
  });

  it("NO ledger (unwired host) → empty subject (fail-closed), same honest-abstain shape", () => {
    const { candidates } = buildClassifyOnlyCandidates(
      new Set(["MENU_ITEM_PRICE"]),
      auth,
      "conv-1",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subject).toBe("");
  });

  it("≥2 present item reads (defensive — the resolver records ≤1 today) → GENERIC CLARIFY, candidate dropped, NO order-voicing stash", () => {
    const ledger = stubLedger({
      "menu:item_price:prod-1": "present",
      "menu:item_price:prod-2": "present",
    });
    const { candidates, forcedTerminal, ambiguousOwnedSets } = buildClassifyOnlyCandidates(
      new Set(["MENU_ITEM_PRICE"]),
      auth,
      "conv-1",
      ledger,
    );
    expect(forcedTerminal).toBe("CLARIFY");
    expect(candidates).toHaveLength(0);
    // Menu ambiguity has no #displayId vocabulary — it must NOT ride the
    // BKL-170 order-voicing carrier.
    expect(ambiguousOwnedSets).toBeUndefined();
  });

  it("FIXED-key public types (MENU_OVERVIEW / STORE_INFO) → subject '' and UNPARAMETERIZED keys (the bare investigator key)", () => {
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["MENU_OVERVIEW", "STORE_INFO"]),
      auth,
      "conv-1",
      stubLedger({}),
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates).toHaveLength(2);
    for (const c of candidates) expect(c.subject).toBe("");
  });
});

describe("buildClassifyOnlyCandidates — deterministic FIX-1/FIX-2 mirror (no model)", () => {
  it("exactly ONE owned resource → binds it (the common case)", () => {
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["payment_status", ["pay-A"]]]),
    };
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["PAYMENT_STATUS"]),
      auth,
      "conv-1",
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subject).toBe("pay-A");
    expect(candidates[0]?.soundness.actor).toMatchObject({ principal: "cust-A" });
  });

  it("ZERO owned → an empty subject (the kernel then honest-abstains, never a guess)", () => {
    const auth: ClaimAuthContext = { customerId: "cust-A", ownedByBaseKey: new Map() };
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["RESERVATION_STATUS"]),
      auth,
      "conv-1",
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.subject).toBe("");
  });

  it("≥2 owned → CLARIFY, that type's candidate dropped (never a guess)", () => {
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A1", "order-A2"]]]),
    };
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["ORDER_FULFILLMENT_STAGE"]),
      auth,
      "conv-1",
    );
    expect(forcedTerminal).toBe("CLARIFY");
    expect(candidates).toHaveLength(0);
  });

  it("multiple required types resolve INDEPENDENTLY (order ambiguous, payment unambiguous)", () => {
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([
        ["order_fulfillment_stage", ["order-A1", "order-A2"]],
        ["payment_status", ["pay-A"]],
      ]),
    };
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["ORDER_FULFILLMENT_STAGE", "PAYMENT_STATUS"]),
      auth,
      "conv-1",
    );
    expect(forcedTerminal).toBe("CLARIFY");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("PAYMENT_STATUS");
    expect(candidates[0]?.subject).toBe("pay-A");
  });

  it("unauthenticated (no customerId) → the fail-closed 'unauthenticated' principal", () => {
    const { candidates } = buildClassifyOnlyCandidates(
      new Set(["PAYMENT_STATUS"]),
      {},
      "conv-1",
    );
    expect(candidates[0]?.soundness.actor).toMatchObject({ principal: "unauthenticated" });
  });
});

// ── B. Seam-level proof (createIbatexasClaimPlanner + the real kernel + the
//    real adapter) — mirrors FE-T15 / FE-T17 exactly, plus the model-call
//    call-count assertion the toggle exists to prove. ────────────────────────

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

/** A `ClaimAwarePlannerPort` whose `proposeClaims` is a counting spy — the
 *  model-call oracle: `spy.mock.calls.length` after driving a turn is the
 *  ground truth for "was the propose_claim model call made this turn?" */
function spyPlanner(plan: ClaimPlan = { candidates: [], completeness: [], droppedClaimTypes: [] }) {
  const proposeClaimsSpy = vi.fn(async (): Promise<ClaimPlan> => plan);
  const port: ClaimAwarePlannerPort = {
    async propose(): Promise<Plan> {
      return { envelopes: [] };
    },
    proposeClaims: proposeClaimsSpy,
  };
  return { port, proposeClaimsSpy };
}

const NOW = 40_000;

function recordPayment(ledger: EvidenceLedger, orderId: string, status: string): void {
  ledger.record({
    key: `payment_status:${orderId}`,
    value: { status },
    source: "payment.getActiveByOrderId",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

function recordReservation(ledger: EvidenceLedger, reservationId: string): void {
  ledger.record({
    key: `reservation_status:${reservationId}`,
    value: { status: "confirmed", partySize: 2, date: "2026-07-20", startTime: "19:30", statusLine: "confirmada — 20/07 às 19:30, para 2 pessoas" },
    source: "reservation.getById",
    fetchedAt: NOW,
    sourceMode: "live",
    taint: "TRUSTED",
    originProvenance: "FIRST_PARTY",
  });
}

const ENV_KEY = CLASSIFY_ONLY_READS_ENABLED_ENV;
const originalEnv = process.env[ENV_KEY];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

async function driveAndRender(params: {
  readonly text: string;
  readonly customerId: string;
  readonly ledger: EvidenceLedger;
}): Promise<{ text: string; forcedTerminal?: string; proposeClaimsSpy: ReturnType<typeof spyPlanner>["proposeClaimsSpy"] }> {
  const { port, proposeClaimsSpy } = spyPlanner();
  const adapter = createIbatexasClaimPlanner(port);
  const input: ClaimPlannerInput = {
    cognition: state(params.text),
    plan: { envelopes: [] } as Plan,
    customerId: params.customerId,
    ledger: params.ledger,
  };
  const normalized = normalizeClaimPlannerResult(await adapter.propose(input));

  const result = runClaimsKernel(
    params.ledger,
    normalized.candidates,
    createPerTurnClaimsKernelDeps({
      now: NOW,
      ownership: {
        principal: params.customerId,
        // The adapter derives the OWNED set from the ledger's PRESENT owner-scoped
        // entries (ownedResourceIdsByBaseKey) — mirror that here for the kernel's
        // REAL per-turn owns, so this test exercises the SAME production shape.
        ownedResources: new Set(
          [...params.ledger.keys()]
            .filter((k) => params.ledger.resolve(k).state === "present")
            .map((k) => k.split(":").slice(1).join(":"))
            .filter((id) => id.length > 0),
        ),
      },
      outcomes: [],
    }),
  );

  const rendered = createIbatexasClaimsRenderer().render(result, { requestText: params.text });
  return {
    text: rendered.text,
    forcedTerminal: normalized.forcedTerminal,
    proposeClaimsSpy,
  };
}

describe("FE-T18 — classify-only ON: PAYMENT_STATUS matches FE-T15's proof, ZERO model calls", () => {
  it('"meu pagamento foi aprovado?" + one owned payment → "O status do seu pagamento é: pago." (0 propose_claim calls)', async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-1");
    recordPayment(ledger, "pay-A", "paid");
    const { text, proposeClaimsSpy } = await driveAndRender({
      text: "meu pagamento foi aprovado?",
      customerId: "cust-A",
      ledger,
    });
    expect(text).toBe("O status do seu pagamento é: pago.");
    expect(proposeClaimsSpy).not.toHaveBeenCalled();
  });
});

describe("FE-T18 — classify-only ON: RESERVATION_STATUS matches FE-T17's proof, ZERO model calls", () => {
  it('"qual minha reserva?" + one owned reservation → "O status da sua reserva é: confirmada." (0 propose_claim calls)', async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-2");
    recordReservation(ledger, "res-A");
    const { text, proposeClaimsSpy } = await driveAndRender({
      text: "qual minha reserva?",
      customerId: "cust-A",
      ledger,
    });
    expect(text).toBe("O status da sua reserva é: confirmada — 20/07 às 19:30, para 2 pessoas.");
    expect(proposeClaimsSpy).not.toHaveBeenCalled();
  });

  it("FE-T17 falsifier arm — ZERO reservations → the SAME honest abstain, 0 propose_claim calls", async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-3"); // nothing recorded
    const { text, proposeClaimsSpy } = await driveAndRender({
      text: "qual minha reserva?",
      customerId: "cust-A",
      ledger,
    });
    expect(text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
    expect(proposeClaimsSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-183 — the PUBLIC menu/store family end-to-end through the REAL adapter →
// kernel → renderer chain (the SCN-006/007/004/005 shapes): grounded read →
// deterministic candidate → VALIDATED render, ZERO propose_claim model calls —
// the 4B read-dispatch variance structurally bypassed.
// ─────────────────────────────────────────────────────────────────────────────
describe("BKL-183 — classify-only ON: the menu/store family renders with ZERO model calls", () => {
  function recordPublic(ledger: EvidenceLedger, key: string, value: unknown): void {
    ledger.record({
      key,
      value,
      source: "catalog.read",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
  }

  it('menu PRICE (SCN-006): grounded item read → "Brisket Americano custa R$ 78,00." (0 model calls)', async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-mp");
    recordPublic(ledger, "menu:item_price:prod-1", {
      priceText: "Brisket Americano custa R$ 78,00",
    });
    const { text, proposeClaimsSpy } = await driveAndRender({
      text: "quanto custa o Brisket Americano?",
      customerId: "cust-A",
      ledger,
    });
    expect(text).toBe("Brisket Americano custa R$ 78,00.");
    expect(proposeClaimsSpy).not.toHaveBeenCalled();
  });

  it("menu CONTENTS (SCN-007): grounded description → the contents render (0 model calls)", async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-mc");
    recordPublic(ledger, "menu:item_contents:prod-2", {
      contentsText: "Smash Burger Defumado: blend 160g, queijo, picles",
    });
    const { text, proposeClaimsSpy } = await driveAndRender({
      text: "o que vem no Smash Burger Defumado?",
      customerId: "cust-A",
      ledger,
    });
    expect(text).toBe("Smash Burger Defumado: blend 160g, queijo, picles.");
    expect(proposeClaimsSpy).not.toHaveBeenCalled();
  });

  it("menu OVERVIEW (SCN-005) + STORE_INFO (SCN-004): fixed-key reads render bare (0 model calls)", async () => {
    process.env[ENV_KEY] = "true";
    const ledgerOv = new EvidenceLedger("turn-ov");
    recordPublic(ledgerOv, "menu:overview", {
      overviewText: "No nosso cardápio: Costela — R$ 89,00.",
    });
    const ov = await driveAndRender({
      text: "o que tem no cardápio?",
      customerId: "cust-A",
      ledger: ledgerOv,
    });
    expect(ov.text).toBe("No nosso cardápio: Costela — R$ 89,00.");
    expect(ov.proposeClaimsSpy).not.toHaveBeenCalled();

    const ledgerSi = new EvidenceLedger("turn-si");
    recordPublic(ledgerSi, "store:info", {
      infoText: "Estamos em Rua Santa Cruz, 456 — Centro, Ibaté/SP.",
    });
    const si = await driveAndRender({
      text: "onde fica o restaurante?",
      customerId: "cust-A",
      ledger: ledgerSi,
    });
    expect(si.text).toBe("Estamos em Rua Santa Cruz, 456 — Centro, Ibaté/SP.");
    expect(si.proposeClaimsSpy).not.toHaveBeenCalled();
  });

  it("UNRESOLVED item (no present read) → the honest abstain, 0 model calls", async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-mu"); // nothing recorded
    const { text, proposeClaimsSpy } = await driveAndRender({
      text: "qual o preço do X-Tudo?",
      customerId: "cust-A",
      ledger,
    });
    expect(text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
    expect(proposeClaimsSpy).not.toHaveBeenCalled();
  });

  it("SAFETY carve-out end-to-end: an allergen-family ask DOES call the model path (the §O#9 chance is preserved)", async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-al");
    const { proposeClaimsSpy } = await driveAndRender({
      text: "quanto custa o brownie? tem amendoim?",
      customerId: "cust-A",
      ledger,
    });
    expect(proposeClaimsSpy).toHaveBeenCalledTimes(1);
  });
});

describe("FE-T18 — classify-only ON: ambiguous ownership → CLARIFY (safe abstain), 0 model calls", () => {
  it("≥2 owned orders + a bare 'status' → CLARIFY-shaped safe render, never a leaked guess", async () => {
    process.env[ENV_KEY] = "true";
    const { port, proposeClaimsSpy } = spyPlanner();
    const adapter = createIbatexasClaimPlanner(port);
    const ledger = new EvidenceLedger("turn-4");
    ledger.record({
      key: "order_fulfillment_stage:order-A1",
      value: { fulfillmentStatus: "preparing" },
      source: "order.getById",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    ledger.record({
      key: "order_fulfillment_stage:order-A2",
      value: { fulfillmentStatus: "ready" },
      source: "order.getById",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    const input: ClaimPlannerInput = {
      cognition: state("qual o status?"),
      plan: { envelopes: [] } as Plan,
      customerId: "cust-A",
      ledger,
    };
    const normalized = normalizeClaimPlannerResult(await adapter.propose(input));
    // ORDER_FULFILLMENT_STAGE dropped (ambiguous, ≥2 owned); PAYMENT_STATUS has
    // zero owned so it still proposes (empty subject) — forcedTerminal CLARIFY
    // outranks it regardless (BKL-077: CLAIMS-VALIDATE honors forcedTerminal even
    // over a non-empty candidate set).
    expect(normalized.forcedTerminal).toBe("CLARIFY");
    expect(proposeClaimsSpy).not.toHaveBeenCalled();
  });
});

describe("FE-T18 — the toggle is OFF by default: the model path runs exactly as before", () => {
  it("no env var set → propose_claim IS called (regression pin against 15/16/17)", async () => {
    delete process.env[ENV_KEY];
    const ledger = new EvidenceLedger("turn-5");
    recordPayment(ledger, "pay-A", "paid");
    const { proposeClaimsSpy } = await driveAndRender({
      text: "meu pagamento foi aprovado?",
      customerId: "cust-A",
      ledger,
    });
    expect(proposeClaimsSpy).toHaveBeenCalledTimes(1);
  });

  it('ON but explicitly "false" → still calls the model (only the literal "true" string enables it)', async () => {
    process.env[ENV_KEY] = "false";
    const ledger = new EvidenceLedger("turn-6");
    recordPayment(ledger, "pay-A", "paid");
    const { proposeClaimsSpy } = await driveAndRender({
      text: "meu pagamento foi aprovado?",
      customerId: "cust-A",
      ledger,
    });
    expect(proposeClaimsSpy).toHaveBeenCalledTimes(1);
  });
});

describe("FE-T18 — classify-only ON: non-read / mixed-span turns are UNCHANGED (still call the model)", () => {
  it("smalltalk → the model path still runs (requirement: non-read turns unchanged)", async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-7");
    const { proposeClaimsSpy } = await driveAndRender({
      text: "oi, tudo bem?",
      customerId: "cust-A",
      ledger,
    });
    expect(proposeClaimsSpy).toHaveBeenCalledTimes(1);
  });

  it("a PICKUP_Q (mixed span pulling in the ineligible STORE_OPEN_NOW) → falls through to the model path", async () => {
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-8");
    const { proposeClaimsSpy } = await driveAndRender({
      text: "posso retirar meu pedido agora?",
      customerId: "cust-A",
      ledger,
    });
    expect(proposeClaimsSpy).toHaveBeenCalledTimes(1);
  });

  it("FE-D12 pin — an ELIGIBLE payment span co-occurring with an INELIGIBLE schedule span → the model path is taken (bypass NOT taken)", async () => {
    // Pins the exact boundary that bounds the FE-D12 residual (classify-only-
    // reads.ts): a turn combining a fully-eligible PAYMENT_STATUS_Q phrase with
    // an ineligible STORE_OPEN_NOW_Q phrase in the SAME message must decline
    // the bypass WHOLESALE and reach the model's propose_claim call — so any
    // safety-marker self-report the model would attach to THIS turn is never
    // silently skipped just because part of the message also asked about a
    // payment status.
    process.env[ENV_KEY] = "true";
    const ledger = new EvidenceLedger("turn-9");
    recordPayment(ledger, "pay-A", "paid");
    const { proposeClaimsSpy } = await driveAndRender({
      text: "meu pagamento foi aprovado, vocês estão abertos agora?",
      customerId: "cust-A",
      ledger,
    });
    expect(proposeClaimsSpy).toHaveBeenCalledTimes(1);
  });
});

// ── C. As-typed CandidateClaim sanity (defense-in-depth: the classify-only
//    path never leaks an unvalidated value or skips the constrained-generation
//    shape). ───────────────────────────────────────────────────────────────
describe("FE-T18 — classify-only candidates are ordinary typed CandidateClaims (no bypass of downstream validation)", () => {
  it("the candidate's value is undefined pre-bind (C6 still runs; never a model/self-authored value)", () => {
    const auth: ClaimAuthContext = {
      customerId: "cust-A",
      ownedByBaseKey: new Map([["payment_status", ["pay-A"]]]),
    };
    const { candidates } = buildClassifyOnlyCandidates(
      new Set(["PAYMENT_STATUS"]),
      auth,
      "conv-1",
    );
    const candidate = candidates[0] as CandidateClaim;
    expect(candidate.value).toBeUndefined();
    expect(candidate.type).toBe("PAYMENT_STATUS");
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// BKL-189 — the ambiguity DATA + the labeled-candidate deriver (producer units).
// ─────────────────────────────────────────────────────────────────────────────
describe("BKL-189 — ambiguousOwnedSets + deriveDisambiguationCandidates", () => {
  const NOW2 = 41_000;
  const recordOrderEntry = (
    ledger: EvidenceLedger,
    orderId: string,
    displayId?: number,
  ): void => {
    ledger.record({
      key: `order_fulfillment_stage:${orderId}`,
      value:
        displayId === undefined
          ? { orderId, fulfillmentStatus: "preparing" }
          : { orderId, displayId, fulfillmentStatus: "preparing" },
      source: "order.getById",
      fetchedAt: NOW2,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
  };

  it("the ≥2-owned branch now carries the dropped owned-set data", () => {
    const { forcedTerminal, ambiguousOwnedSets } = buildClassifyOnlyCandidates(
      new Set(["ORDER_FULFILLMENT_STAGE"]),
      {
        customerId: "cust-A",
        ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A1", "order-A2"]]]),
      },
      "conv-1",
    );
    expect(forcedTerminal).toBe("CLARIFY");
    expect(ambiguousOwnedSets).toEqual([
      {
        type: "ORDER_FULFILLMENT_STAGE",
        baseKey: "order_fulfillment_stage",
        ownedIds: ["order-A1", "order-A2"],
      },
    ]);
  });

  it("unambiguous turns carry NO ambiguity data (field absent)", () => {
    const built = buildClassifyOnlyCandidates(
      new Set(["ORDER_FULFILLMENT_STAGE"]),
      {
        customerId: "cust-A",
        ownedByBaseKey: new Map([["order_fulfillment_stage", ["order-A1"]]]),
      },
      "conv-1",
    );
    expect(built.forcedTerminal).toBeUndefined();
    expect(built.ambiguousOwnedSets).toBeUndefined();
  });

  it("derives sorted #displayId candidates from PRESENT ledger entries", () => {
    const ledger = new EvidenceLedger("t-1");
    recordOrderEntry(ledger, "order-B", 205);
    recordOrderEntry(ledger, "order-A", 101);
    const out = deriveDisambiguationCandidates(
      [
        {
          type: "ORDER_FULFILLMENT_STAGE",
          baseKey: "order_fulfillment_stage",
          ownedIds: ["order-A", "order-B"],
        },
      ],
      ledger,
    );
    expect(out).toEqual([
      { kind: "order", id: "order-A", label: "#101" },
      { kind: "order", id: "order-B", label: "#205" },
    ]);
  });

  it("an entry WITHOUT a numeric displayId is SKIPPED — <2 labelable → [] (generic clarify stays)", () => {
    const ledger = new EvidenceLedger("t-2");
    recordOrderEntry(ledger, "order-A", 101);
    recordOrderEntry(ledger, "order-B"); // no displayId (e.g. a stale-dist value)
    const out = deriveDisambiguationCandidates(
      [
        {
          type: "ORDER_FULFILLMENT_STAGE",
          baseKey: "order_fulfillment_stage",
          ownedIds: ["order-A", "order-B"],
        },
      ],
      ledger,
    );
    expect(out).toEqual([]);
  });

  it("a NON-order base (reservation) is skipped — no reservation candidates, generic clarify stays", () => {
    const ledger = new EvidenceLedger("t-3");
    ledger.record({
      key: "reservation_status:res-A",
      value: { status: "confirmed" },
      source: "reservation.getById",
      fetchedAt: NOW2,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    const out = deriveDisambiguationCandidates(
      [
        {
          type: "RESERVATION_STATUS",
          baseKey: "reservation_status",
          ownedIds: ["res-A", "res-B"],
        },
      ],
      ledger,
    );
    expect(out).toEqual([]);
  });
});

// ── BKL-203 — the ≥2-owned customer NAMES an order (no dead-end) ─────────────────
describe("BKL-203 — resolveNamedOwnedOrderSubject + the named-order bind", () => {
  const NOW3 = 42_000;
  const orderLedger = (
    entries: ReadonlyArray<{ id: string; displayId?: number }>,
  ): EvidenceLedger => {
    const ledger = new EvidenceLedger("bkl203");
    for (const { id, displayId } of entries) {
      ledger.record({
        key: `order_fulfillment_stage:${id}`,
        value:
          displayId === undefined
            ? { orderId: id, fulfillmentStatus: "preparing" }
            : { orderId: id, displayId, fulfillmentStatus: "preparing" },
        source: "order.getById",
        fetchedAt: NOW3,
        sourceMode: "live",
        taint: "TRUSTED",
        originProvenance: "FIRST_PARTY",
      });
    }
    return ledger;
  };
  const OWNED = ["order-A", "order-B"];
  const ledger = orderLedger([
    { id: "order-A", displayId: 933869 },
    { id: "order-B", displayId: 988896 },
  ]);

  // ── the pure matcher ──
  it("binds the single owned order whose displayId is named in the message", () => {
    expect(
      resolveNamedOwnedOrderSubject(
        "order_fulfillment_stage",
        OWNED,
        ledger,
        "status do pedido 933869?",
      ),
    ).toBe("order-A");
  });

  it("IDOR — a displayId NOT in the owned set never binds (SCN-036 stays honest)", () => {
    // 111111 is some OTHER customer's order number — not in this customer's ledger.
    expect(
      resolveNamedOwnedOrderSubject(
        "order_fulfillment_stage",
        OWNED,
        ledger,
        "status do pedido 111111?",
      ),
    ).toBeUndefined();
  });

  it("no in-message reference → undefined (the ambiguity CLARIFY stands)", () => {
    expect(
      resolveNamedOwnedOrderSubject(
        "order_fulfillment_stage",
        OWNED,
        ledger,
        "como estão meus pedidos?",
      ),
    ).toBeUndefined();
  });

  it("a whole-token match only — '93386' does not match displayId 933869", () => {
    expect(
      resolveNamedOwnedOrderSubject(
        "order_fulfillment_stage",
        OWNED,
        ledger,
        "pedido 93386",
      ),
    ).toBeUndefined();
  });

  it("a non-order base (reservation) never resolves by displayId", () => {
    expect(
      resolveNamedOwnedOrderSubject(
        "reservation_status",
        ["res-A", "res-B"],
        ledger,
        "reserva 933869",
      ),
    ).toBeUndefined();
  });

  it("an entry without a numeric displayId is skipped (no false bind)", () => {
    const noDisplay = orderLedger([
      { id: "order-A" },
      { id: "order-B", displayId: 988896 },
    ]);
    // Naming the ONLY labelable order still binds it…
    expect(
      resolveNamedOwnedOrderSubject(
        "order_fulfillment_stage",
        OWNED,
        noDisplay,
        "pedido 988896",
      ),
    ).toBe("order-B");
    // …but the displayId-less order can never be named/bound.
    expect(
      resolveNamedOwnedOrderSubject(
        "order_fulfillment_stage",
        OWNED,
        noDisplay,
        "pedido 933869",
      ),
    ).toBeUndefined();
  });

  // ── the integration into buildClassifyOnlyCandidates ──
  it("≥2 owned + NAMED order → binds the named subject, NO CLARIFY", () => {
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["ORDER_FULFILLMENT_STAGE"]),
      {
        customerId: "cust-A",
        ownedByBaseKey: new Map([["order_fulfillment_stage", OWNED]]),
      },
      "conv-1",
      ledger,
      "status do pedido 988896?",
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe("ORDER_FULFILLMENT_STAGE");
    expect(candidates[0]?.subject).toBe("order-B");
  });

  it("≥2 owned + FOREIGN order number → still CLARIFY (IDOR-safe, no cross-owner bind)", () => {
    const { candidates, forcedTerminal, ambiguousOwnedSets } =
      buildClassifyOnlyCandidates(
        new Set(["ORDER_FULFILLMENT_STAGE"]),
        {
          customerId: "cust-A",
          ownedByBaseKey: new Map([["order_fulfillment_stage", OWNED]]),
        },
        "conv-1",
        ledger,
        "status do pedido 111111?",
      );
    expect(forcedTerminal).toBe("CLARIFY");
    expect(candidates).toHaveLength(0);
    expect(ambiguousOwnedSets).toHaveLength(1);
  });

  it("≥2 owned + NO message text (backward-compat call) → CLARIFY unchanged", () => {
    const { forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["ORDER_FULFILLMENT_STAGE"]),
      {
        customerId: "cust-A",
        ownedByBaseKey: new Map([["order_fulfillment_stage", OWNED]]),
      },
      "conv-1",
      ledger,
      // messageText omitted
    );
    expect(forcedTerminal).toBe("CLARIFY");
  });

  it("payment_status also binds a named order (PAYMENT_STATUS subject IS the order)", () => {
    const payLedger = new EvidenceLedger("bkl203-pay");
    for (const [id, displayId] of [
      ["order-A", 933869],
      ["order-B", 988896],
    ] as const) {
      payLedger.record({
        key: `payment_status:${id}`,
        value: { orderId: id, displayId, status: "paid" },
        source: "payment.getByOrderId",
        fetchedAt: NOW3,
        sourceMode: "live",
        taint: "TRUSTED",
        originProvenance: "FIRST_PARTY",
      });
    }
    const { candidates, forcedTerminal } = buildClassifyOnlyCandidates(
      new Set(["PAYMENT_STATUS"]),
      {
        customerId: "cust-A",
        ownedByBaseKey: new Map([["payment_status", OWNED]]),
      },
      "conv-1",
      payLedger,
      "o pagamento do pedido 933869 foi aprovado?",
    );
    expect(forcedTerminal).toBeUndefined();
    expect(candidates[0]?.subject).toBe("order-A");
  });
});
