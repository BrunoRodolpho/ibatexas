// pack-ops-availability — NEW-032 slice C1: product.availability.set adjudicated
// THROUGH THE REAL COMPOSED policy router.
//
// Exercises the exact composition claustrum-bootstrap feeds policyForKind
// (buildIbatexasPolicyPacks over IBATEXAS_COMPOSED_PACKS — now including
// opsPack) + the REAL kernel adjudicate. This proves the full authority stack
// on the ops verb:
//   - the adopter staffRoleGuard + the staff-role matrix (OWNER/MANAGER EXECUTE,
//     ATTENDANT / absent-role REFUSE) — the AUTH-phase role gate;
//   - the ops pack's OWN adminSessionOnlyGuard (a non-admin session REFUSEs even
//     though staffRoleGuard is inert there — the pack fail-closes on its own);
//   - the pack's strict payload validation + product existence + UNTRUSTED
//     taint floor.
//
// Mirrors run-staff-ops-intent.test.ts (the proven composed-router pattern).

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

/** The composed bundle that owns `product.availability.set` (with the prepended adopter guards). */
function opsBundle(): PolicyBundle<string, unknown, unknown> {
  const bundle = resolveCapabilityPolicy(
    IBATEXAS_POLICY_PACKS as unknown as ReadonlyArray<CapabilityPolicyPack>,
    "product.availability.set",
  );
  if (!bundle) throw new Error("no composed pack owns product.availability.set");
  return bundle;
}

const DET_TIME = "2026-07-04T12:00:00.000Z";

/** The staffRoleGuard uses ONE code (staff_role_violation); the distinct case rides basis.meta.reason. */
const basisMentions = (decision: Decision, reason: string): boolean =>
  JSON.stringify((decision as { basis?: unknown }).basis ?? []).includes(reason);

function opsEnvelope(
  payload: Record<string, unknown>,
  opts: {
    sessionId?: string;
    role?: string;
    principal?: "user" | "llm";
    taint?: "SYSTEM" | "TRUSTED" | "UNTRUSTED";
  } = {},
): IntentEnvelope {
  const {
    sessionId = "admin:staff_1",
    role = "OWNER",
    principal = "user",
    taint = "TRUSTED",
  } = opts;
  return buildEnvelope({
    kind: "product.availability.set",
    payload,
    actor: { principal, sessionId, ...(role ? { role } : {}) },
    taint,
    nonce: `n-${role || "none"}-${sessionId}`,
    createdAt: DET_TIME,
  }) as IntentEnvelope;
}

/** A broad ctx superset + a present product so the ops pack's guards read real state. */
function opsWorld(product: { id: string; status: string } | null = { id: "prod_1", status: "published" }): unknown {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: "staff_1",
      tenantId: "ibatexas",
    },
    product,
  };
}

const VALID = { productId: "prod_1", available: false, reason: "sem estoque" };

const run = async (
  envelope: IntentEnvelope,
  state: unknown,
): Promise<Decision> => adjudicate(envelope, state as never, opsBundle());

describe("product.availability.set through the composed router — role matrix (NEW-032)", () => {
  it("OWNER + valid payload + product present → EXECUTE", async () => {
    const d = await run(opsEnvelope(VALID, { role: "OWNER" }), opsWorld());
    expect(d.kind).toBe("EXECUTE");
  });

  it("MANAGER → EXECUTE", async () => {
    const d = await run(opsEnvelope(VALID, { role: "MANAGER" }), opsWorld());
    expect(d.kind).toBe("EXECUTE");
  });

  it("ATTENDANT → REFUSE (staff_role_violation / staff_role_not_permitted)", async () => {
    const d = await run(opsEnvelope(VALID, { role: "ATTENDANT" }), opsWorld());
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("staff_role_violation");
    expect(basisMentions(d, "staff_role_not_permitted")).toBe(true);
  });

  it("absent role → REFUSE (staff_role_absent, fail-closed)", async () => {
    const d = await run(opsEnvelope(VALID, { role: "" }), opsWorld());
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("staff_role_violation");
    expect(basisMentions(d, "staff_role_absent")).toBe(true);
  });
});

describe("product.availability.set through the composed router — the pack's own fences", () => {
  it("non-admin session (LLM conversation, UNTRUSTED) → REFUSE by adminSessionOnlyGuard", async () => {
    // staffRoleGuard is INERT for a non-admin: session — the ops pack's own
    // adminSessionOnlyGuard is what fail-closes here.
    const d = await run(
      opsEnvelope(VALID, {
        principal: "llm",
        sessionId: "web:conv-1",
        role: "",
        taint: "UNTRUSTED",
      }),
      opsWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.admin_session_required");
  });

  it("OWNER + invalid payload (unknown key) → REFUSE (payload_invalid)", async () => {
    const d = await run(
      opsEnvelope({ productId: "prod_1", available: true, sneaky: 1 }, { role: "OWNER" }),
      opsWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.payload_invalid");
  });

  it("OWNER + missing productId → REFUSE (payload_invalid)", async () => {
    const d = await run(
      opsEnvelope({ available: true }, { role: "OWNER" }),
      opsWorld(),
    );
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.payload_invalid");
  });

  it("OWNER + product-missing state → REFUSE (product_not_found)", async () => {
    const d = await run(opsEnvelope(VALID, { role: "OWNER" }), opsWorld(null));
    expect(d.kind).toBe("REFUSE");
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.product_not_found");
  });

  it("UNTRUSTED taint on a valid admin:+OWNER envelope → still EXECUTE (taint floor accepts UNTRUSTED)", async () => {
    const d = await run(
      opsEnvelope(VALID, { role: "OWNER", taint: "UNTRUSTED" }),
      opsWorld(),
    );
    expect(d.kind).toBe("EXECUTE");
  });
});
