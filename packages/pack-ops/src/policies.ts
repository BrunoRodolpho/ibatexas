/**
 * @ibatexas/pack-ops — PolicyBundle.
 *
 * Default polarity is REFUSE (governance principle #4 / Refusal-by-Design);
 * `product.availability.set` reaches EXECUTE only when every guard passes.
 *
 * Kernel evaluation order is fixed: `state → taint → auth → business`
 * (ADR-104). This bundle deliberately keeps the STATE phase empty and pushes
 * BOTH payload validation and product-existence into the BUSINESS phase so the
 * AUTH-phase gates fail-closed FIRST: a non-staff (or wrong-role) caller is
 * REFUSED by `adminSessionOnlyGuard` (here) / the adopter `staffRoleGuard`
 * (prepended by `buildIbatexasPolicyPacks`) BEFORE any payload/product detail
 * is even inspected — no ops-surface information leaks to an unauthorized
 * caller (SCN-125 spirit).
 *
 * ── Why this pack carries its own admin-session AUTH gate ────────────────────
 * The adopter `staffRoleGuard` engages ONLY on `admin:`-namespaced sessions
 * (its engagement predicate is `sessionId.startsWith("admin:")`); it is INERT
 * for customer / LLM / `agent:` / system envelopes. So the matrix alone does
 * NOT make the kind staff-only — a non-`admin:` envelope would sail past the
 * (inert) matrix guard into this pack's business phase. `adminSessionOnlyGuard`
 * closes that at the KERNEL: it REFUSEs any non-`admin:` session, making
 * `product.availability.set` staff-plane-only independent of any surface.
 */

import {
  basis,
  BASIS_CODES,
  decisionExecute,
  decisionRefuse,
} from "@adjudicate/core"
import {
  nameGuard,
  type Guard,
  type PolicyBundle,
} from "@adjudicate/core/kernel"
import {
  refuseAdminSessionRequired,
  refuseAlertResolveNotActionable,
  refuseAlertResolvePayloadInvalid,
  refuseAvailabilityPayloadInvalid,
  refuseAvailabilityProductNotFound,
  refuseIncidentCloseNotActionable,
  refuseIncidentClosePayloadInvalid,
} from "./refusals.js"
import {
  INCIDENT_CLOSE_STAFF_KEYS,
  isOpsEntityActionable,
  OPS_ALERT_RESOLVE_STAFF_KEYS,
  opsTaintPolicy,
  PRODUCT_AVAILABILITY_SET_KEYS,
  type IncidentCloseStaffPayload,
  type OpsAlertResolveStaffPayload,
  type OpsIntentKind,
  type OpsPayload,
  type OpsState,
  type ProductAvailabilitySetPayload,
} from "./types.js"

type OpsGuard = Guard<OpsIntentKind, OpsPayload, OpsState>

/** The staff-plane sessionId namespace this pack's kinds are fenced to. */
const ADMIN_SESSION_NAMESPACE = "admin:"

// ── Auth guards ─────────────────────────────────────────────────────────────

/**
 * REFUSE any ops envelope whose session is NOT `admin:`-namespaced. This is
 * the pack's fail-closed staff-plane fence — MANDATORY because the adopter
 * `staffRoleGuard` is inert for non-`admin:` sessions (see module header).
 * Role-opaque, security-framed refusal; machine reason rides the basis.
 */
const adminSessionOnlyGuard: OpsGuard = nameGuard(
  "opsAdminSessionOnly",
  (envelope) => {
    const { sessionId } = envelope.actor
    if (sessionId.startsWith(ADMIN_SESSION_NAMESPACE)) return null
    return decisionRefuse(
      refuseAdminSessionRequired(
        `ops kind "${envelope.kind}" requires an admin: session (non-staff session refused)`,
      ),
      [
        basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, {
          kind: envelope.kind,
          reason: "non_admin_session",
        }),
      ],
    )
  },
)

// ── Business guards ─────────────────────────────────────────────────────────

/**
 * Strict `product.availability.set` payload validation. REFUSEs anything that
 * is not EXACTLY `{ productId: <non-empty string>, available: <boolean>,
 * reason?: <string> }` — including unknown keys (a model that hallucinates an
 * extra field must not have it silently accepted).
 */
