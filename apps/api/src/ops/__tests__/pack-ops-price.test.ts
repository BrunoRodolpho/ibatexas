// pack-ops-price — NEW-004: product.price.set adjudicated THROUGH THE REAL
// COMPOSED policy router.
//
// Exercises the exact composition claustrum-bootstrap feeds policyForKind
// (buildIbatexasPolicyPacks over IBATEXAS_COMPOSED_PACKS incl. opsPack) + the
// REAL kernel adjudicate. Proves the full authority + governance stack on the
// price verb:
//   - the adopter staffRoleGuard + the staff-role matrix (OWNER/MANAGER pass,
//     ATTENDANT / absent-role REFUSE) — the AUTH-phase role gate;
//   - the ops pack's OWN adminSessionOnlyGuard (a non-admin session REFUSEs);
//   - the pack's strict CLOSED-payload validation (Hard Rule #2: integer > 0),
//     product existence, uniform-variant guard, and the absurd-price sanity cap;
//   - THE NEW-004 UNTRUSTED-taint CONFIRM overlay — a model-parsed price ALWAYS
//     REQUEST_CONFIRMATIONs with a name + old→new prompt; a TRUSTED price EXECUTEs
//     (the overlay keys on taint, so a future trusted caller is untouched).
//
// Mirrors pack-ops-availability.test.ts (the proven composed-router pattern).

import { describe, expect, it } from "vitest";
import { buildEnvelope, type Decision, type IntentEnvelope } from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../../claustrum/compose-policy-packs.js";
import {
  resolveCapabilityPolicy,
  type CapabilityPolicyPack,
} from "../../claustrum/capability-policy.js";

// The EXACT composition claustrum-bootstrap feeds policyForKind.
const IBATEXAS_POLICY_PACKS = buildIbatexasPolicyPacks(
  IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
);

/** The composed bundle that owns `product.price.set` (with the prepended adopter guards). */
function priceBundle(): PolicyBundle<string, unknown, unknown> {
  const bundle = resolveCapabilityPolicy(
    IBATEXAS_POLICY_PACKS as unknown as ReadonlyArray<CapabilityPolicyPack>,
    "product.price.set",
  );
  if (!bundle) throw new Error("no composed pack owns product.price.set");
  return bundle;
}

const DET_TIME = "2026-07-04T12:00:00.000Z";

/** The staffRoleGuard uses ONE code (staff_role_violation); the distinct case rides basis.meta.reason. */
const basisMentions = (decision: Decision, reason: string): boolean =>
  JSON.stringify((decision as { basis?: unknown }).basis ?? []).includes(reason);

interface PriceProduct {
  id: string;
  status: string;
  name: string;
  currentPriceCentavos: number;
  divergentVariantPrices: boolean;
}

function priceEnvelope(
  payload: Record<string, unknown>,
  opts: {
    sessionId?: string;
    role?: string;
    principal?: "user" | "llm";
    // NEW-004: the ops persona path is UNTRUSTED (model-parsed) → CONFIRM overlay.
    taint?: "SYSTEM" | "TRUSTED" | "UNTRUSTED";
  } = {},
): IntentEnvelope {
  const {
    sessionId = "admin:staff_1",
    role = "OWNER",
    principal = "user",
    taint = "UNTRUSTED",
  } = opts;
  return buildEnvelope({
    kind: "product.price.set",
    payload,
    actor: { principal, sessionId, ...(role ? { role } : {}) },
    taint,
    nonce: `n-${role || "none"}-${sessionId}-${taint}`,
    createdAt: DET_TIME,
  }) as IntentEnvelope;
}

/** A broad ctx superset + a present, UNIFORM-price product so the pack guards read real state. */
function priceWorld(
  priceProduct: PriceProduct | null = {
    id: "prod_1",
    status: "published",
    name: "Picanha",
    currentPriceCentavos: 8900,
    divergentVariantPrices: false,
  },
): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: "staff_1",
      tenantId: "ibatexas",
    },
    priceProduct,
  };
}

const VALID = { productId: "prod_1", priceCentavos: 9500, reason: "reajuste" };

const run = async (
  envelope: IntentEnvelope,
  state: unknown,
): Promise<Decision> => adjudicate(envelope, state as never, priceBundle());

