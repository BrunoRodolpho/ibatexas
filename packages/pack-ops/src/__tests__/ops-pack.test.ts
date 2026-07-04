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

// ── BKL-088: ops.alert.resolve.staff + incident.ticket.close.staff raw-bundle ─

/** A resolution-verb envelope for an arbitrary owned kind (BKL-088). */
function resolveEnv(
  kind: "ops.alert.resolve.staff" | "incident.ticket.close.staff",
  payload: Record<string, unknown>,
  opts: { sessionId?: string; role?: string; principal?: "user" | "llm" } = {},
): IntentEnvelope<OpsIntentKind, OpsPayload> {
  const { sessionId = "admin:staff_1", role = "OWNER", principal = "user" } = opts
  return buildEnvelope({
    kind,
    payload: payload as unknown as OpsPayload,
    actor: { principal, sessionId, ...(role ? { role } : {}) },
    taint: "UNTRUSTED",
    nonce: `n-${kind}`,
    createdAt: DET_TIME,
  })
}

/** A state projecting the alert (or absent when null). */
function alertState(
  alert: OpsState["alert"] = { id: "alert_1", status: "OPEN" },
): OpsState {
  return { ctx: { channel: "staff", customerId: null, staffId: "staff_1" }, alert }
}
/** A state projecting the incident (or absent when null). */
function incidentState(
  incident: OpsState["incident"] = { id: "inc_1", status: "OPEN" },
): OpsState {
  return { ctx: { channel: "staff", customerId: null, staffId: "staff_1" }, incident }
}