const validateAvailabilityPayload: OpsGuard = (envelope) => {
  if (envelope.kind !== "product.availability.set") return null
  const raw = envelope.payload as unknown as Record<string, unknown>

  // Reject unknown keys first — the contract is closed.
  for (const key of Object.keys(raw)) {
    if (!PRODUCT_AVAILABILITY_SET_KEYS.has(key)) {
      return decisionRefuse(
        refuseAvailabilityPayloadInvalid(`unknown payload key "${key}"`),
        [
          basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
            field: key,
            reason: "unknown_key",
          }),
        ],
      )
    }
  }

  if (typeof raw.productId !== "string" || raw.productId.length === 0) {
    return decisionRefuse(
      refuseAvailabilityPayloadInvalid("productId must be a non-empty string"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "productId",
          reason: "missing_or_empty",
        }),
      ],
    )
  }

  if (typeof raw.available !== "boolean") {
    return decisionRefuse(
      refuseAvailabilityPayloadInvalid("available must be a boolean"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "available",
          reason: "not_boolean",
        }),
      ],
    )
  }

  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    return decisionRefuse(
      refuseAvailabilityPayloadInvalid("reason must be a string when present"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "reason",
          reason: "not_string",
        }),
      ],
    )
  }

  return null
}

/**
 * REFUSE `product.availability.set` when the target product is absent from the
 * projected state (`state.product` null or unprojected). Fail-closed: a toggle
 * against an unknown product is refused, never a silent no-op. The later ops
 * resolver projects `state.product` from the products read-model.
 */
const requireProductExists: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "product.availability.set") return null
  const product = state.product
  if (product && typeof product.id === "string" && product.id.length > 0) {
    return null
  }
  const { productId } = envelope.payload as ProductAvailabilitySetPayload
  return decisionRefuse(
    refuseAvailabilityProductNotFound(`no product projected for id "${productId}"`),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "product_must_exist",
        productId,
        reason: "product_not_found",
      }),
    ],
  )
}

/**
 * EXECUTE producer for the happy path. Fires AFTER validation + existence
 * REFUSE the failing cases (kernel first-non-null semantics), and AFTER the
 * AUTH-phase admin-session + adopter role gates authorized the envelope.
 */
const executeAvailabilitySet: OpsGuard = (envelope) => {
  if (envelope.kind !== "product.availability.set") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

// ── BKL-088: shared closed-payload `{<idField>, reason?}` validator ──────────

/**
 * Validate a strict `{ <idField>: <non-empty string>, reason?: <string> }`
 * payload against `allowedKeys` (closed contract — unknown keys REFUSE).
 * Returns a `Refusal` on the first violation (the caller wraps it in the
 * per-kind refusal builder + basis), or `null` when the payload is well-formed.
 * SHARED by the alert-resolve + incident-close validators (identical shape).
 */
function idAndReasonPayloadViolation(
  raw: Record<string, unknown>,
  idField: string,
  allowedKeys: ReadonlySet<string>,
): { field: string; reason: string } | null {
  // Reject unknown keys first — the contract is closed.
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { field: key, reason: "unknown_key" }
    }
  }
  if (typeof raw[idField] !== "string" || (raw[idField] as string).length === 0) {
    return { field: idField, reason: "missing_or_empty" }
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    return { field: "reason", reason: "not_string" }
  }
  return null
}

// ── BKL-088: ops.alert.resolve.staff guards ─────────────────────────────────

/**
 * Strict `ops.alert.resolve.staff` payload validation. REFUSEs anything that is
 * not EXACTLY `{ alertId: <non-empty string>, reason?: <string> }` (unknown
 * keys rejected). `resolvedBy` / `resolutionType` are DELIBERATELY not payload
 * fields — the executor stamps them from the Capsule staffId (never the model).
 */
const validateAlertResolvePayload: OpsGuard = (envelope) => {
  if (envelope.kind !== "ops.alert.resolve.staff") return null
  const raw = envelope.payload as unknown as Record<string, unknown>
  const violation = idAndReasonPayloadViolation(
    raw,
    "alertId",
    OPS_ALERT_RESOLVE_STAFF_KEYS,
  )
  if (violation === null) return null
  return decisionRefuse(
    refuseAlertResolvePayloadInvalid(
      `alert-resolve payload ${violation.field}: ${violation.reason}`,
    ),
    [
      basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
        field: violation.field,
        reason: violation.reason,
      }),
    ],
  )
}

/**
 * REFUSE `ops.alert.resolve.staff` when the target alert is absent from the
 * projected state (`state.alert` null/unprojected) OR already terminal
 * (already resolved). Fail-closed: resolving an unknown or already-closed alert
 * is REFUSEd, never a silent no-op. The ops resolver projects `state.alert`
 * (`{id,status}`) from the OpsAlert read-model.
 */