describe("product.price.set through the composed router — role matrix (NEW-004)", () => {
  it("OWNER + valid UNTRUSTED payload + product present → REQUEST_CONFIRMATION (the model path always confirms)", async () => {
    const d = await run(priceEnvelope(VALID, { role: "OWNER" }), priceWorld());
    expect(d.kind).toBe("REQUEST_CONFIRMATION");
  });

  it("MANAGER → REQUEST_CONFIRMATION", async () => {
    const d = await run(priceEnvelope(VALID, { role: "MANAGER" }), priceWorld());
    expect(d.kind).toBe("REQUEST_CONFIRMATION");
  });

  it("ATTENDANT → REFUSE (staff_role_violation / staff_role_not_permitted) — matrix {OWNER,MANAGER}", async () => {
    const d = await run(priceEnvelope(VALID, { role: "ATTENDANT" }), priceWorld());
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("staff_role_violation");
    expect(basisMentions(d, "staff_role_not_permitted")).toBe(true);
  });

  it("absent role → REFUSE (staff_role_absent, fail-closed)", async () => {
    const d = await run(priceEnvelope(VALID, { role: "" }), priceWorld());
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("staff_role_violation");
    expect(basisMentions(d, "staff_role_absent")).toBe(true);
  });
});

describe("product.price.set — the UNTRUSTED-taint CONFIRM overlay (NEW-004)", () => {
  it("the CONFIRM prompt states the product NAME + old→new BRL", async () => {
    const d = await run(priceEnvelope(VALID, { role: "OWNER" }), priceWorld());
    expect(d.kind).toBe("REQUEST_CONFIRMATION");
    if (d.kind === "REQUEST_CONFIRMATION") {
      // old R$89,00 (currentPriceCentavos 8900) → new R$95,00 (priceCentavos 9500).
      expect(d.prompt).toContain("Picanha");
      expect(d.prompt).toContain("R$ 89,00");
      expect(d.prompt).toContain("R$ 95,00");
      expect(d.prompt).toContain("sim");
    }
  });

  it("a TRUSTED price (no model provenance) EXECUTEs — the overlay keys on taint, not on the kind", async () => {
    const d = await run(
      priceEnvelope(VALID, { role: "OWNER", taint: "TRUSTED" }),
      priceWorld(),
    );
    expect(d.kind).toBe("EXECUTE");
  });
});

describe("product.price.set through the composed router — the pack's own fences", () => {
  it("non-admin session (LLM conversation, UNTRUSTED) → REFUSE by adminSessionOnlyGuard", async () => {
    const d = await run(
      priceEnvelope(VALID, {
        principal: "llm",
        sessionId: "web:conv-1",
        role: "",
        taint: "UNTRUSTED",
      }),
      priceWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.admin_session_required");
  });

  it("OWNER + invalid payload (unknown key) → REFUSE (price.payload_invalid)", async () => {
    const d = await run(
      priceEnvelope(
        { productId: "prod_1", priceCentavos: 9500, sneaky: 1 },
        { role: "OWNER" },
      ),
      priceWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.price.payload_invalid");
  });

  it("OWNER + missing productId → REFUSE (price.payload_invalid)", async () => {
    const d = await run(
      priceEnvelope({ priceCentavos: 9500 }, { role: "OWNER" }),
      priceWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.price.payload_invalid");
  });

  it("Hard Rule #2: a FLOAT priceCentavos → REFUSE (price.payload_invalid, integer only)", async () => {
    const d = await run(
      priceEnvelope({ productId: "prod_1", priceCentavos: 95.5 }, { role: "OWNER" }),
      priceWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.price.payload_invalid");
  });

  it("priceCentavos <= 0 → REFUSE (price.payload_invalid, structurally caught by validate)", async () => {
    const d = await run(
      priceEnvelope({ productId: "prod_1", priceCentavos: 0 }, { role: "OWNER" }),
      priceWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.price.payload_invalid");
  });

  it("OWNER + product-missing state → REFUSE (price.product_not_found)", async () => {
    const d = await run(priceEnvelope(VALID, { role: "OWNER" }), priceWorld(null));
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.price.product_not_found");
  });

  it("OWNER + differently-priced variants → REFUSE (price.per_variant_unsupported)", async () => {
    const d = await run(
      priceEnvelope(VALID, { role: "OWNER" }),
      priceWorld({
        id: "prod_1",
        status: "published",
        name: "Costela",
        currentPriceCentavos: 8900,
        divergentVariantPrices: true,
      }),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.price.per_variant_unsupported");
  });

  it("OWNER + absurd price (> R$100.000,00) → REFUSE (price.out_of_range)", async () => {
    const d = await run(
      priceEnvelope(
        { productId: "prod_1", priceCentavos: 10_000_001 },
        { role: "OWNER" },
      ),
      priceWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.price.out_of_range");
  });

  it("the sanity ceiling itself (exactly R$100.000,00) is allowed → CONFIRM (not out_of_range)", async () => {
    const d = await run(
      priceEnvelope(
        { productId: "prod_1", priceCentavos: 10_000_000 },
        { role: "OWNER" },
      ),
      priceWorld(),
    );
    expect(d.kind).toBe("REQUEST_CONFIRMATION");
  });
});
