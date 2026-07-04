/**
 * @ibatexas/pack-ops — pack unit + conformance tests.
 *
 * Three parts:
 *   1. Per-guard decisions against the RAW `opsPolicyBundle` (the pack's own
 *      authority — `adminSessionOnlyGuard` + strict payload validation +
 *      product-existence + EXECUTE). The adopter `staffRoleGuard` + matrix are
 *      NOT in the raw bundle; the role gate is proven through the COMPOSED
 *      router in `apps/api/src/ops/__tests__/pack-ops-availability.test.ts`.
 *   2. Kernel-invariant suite via `runConformance(opsPack)` (taint protection,
 *      replay determinism, basis-vocabulary purity, guard ordering, default
 *      polarity).
 *   3. Policy coherence via `analyzePolicy()` — the planner advertises only a
 *      declared intent (no phantom) and only on a staff session.
 */

import { describe, expect, it } from "vitest"
import { adjudicate } from "@adjudicate/core/kernel"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import { runConformance } from "@adjudicate/conformance"
import { analyzePolicy, type PlannerProbe } from "@adjudicate/analyze"
import {
  opsPack,
  opsPolicyBundle,
  type OpsContext,
  type OpsIntentKind,
  type OpsPayload,
  type OpsState,
} from "../index.js"

const DET_TIME = "2026-07-04T12:00:00.000Z"

function env(
  payload: Record<string, unknown>,
  opts: {
    taint?: "SYSTEM" | "TRUSTED" | "UNTRUSTED"
    principal?: "user" | "llm" | "system"
    sessionId?: string
    role?: string
  } = {},
): IntentEnvelope<OpsIntentKind, OpsPayload> {
  const {
    taint = "TRUSTED",
    principal = "user",
    sessionId = "admin:staff_1",
    role = "OWNER",
  } = opts
  return buildEnvelope({
    kind: "product.availability.set",
    payload: payload as unknown as OpsPayload,
    actor: { principal, sessionId, ...(role ? { role } : {}) },
    taint,
    nonce: "n-ops-test",
    createdAt: DET_TIME,
  })
}

/** A state with the target product present (or absent when `product: null`). */
function opsState(
  product: OpsState["product"] = { id: "prod_1", status: "published" },
  ctxOver: Partial<OpsState["ctx"]> = {},
): OpsState {
  return {
    ctx: {
      channel: "staff",
      customerId: null,
      staffId: "staff_1",
      ...ctxOver,
    },
    product,
  }
}

const VALID = { productId: "prod_1", available: false, reason: "sem estoque" }

// ── Raw-bundle guard decisions ──────────────────────────────────────────────