const requireAlertActionable: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "ops.alert.resolve.staff") return null
  const { alertId } = envelope.payload as OpsAlertResolveStaffPayload
  const alert = state.alert
  if (!alert || typeof alert.id !== "string" || alert.id.length === 0) {
    return decisionRefuse(
      refuseAlertResolveNotActionable(`no alert projected for id "${alertId}"`),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "alert_must_be_actionable",
          alertId,
          reason: "not_found",
        }),
      ],
    )
  }
  if (!isOpsEntityActionable(alert.status)) {
    return decisionRefuse(
      refuseAlertResolveNotActionable(
        `alert "${alertId}" is terminal (status "${alert.status}")`,
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "alert_must_be_actionable",
          alertId,
          status: alert.status,
          reason: "already_resolved",
        }),
      ],
    )
  }
  return null
}

/** EXECUTE producer for `ops.alert.resolve.staff` (fires after validation +
 *  actionability REFUSE the failing cases, and after the AUTH gates authorized). */
const executeAlertResolve: OpsGuard = (envelope) => {
  if (envelope.kind !== "ops.alert.resolve.staff") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

// ── BKL-088: incident.ticket.close.staff guards ─────────────────────────────

/**
 * Strict `incident.ticket.close.staff` payload validation. REFUSEs anything
 * that is not EXACTLY `{ incidentId: <non-empty string>, reason?: <string> }`
 * (unknown keys rejected). `resolvedBy` / `resolutionType` are stamped by the
 * executor from the Capsule staffId (never the model).
 */
const validateIncidentClosePayload: OpsGuard = (envelope) => {
  if (envelope.kind !== "incident.ticket.close.staff") return null
  const raw = envelope.payload as unknown as Record<string, unknown>
  const violation = idAndReasonPayloadViolation(
    raw,
    "incidentId",
    INCIDENT_CLOSE_STAFF_KEYS,
  )
  if (violation === null) return null
  return decisionRefuse(
    refuseIncidentClosePayloadInvalid(
      `incident-close payload ${violation.field}: ${violation.reason}`,
    ),
    [
      basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
        field: violation.field,
        reason: violation.reason,
      }),
    ],
  )
}

/**
 * REFUSE `incident.ticket.close.staff` when the target incident is absent from
 * the projected state OR already terminal (already closed). Fail-closed. The
 * ops resolver projects `state.incident` (`{id,status}`) from the
 * ConversationIncident read-model.
 */
const requireIncidentActionable: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "incident.ticket.close.staff") return null
  const { incidentId } = envelope.payload as IncidentCloseStaffPayload
  const incident = state.incident
  if (!incident || typeof incident.id !== "string" || incident.id.length === 0) {
    return decisionRefuse(
      refuseIncidentCloseNotActionable(
        `no incident projected for id "${incidentId}"`,
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "incident_must_be_actionable",
          incidentId,
          reason: "not_found",
        }),
      ],
    )
  }
  if (!isOpsEntityActionable(incident.status)) {
    return decisionRefuse(
      refuseIncidentCloseNotActionable(
        `incident "${incidentId}" is terminal (status "${incident.status}")`,
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "incident_must_be_actionable",
          incidentId,
          status: incident.status,
          reason: "already_closed",
        }),
      ],
    )
  }
  return null
}

/** EXECUTE producer for `incident.ticket.close.staff`. */
const executeIncidentClose: OpsGuard = (envelope) => {
  if (envelope.kind !== "incident.ticket.close.staff") return null
  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
    }),
  ])
}

// ── PolicyBundle ────────────────────────────────────────────────────────────

/**
 * The ops-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel`. Default is REFUSE — any kind not covered by an
 * explicit EXECUTE producer is denied by construction.
 *
 * Guard ordering within business matters: each kind's `validate*` →
 * `require*` (both REFUSE producers) run BEFORE its `execute*` producer so a
 * malformed payload / missing-or-terminal entity REFUSEs rather than reaching
 * the EXECUTE producer. Each guard is a no-op (`null`) for the other kinds, so
 * the three kinds' guard triples are order-independent between kinds.
 */
export const opsPolicyBundle: PolicyBundle<OpsIntentKind, OpsPayload, OpsState> =
  {
    stateGuards: [],
    authGuards: [adminSessionOnlyGuard],
    taint: opsTaintPolicy,
    business: [
      validateAvailabilityPayload,
      requireProductExists,
      executeAvailabilitySet,
      // BKL-088 — ops.alert.resolve.staff
      validateAlertResolvePayload,
      requireAlertActionable,
      executeAlertResolve,
      // BKL-088 — incident.ticket.close.staff
      validateIncidentClosePayload,
      requireIncidentActionable,
      executeIncidentClose,
    ],
    default: "REFUSE",
  }