describe("opsPolicyBundle — ops.alert.resolve.staff (BKL-088)", () => {
  it("EXECUTE: admin: + open alert + valid payload", () => {
    const d = adjudicate(
      resolveEnv("ops.alert.resolve.staff", { alertId: "alert_1", reason: "ok" }),
      alertState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })
  it("EXECUTE: without the optional reason", () => {
    const d = adjudicate(
      resolveEnv("ops.alert.resolve.staff", { alertId: "alert_1" }),
      alertState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })
  it("REFUSE (AUTH): non-admin session — the pack fail-closes without staffRoleGuard", () => {
    const d = adjudicate(
      resolveEnv("ops.alert.resolve.staff", { alertId: "alert_1" }, {
        principal: "llm",
        sessionId: "web:c1",
        role: "",
      }),
      alertState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.admin_session_required")
  })
  it("REFUSE: missing alertId (payload_invalid)", () => {
    const d = adjudicate(
      resolveEnv("ops.alert.resolve.staff", { reason: "x" }),
      alertState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.alert_resolve.payload_invalid")
  })
  it("REFUSE: unknown key (closed contract)", () => {
    const d = adjudicate(
      resolveEnv("ops.alert.resolve.staff", { alertId: "alert_1", sneaky: 1 }),
      alertState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.alert_resolve.payload_invalid")
  })
  it("REFUSE: absent alert (not_actionable / not_found)", () => {
    const d = adjudicate(
      resolveEnv("ops.alert.resolve.staff", { alertId: "alert_1" }),
      alertState(null),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.alert_resolve.not_actionable")
  })
  it("REFUSE: terminal alert (not_actionable / already_resolved)", () => {
    const d = adjudicate(
      resolveEnv("ops.alert.resolve.staff", { alertId: "alert_1" }),
      alertState({ id: "alert_1", status: "RESOLVED" }),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.alert_resolve.not_actionable")
  })
})

describe("opsPolicyBundle — incident.ticket.close.staff (BKL-088)", () => {
  it("EXECUTE: admin: + open incident + valid payload", () => {
    const d = adjudicate(
      resolveEnv("incident.ticket.close.staff", { incidentId: "inc_1" }),
      incidentState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("EXECUTE")
  })
  it("REFUSE: missing incidentId (payload_invalid)", () => {
    const d = adjudicate(
      resolveEnv("incident.ticket.close.staff", {}),
      incidentState(),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.incident_close.payload_invalid")
  })
  it("REFUSE: absent incident (not_actionable)", () => {
    const d = adjudicate(
      resolveEnv("incident.ticket.close.staff", { incidentId: "inc_1" }),
      incidentState(null),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.incident_close.not_actionable")
  })
  it("REFUSE: terminal incident (not_actionable)", () => {
    const d = adjudicate(
      resolveEnv("incident.ticket.close.staff", { incidentId: "inc_1" }),
      incidentState({ id: "inc_1", status: "AUTO_RESOLVED" }),
      opsPolicyBundle,
    )
    expect(d.kind).toBe("REFUSE")
    if (d.kind === "REFUSE") expect(d.refusal.code).toBe("ops.incident_close.not_actionable")
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

  it("the ONLY coherence errors are the intentional foreign advertisements (order.note.add + order.status.transition + payment.refund.issue)", () => {
    // `analyzePolicy`'s AJD-301 flags any advertised kind not in `pack.intents`
    // as `phantom_intent` (error). The ops plane INTENTIONALLY advertises the
    // foreign-owned `order.note.add` + `order.status.transition` (owned by
    // pack-orders) AND `payment.refund.issue` (BKL-085, owned by pack-payments) to
    // widen the ops allowlist — composition routes them to the owning pack
    // (indexByKind keys on OWNERSHIP, not advertisement). So exactly THREE
    // phantom_intent rows are expected and correct; partition them out and assert
    // NO OTHER errors slipped in (still catches a real coherence regression).
    const EXPECTED_FOREIGN = new Set([
      "order.note.add",
      "order.status.transition",
      "payment.refund.issue",
    ])
    const report = analyzePolicy({ pack: opsPack, plannerProbes: probes })
    const isExpectedForeignAdvert = (d: (typeof report.diagnostics)[number]) =>
      d.severity === "error" &&
      d.detail?.rule === "phantom_intent" &&
      typeof d.detail?.intent === "string" &&
      EXPECTED_FOREIGN.has(d.detail.intent as string)
    const unexpectedErrors = report.diagnostics.filter(
      (d) => d.severity === "error" && !isExpectedForeignAdvert(d),
    )
    for (const d of unexpectedErrors) console.error(`[${d.code}] ${d.message}`)
    expect(unexpectedErrors).toEqual([])
    // Non-vacuous: ALL intentional foreign advertisements ARE reported (proves
    // the partition above is not silently passing a report with zero phantom rows).
    const reportedForeign = new Set(
      report.diagnostics
        .filter((d) => d.severity === "error" && d.detail?.rule === "phantom_intent")
        .map((d) => d.detail?.intent),
    )
    expect(reportedForeign.has("order.note.add")).toBe(true)
    expect(reportedForeign.has("order.status.transition")).toBe(true)
    expect(reportedForeign.has("payment.refund.issue")).toBe(true)
  })

  it("all six ops verbs are reachable (advertised under the staff probe)", () => {
    // Non-vacuous: a probe with a staff session must advertise all six — the
    // three OWNED verbs (`product.availability.set` + the BKL-088
    // `ops.alert.resolve.staff` / `incident.ticket.close.staff`) AND the three
    // foreign-routed (`order.note.add` + `order.status.transition` +
    // `payment.refund.issue`).
    const staffPlan = opsPack.planner.plan(probes[1]!.state, probes[1]!.context)
    expect(staffPlan.allowedIntents).toContain("product.availability.set")
    expect(staffPlan.allowedIntents).toContain("ops.alert.resolve.staff")
    expect(staffPlan.allowedIntents).toContain("incident.ticket.close.staff")
    expect(staffPlan.allowedIntents).toContain("order.note.add")
    expect(staffPlan.allowedIntents).toContain("order.status.transition")
    expect(staffPlan.allowedIntents).toContain("payment.refund.issue")
    const guestPlan = opsPack.planner.plan(probes[0]!.state, probes[0]!.context)
    expect(guestPlan.allowedIntents).toEqual([])
  })

  it("the READ tools (ops_snapshot + ops_sales_analytics) are advertised ONLY to a staff session (NEW-032 / NEW-012)", () => {
    const staffPlan = opsPack.planner.plan(probes[1]!.state, probes[1]!.context)
    expect(staffPlan.visibleReadTools).toContain("ops_snapshot")
    expect(staffPlan.visibleReadTools).toContain("ops_sales_analytics")
    const guestPlan = opsPack.planner.plan(probes[0]!.state, probes[0]!.context)
    expect(guestPlan.visibleReadTools).toEqual([])
  })
})
