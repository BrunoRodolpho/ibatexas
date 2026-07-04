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
  refuseAvailabilityPayloadInvalid,
  refuseAvailabilityProductNotFound,
} from "./refusals.js"
import {
  opsTaintPolicy,
  PRODUCT_AVAILABILITY_SET_KEYS,
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

// ── PolicyBundle ────────────────────────────────────────────────────────────

/**
 * The ops-domain PolicyBundle. Feed to `adjudicate()` from
 * `@adjudicate/core/kernel`. Default is REFUSE — any kind not covered by an
 * explicit EXECUTE producer is denied by construction.
 *
 * Guard ordering within business matters: `validateAvailabilityPayload` →
 * `requireProductExists` (both REFUSE producers) run BEFORE
 * `executeAvailabilitySet` so a malformed payload / missing product REFUSEs
 * rather than reaching the EXECUTE producer.
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
    ],
    default: "REFUSE",
  }