describe("opsPolicyBundle — admin-session fence (AUTH)", () => {
  it("EXECUTE: admin: session + valid payload + product present", () => {
    const d = adjudicate(env(VALID), opsState(), opsPolicyBundle)
    expect(d.kind).toBe("EXECUTE")
  })

  it("REFUSE: a non-admin (LLM conversation) session — pack fail-closes without staffRoleGuard", () => {
    const d = adjudicate(
      env(VALID, { principal: "llm", sessionId: "web:conv-1", role: "" }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") {
      expect(d.refusal.code).toBe("ops.admin_session_required")
      expect(d.refusal.kind).toBe("AUTH")
    }
  })

  it("REFUSE: a customer web session (no admin: prefix)", () => {
    const d = adjudicate(
      env(VALID, { principal: "user", sessionId: "s-customer", role: "" }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") {
      expect(d.refusal.code).toBe("ops.admin_session_required")
    }
  })
})

describe("opsPolicyBundle — strict payload validation (BUSINESS)", () => {
  it("REFUSE: missing productId", () => {
    const d = adjudicate(
      env({ available: true }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.payload_invalid")
  })

  it("REFUSE: empty productId", () => {
    const d = adjudicate(
      env({ productId: "", available: true }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
  })

  it("REFUSE: available not a boolean", () => {
    const d = adjudicate(
      env({ productId: "prod_1", available: "yes" }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.payload_invalid")
  })

  it("REFUSE: reason present but not a string", () => {
    const d = adjudicate(
      env({ productId: "prod_1", available: true, reason: 42 }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
  })

  it("REFUSE: an unknown key (closed contract)", () => {
    const d = adjudicate(
      env({ productId: "prod_1", available: true, sneaky: "x" }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.payload_invalid")
  })

  it("EXECUTE: valid payload WITHOUT the optional reason", () => {
    const d = adjudicate(
      env({ productId: "prod_1", available: true }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })
})

describe("opsPolicyBundle — product existence (BUSINESS)", () => {
  it("REFUSE: product-missing state (product: null)", () => {
    const d = adjudicate(env(VALID), opsState(null), opsPolicyBundle)
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.product_not_found")
  })

  it("REFUSE: product unprojected (no product key on state)", () => {
    const stateNoProduct: OpsState = {
      ctx: { channel: "staff", customerId: null, staffId: "staff_1" },
    }
    const d = adjudicate(env(VALID), stateNoProduct, opsPolicyBundle)
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE")
      expect(d.refusal.code).toBe("ops.availability.product_not_found")
  })
})

describe("opsPolicyBundle — taint floor is UNTRUSTED (authority is namespace+role)", () => {
  it("EXECUTE: UNTRUSTED taint on a valid admin: envelope still executes", () => {
    const d = adjudicate(
      env(VALID, { taint: "UNTRUSTED" }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })

  it("EXECUTE: TRUSTED taint (a staff JWT stamp) also clears the floor", () => {
    const d = adjudicate(
      env(VALID, { taint: "TRUSTED" }),
      opsState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })
})

describe("opsPolicyBundle — structure", () => {
  it("default polarity is REFUSE (Refusal-by-Design)", () => {
    expect(opsPolicyBundle.default).toBe("REFUSE")
  })
})

// ── Kernel-invariant suite ──────────────────────────────────────────────────

describe("opsPack — kernel invariants via runConformance()", () => {
  it("runConformance returns zero failures", () => {
    const report = runConformance(opsPack)
    if (!report.passed) {
      for (const r of report.results) {
        if (!r.passed) console.error(`[${r.id}] ${r.name}: ${r.details}`)
      }
    }
    expect(report.passed).toBe(true)
    expect(report.summary.failed).toBe(0)
  })
})

// ── Policy coherence via analyzePolicy() (AJD-301 / F11) ─────────────────────

describe("opsPack — policy coherence via analyzePolicy()", () => {
  const probes: ReadonlyArray<PlannerProbe<OpsState, OpsContext>> = [
    {
      label: "guest-web",
      state: opsState(null, { channel: "web", customerId: null, staffId: null }),
      context: { channel: "web", customerId: null, staffId: null },
    },
    {
      label: "staff",
      state: opsState(null, { channel: "staff", staffId: "staff_1" }),
      context: { channel: "staff", customerId: null, staffId: "staff_1" },
    },
  ]

  it("planner proposes no phantom intents (report.passed, zero errors)", () => {
    const report = analyzePolicy({ pack: opsPack, plannerProbes: probes })
    for (const d of report.diagnostics) {
      if (d.severity === "error") console.error(`[${d.code}] ${d.message}`)
    }
    expect(report.passed).toBe(true)
    expect(report.summary.error).toBe(0)
  })

  it("the ops verb is reachable (advertised under the staff probe)", () => {
    // Non-vacuous: a probe with a staff session must actually advertise it.
    const staffPlan = opsPack.planner.plan(probes[1]!.state, probes[1]!.context)
    expect(staffPlan.allowedIntents).toContain("product.availability.set")
    const guestPlan = opsPack.planner.plan(probes[0]!.state, probes[0]!.context)
    expect(guestPlan.allowedIntents).toEqual([])
  })
})
