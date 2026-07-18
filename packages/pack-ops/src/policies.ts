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
  decisionRequestConfirmation,
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
  refuseMenuSpecialDatePast,
  refuseMenuSpecialPayloadInvalid,
  refuseMenuSpecialProductNotFound,
  refusePriceOutOfRange,
  refusePricePayloadInvalid,
  refusePricePerVariantUnsupported,
  refusePriceProductNotFound,
  refuseScheduleOverrideDateNotActionable,
  refuseScheduleOverridePayloadInvalid,
} from "./refusals.js"
import {
  getPriceSanityMaxCentavos,
  INCIDENT_CLOSE_STAFF_KEYS,
  isOpsEntityActionable,
  MENU_SPECIAL_SET_KEYS,
  OPS_ALERT_RESOLVE_STAFF_KEYS,
  opsTaintPolicy,
  PRODUCT_AVAILABILITY_SET_KEYS,
  PRODUCT_PRICE_SET_KEYS,
  SCHEDULE_OVERRIDE_SET_KEYS,
  type IncidentCloseStaffPayload,
  type MenuSpecialSetPayload,
  type OpsAlertResolveStaffPayload,
  type OpsIntentKind,
  type OpsPayload,
  type OpsState,
  type ProductAvailabilitySetPayload,
  type ProductPriceSetPayload,
  type ScheduleOverrideSetPayload,
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

  // BKL-156 — `productName` is a resolver-stamped display-only field; admitted
  // (see PRODUCT_AVAILABILITY_SET_KEYS) but only validated as an optional string.
  if (raw.productName !== undefined && typeof raw.productName !== "string") {
    return decisionRefuse(
      refuseAvailabilityPayloadInvalid("productName must be a string when present"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "productName",
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

// ── NEW-004: product.price.set guards ────────────────────────────────────────

/** Format an integer centavos amount as pt-BR BRL ("9500" → "95,00"). Mirrors
 *  the refund CONFIRM prompt's formatting (no thousands separator). */
function formatBrlCentavos(centavos: number): string {
  return (centavos / 100).toFixed(2).replace(".", ",")
}

/**
 * Strict `product.price.set` payload validation. REFUSEs anything that is not
 * EXACTLY `{ productId: <non-empty string>, priceCentavos: <integer > 0>,
 * reason?: <string> }` — unknown keys rejected (closed contract). Hard Rule #2:
 * `priceCentavos` MUST be a positive INTEGER (centavos on the wire, never a
 * float/reais); this REFUSE also covers the `<= 0` sanity case structurally.
 */
const validatePricePayload: OpsGuard = (envelope) => {
  if (envelope.kind !== "product.price.set") return null
  const raw = envelope.payload as unknown as Record<string, unknown>

  // Reject unknown keys first — the contract is closed.
  for (const key of Object.keys(raw)) {
    if (!PRODUCT_PRICE_SET_KEYS.has(key)) {
      return decisionRefuse(
        refusePricePayloadInvalid(`unknown payload key "${key}"`),
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
      refusePricePayloadInvalid("productId must be a non-empty string"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "productId",
          reason: "missing_or_empty",
        }),
      ],
    )
  }

  if (
    typeof raw.priceCentavos !== "number" ||
    !Number.isInteger(raw.priceCentavos) ||
    raw.priceCentavos <= 0
  ) {
    return decisionRefuse(
      refusePricePayloadInvalid("priceCentavos must be a positive integer"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "priceCentavos",
          reason: "not_positive_integer",
        }),
      ],
    )
  }

  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    return decisionRefuse(
      refusePricePayloadInvalid("reason must be a string when present"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "reason",
          reason: "not_string",
        }),
      ],
    )
  }

  // BKL-156 — resolver-stamped display-only field; validated as optional string.
  if (raw.productName !== undefined && typeof raw.productName !== "string") {
    return decisionRefuse(
      refusePricePayloadInvalid("productName must be a string when present"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "productName",
          reason: "not_string",
        }),
      ],
    )
  }

  return null
}

/**
 * REFUSE `product.price.set` when the target product is absent from the
 * projected state (`state.priceProduct` null/unprojected). Fail-closed: a price
 * change against an unknown (or NO-BRL-priced) product is REFUSEd, never a
 * silent no-op. The ops resolver projects `state.priceProduct` from the admin
 * catalog read.
 */
const requirePriceProductExists: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "product.price.set") return null
  const product = state.priceProduct
  if (product && typeof product.id === "string" && product.id.length > 0) {
    return null
  }
  const { productId } = envelope.payload as ProductPriceSetPayload
  return decisionRefuse(
    refusePriceProductNotFound(`no product projected for id "${productId}"`),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "price_product_must_exist",
        productId,
        reason: "product_not_found",
      }),
    ],
  )
}

/**
 * REFUSE `product.price.set` when the target product has MULTIPLE
 * differently-priced BRL variants (per-variation pricing). v1 sets ONE uniform
 * price across all a product's variants; it cannot disambiguate which variation
 * "muda o preço da costela pra 95" means when 500g ≠ 1kg, so it REFUSEs
 * honestly. Uniform-price products (single variant OR every variant the same
 * BRL price) pass. Fires AFTER `requirePriceProductExists` (needs a projected
 * product).
 */
const requireUniformVariantPricing: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "product.price.set") return null
  const product = state.priceProduct
  if (!product || product.divergentVariantPrices !== true) return null
  const { productId } = envelope.payload as ProductPriceSetPayload
  return decisionRefuse(
    refusePricePerVariantUnsupported(
      `product "${productId}" has differently-priced variants`,
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "price_variants_must_be_uniform",
        productId,
        reason: "per_variant_pricing_unsupported",
      }),
    ],
  )
}

/**
 * Sanity REFUSE for an absurd parsed price (above `getPriceSanityMaxCentavos()`,
 * default R$100.000,00). A defensive cap against a gross misparse. `<= 0` is
 * already REFUSEd by `validatePricePayload` (integer > 0), so this guards the
 * upper bound only. Fires AFTER existence/uniformity so a real, uniform product
 * with a nonsensical amount REFUSEs here rather than parking a CONFIRM.
 */
const sanityRefuseAbsurdPrice: OpsGuard = (envelope) => {
  if (envelope.kind !== "product.price.set") return null
  const { priceCentavos, productId } = envelope.payload as ProductPriceSetPayload
  const max = getPriceSanityMaxCentavos()
  if (priceCentavos <= max) return null
  return decisionRefuse(
    refusePriceOutOfRange(
      `price ${priceCentavos} centavos exceeds sanity max ${max}`,
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "price_within_sanity_bound",
        productId,
        priceCentavos,
        max,
        reason: "price_out_of_range",
      }),
    ],
  )
}

/**
 * The terminal decision producer for `product.price.set` (fires AFTER every
 * REFUSE guard above passed, and AFTER the AUTH-phase admin-session + adopter
 * role gates authorized).
 *
 * ── NEW-004 UNTRUSTED-taint CONFIRM overlay (the PR #172 refund shape) ────────
 * A model-PARSED price (`taint === "UNTRUSTED"` — the ops persona extracted the
 * number from the owner's message) ALWAYS REQUEST_CONFIRMATIONs: a misparse
 * ("noventa e cinco" → 9500 vs 95, or the wrong product) would send a REAL price
 * live. The prompt states the product NAME + the old→new BRL so the staff
 * confirms the NUMBERS, not just the intent. There is NO ESCALATE band (price is
 * reversible; the sanity REFUSE above already capped absurd values). A
 * TRUSTED/SYSTEM path (none exists for this kind yet) EXECUTEs directly — the
 * overlay keys on `taint`, so a future trusted caller is untouched.
 */
const decidePriceSet: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "product.price.set") return null
  const payload = envelope.payload as ProductPriceSetPayload

  if (envelope.taint === "UNTRUSTED") {
    const product = state.priceProduct
    const newBrl = formatBrlCentavos(payload.priceCentavos)
    // `product` is guaranteed present here (requirePriceProductExists ran); the
    // old→new phrasing is used when the snapshot carries a current price.
    const prompt =
      product && typeof product.currentPriceCentavos === "number"
        ? `Confirmar alteração de preço de ${product.name}: de R$ ${formatBrlCentavos(
            product.currentPriceCentavos,
          )} para R$ ${newBrl}? Responda "sim" para confirmar.`
        : `Confirmar novo preço de R$ ${newBrl}${
            product ? ` para ${product.name}` : ""
          }? Responda "sim" para confirmar.`
    return decisionRequestConfirmation(prompt, [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "price_untrusted_requires_confirmation",
        priceCentavos: payload.priceCentavos,
        taint: envelope.taint,
      }),
    ])
  }

  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
      priceCentavos: payload.priceCentavos,
    }),
  ])
}

// ── SCN-114: menu.special.set guards ─────────────────────────────────────────

/** Format a concrete `YYYY-MM-DD` business-day as pt-BR `DD/MM/AAAA` for the
 *  CONFIRM prompt. Pure string surgery (no Date parsing / no tz shift). */
function formatYmdBr(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd
}

/**
 * Strict `menu.special.set` payload validation (SCN-114). REFUSEs anything that
 * is not EXACTLY `{ productId: <non-empty string>, date: <YYYY-MM-DD>,
 * promoPriceCentavos?: <integer > 0> }` — unknown keys rejected (closed
 * contract). `date` MUST already be a concrete `YYYY-MM-DD` (the resolver
 * resolves "hoje"/"amanhã" → concrete BEFORE adjudication); a still-relative /
 * garbage date fails the format check here. `promoPriceCentavos`, when present,
 * MUST be a positive INTEGER (Hard Rule #2 — centavos, never a float/reais); when
 * ABSENT the special is featured without a discount.
 */
const validateMenuSpecialPayload: OpsGuard = (envelope) => {
  if (envelope.kind !== "menu.special.set") return null
  const raw = envelope.payload as unknown as Record<string, unknown>

  // Reject unknown keys first — the contract is closed.
  for (const key of Object.keys(raw)) {
    if (!MENU_SPECIAL_SET_KEYS.has(key)) {
      return decisionRefuse(
        refuseMenuSpecialPayloadInvalid(`unknown payload key "${key}"`),
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
      refuseMenuSpecialPayloadInvalid("productId must be a non-empty string"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "productId",
          reason: "missing_or_empty",
        }),
      ],
    )
  }

  if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
    return decisionRefuse(
      refuseMenuSpecialPayloadInvalid("date must be a concrete YYYY-MM-DD"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "date",
          reason: "not_ymd",
        }),
      ],
    )
  }

  if (
    raw.promoPriceCentavos !== undefined &&
    (typeof raw.promoPriceCentavos !== "number" ||
      !Number.isInteger(raw.promoPriceCentavos) ||
      raw.promoPriceCentavos <= 0)
  ) {
    return decisionRefuse(
      refuseMenuSpecialPayloadInvalid(
        "promoPriceCentavos must be a positive integer when present",
      ),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "promoPriceCentavos",
          reason: "not_positive_integer",
        }),
      ],
    )
  }

  // BKL-156 — resolver-stamped display-only field; validated as optional string.
  if (raw.productName !== undefined && typeof raw.productName !== "string") {
    return decisionRefuse(
      refuseMenuSpecialPayloadInvalid("productName must be a string when present"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "productName",
          reason: "not_string",
        }),
      ],
    )
  }

  return null
}

/**
 * REFUSE `menu.special.set` when the resolved business-day is in the PAST
 * (`payload.date < state.special.todayYmd`). The resolver projects `todayYmd`
 * (today in RESTAURANT_TIMEZONE) so this decision is a pure, auditable function
 * of the captured state — the leaf reads no clock. A no-op when the special state
 * / todayYmd was not projected (the existence guard fails closed instead).
 */
const requireSpecialDateNotPast: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "menu.special.set") return null
  const todayYmd = state.special?.todayYmd
  if (typeof todayYmd !== "string" || todayYmd.length === 0) return null
  const { date } = envelope.payload as MenuSpecialSetPayload
  if (date >= todayYmd) return null
  return decisionRefuse(
    refuseMenuSpecialDatePast(
      `special date "${date}" is before today "${todayYmd}"`,
    ),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "special_date_not_past",
        date,
        todayYmd,
        reason: "date_past",
      }),
    ],
  )
}

/**
 * REFUSE `menu.special.set` when the target product is absent from the projected
 * state (`state.special.product` null/unprojected). Fail-closed — a special
 * against an unknown product is REFUSEd, never a silent no-op. The ops resolver
 * projects `state.special.product` from the admin catalog read (name→id resolved).
 */
const requireSpecialProductExists: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "menu.special.set") return null
  const product = state.special?.product
  if (product && typeof product.id === "string" && product.id.length > 0) {
    return null
  }
  const { productId } = envelope.payload as MenuSpecialSetPayload
  return decisionRefuse(
    refuseMenuSpecialProductNotFound(`no product projected for id "${productId}"`),
    [
      basis("business", BASIS_CODES.business.RULE_VIOLATED, {
        rule: "special_product_must_exist",
        productId,
        reason: "product_not_found",
      }),
    ],
  )
}

/**
 * The terminal decision producer for `menu.special.set` (fires AFTER every
 * REFUSE guard above passed, and AFTER the AUTH-phase admin-session + role gates
 * authorized). Mirrors `decidePriceSet` (NEW-004): a model-PARSED payload
 * (`taint === "UNTRUSTED"` — the ops persona extracted the product/date/price
 * from the owner's message) ALWAYS REQUEST_CONFIRMATIONs, because a misparse
 * would set the wrong special (or the wrong promo price) live. The prompt states
 * the product NAME + the business-day + the parsed R$ (or "sem desconto") so the
 * staff confirms the SPECIFICS. A TRUSTED/SYSTEM path (none exists yet) EXECUTEs
 * directly — the overlay keys on `taint`.
 */
const decideMenuSpecialSet: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "menu.special.set") return null
  const payload = envelope.payload as MenuSpecialSetPayload

  if (envelope.taint === "UNTRUSTED") {
    const name = state.special?.product?.name ?? "o produto"
    const when = formatYmdBr(payload.date)
    const pricePart =
      typeof payload.promoPriceCentavos === "number"
        ? `por R$ ${formatBrlCentavos(payload.promoPriceCentavos)}`
        : "(sem desconto)"
    const prompt = `Confirmar especial de ${when}: ${name} ${pricePart}? Responda "sim" para confirmar.`
    return decisionRequestConfirmation(prompt, [
      basis("business", BASIS_CODES.business.RULE_SATISFIED, {
        reason: "menu_special_untrusted_requires_confirmation",
        date: payload.date,
        ...(typeof payload.promoPriceCentavos === "number"
          ? { promoPriceCentavos: payload.promoPriceCentavos }
          : {}),
        taint: envelope.taint,
      }),
    ])
  }

  return decisionExecute([
    basis("business", BASIS_CODES.business.RULE_SATISFIED, {
      kind: envelope.kind,
      date: payload.date,
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

// ── SCN-127: schedule.override.set guards ────────────────────────────────────

/** Well-formed AND real `YYYY-MM-DD` calendar date (rejects "2026-13-40"). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 24h `HH:MM` wall-clock (00:00–23:59). */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false
  // Round-trip through UTC noon so an impossible date fails to reproduce itself.
  const d = new Date(`${s}T12:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/**
 * Validate ONE `blocks[]` entry against the closed `{ label, start, end }`
 * contract: unknown keys rejected, non-empty `label`, `HH:MM` `start`/`end`, and
 * `start < end` (a zero/negative window is incoherent). Returns the offending
 * `{ field, reason }` or `null` when the block is well-formed.
 */
function scheduleBlockViolation(
  block: unknown,
): { field: string; reason: string } | null {
  if (typeof block !== "object" || block === null) {
    return { field: "blocks", reason: "block_not_object" }
  }
  const raw = block as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (key !== "label" && key !== "start" && key !== "end") {
      return { field: `blocks.${key}`, reason: "unknown_key" }
    }
  }
  if (typeof raw.label !== "string" || raw.label.length === 0) {
    return { field: "blocks.label", reason: "missing_or_empty" }
  }
  if (typeof raw.start !== "string" || !HHMM_RE.test(raw.start)) {
    return { field: "blocks.start", reason: "not_hhmm" }
  }
  if (typeof raw.end !== "string" || !HHMM_RE.test(raw.end)) {
    return { field: "blocks.end", reason: "not_hhmm" }
  }
  // Zero-padded HH:MM compares chronologically as strings.
  if (raw.start >= raw.end) {
    return { field: "blocks", reason: "start_not_before_end" }
  }
  return null
}

/**
 * Strict `schedule.override.set` payload validation. REFUSEs anything that is not
 * EXACTLY `{ date: <YYYY-MM-DD>, isOpen: <boolean>, blocks?: {label,start,end}[],
 * note?: <string> }` (unknown keys rejected). `date` MUST be a CONCRETE ISO date —
 * the resolver stamped it; a relative word the resolver could not resolve fails
 * here (fail-closed). The `isOpen` ⇔ `blocks` coherence is enforced: an OPEN day
 * requires a non-empty list of coherent windows ("abrimos só às 18h"); a CLOSED
 * day forbids windows ("fecha amanhã"). NL-date normalization + today-or-future
 * are NOT here (the resolver + `requireScheduleDateActionable` own those).
 */
const validateScheduleOverridePayload: OpsGuard = (envelope) => {
  if (envelope.kind !== "schedule.override.set") return null
  const raw = envelope.payload as unknown as Record<string, unknown>

  // Reject unknown keys first — the contract is closed.
  for (const key of Object.keys(raw)) {
    if (!SCHEDULE_OVERRIDE_SET_KEYS.has(key)) {
      return decisionRefuse(
        refuseScheduleOverridePayloadInvalid(`unknown payload key "${key}"`),
        [
          basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
            field: key,
            reason: "unknown_key",
          }),
        ],
      )
    }
  }

  if (typeof raw.date !== "string" || !isValidIsoDate(raw.date)) {
    return decisionRefuse(
      refuseScheduleOverridePayloadInvalid("date must be a YYYY-MM-DD calendar date"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "date",
          reason: "not_iso_date",
        }),
      ],
    )
  }

  if (typeof raw.isOpen !== "boolean") {
    return decisionRefuse(
      refuseScheduleOverridePayloadInvalid("isOpen must be a boolean"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "isOpen",
          reason: "not_boolean",
        }),
      ],
    )
  }

  const hasBlocks = raw.blocks !== undefined
  if (hasBlocks && !Array.isArray(raw.blocks)) {
    return decisionRefuse(
      refuseScheduleOverridePayloadInvalid("blocks must be an array when present"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "blocks",
          reason: "not_array",
        }),
      ],
    )
  }
  const blocks = (hasBlocks ? (raw.blocks as unknown[]) : [])

  if (raw.isOpen === true) {
    // An OPEN override MUST carry at least one coherent window (else it is
    // indistinguishable from "revert to normal" — a separate, unshipped verb).
    if (blocks.length === 0) {
      return decisionRefuse(
        refuseScheduleOverridePayloadInvalid("an open override requires at least one time block"),
        [
          basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
            field: "blocks",
            reason: "open_requires_blocks",
          }),
        ],
      )
    }
    for (const block of blocks) {
      const violation = scheduleBlockViolation(block)
      if (violation !== null) {
        return decisionRefuse(
          refuseScheduleOverridePayloadInvalid(
            `block ${violation.field}: ${violation.reason}`,
          ),
          [
            basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
              field: violation.field,
              reason: violation.reason,
            }),
          ],
        )
      }
    }
  } else if (blocks.length > 0) {
    // A CLOSED day must not carry windows — reject the contradiction.
    return decisionRefuse(
      refuseScheduleOverridePayloadInvalid("a closed override must not carry time blocks"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "blocks",
          reason: "closed_forbids_blocks",
        }),
      ],
    )
  }

  if (raw.note !== undefined && typeof raw.note !== "string") {
    return decisionRefuse(
      refuseScheduleOverridePayloadInvalid("note must be a string when present"),
      [
        basis("schema", BASIS_CODES.schema.PAYLOAD_INVALID, {
          field: "note",
          reason: "not_string",
        }),
      ],
    )
  }

  return null
}

/**
 * REFUSE `schedule.override.set` when the override date is NOT actionable — a
 * business day already in the PAST, or the today-or-future reference could not be
 * projected (`state.schedule` null/unprojected). Fail-closed: never write an
 * override for a past day, and never write blind without the reference. The ops
 * resolver projects `state.schedule.today` (today `YYYY-MM-DD` in
 * RESTAURANT_TIMEZONE); zero-padded ISO dates compare chronologically as strings.
 */
const requireScheduleDateActionable: OpsGuard = (envelope, state) => {
  if (envelope.kind !== "schedule.override.set") return null
  const { date } = envelope.payload as ScheduleOverrideSetPayload
  const today = state.schedule?.today
  if (typeof today !== "string" || !isValidIsoDate(today)) {
    return decisionRefuse(
      refuseScheduleOverrideDateNotActionable(
        "no today-or-future reference projected for the schedule override",
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "schedule_date_must_be_today_or_future",
          date,
          reason: "reference_unavailable",
        }),
      ],
    )
  }
  if (date < today) {
    return decisionRefuse(
      refuseScheduleOverrideDateNotActionable(
        `date "${date}" is before today "${today}"`,
      ),
      [
        basis("business", BASIS_CODES.business.RULE_VIOLATED, {
          rule: "schedule_date_must_be_today_or_future",
          date,
          today,
          reason: "past_date",
        }),
      ],
    )
  }
  return null
}

/** EXECUTE producer for `schedule.override.set` (fires after validation +
 *  date-actionability REFUSE the failing cases, and after the AUTH gates
 *  authorized). Reversible, non-money ⇒ no CONFIRM overlay (direct EXECUTE). */
const executeScheduleOverrideSet: OpsGuard = (envelope) => {
  if (envelope.kind !== "schedule.override.set") return null
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
      // NEW-004 — product.price.set: strict validate → exists → uniform-variant
      // → sanity → (UNTRUSTED CONFIRM overlay | EXECUTE). Each is a no-op for
      // the other kinds, so ordering only matters WITHIN this triple-plus.
      validatePricePayload,
      requirePriceProductExists,
      requireUniformVariantPricing,
      sanityRefuseAbsurdPrice,
      decidePriceSet,
      // SCN-114 — menu.special.set: strict validate → not-past → exists →
      // (UNTRUSTED CONFIRM overlay | EXECUTE). Each is a no-op for the other
      // kinds, so ordering only matters WITHIN this quad.
      validateMenuSpecialPayload,
      requireSpecialDateNotPast,
      requireSpecialProductExists,
      decideMenuSpecialSet,
      // BKL-088 — ops.alert.resolve.staff
      validateAlertResolvePayload,
      requireAlertActionable,
      executeAlertResolve,
      // BKL-088 — incident.ticket.close.staff
      validateIncidentClosePayload,
      requireIncidentActionable,
      executeIncidentClose,
      // SCN-127 — schedule.override.set: strict validate → date-actionable
      // (today-or-future) → EXECUTE (reversible, no CONFIRM overlay). Each is a
      // no-op for the other kinds, so ordering only matters WITHIN this triple.
      validateScheduleOverridePayload,
      requireScheduleDateActionable,
      executeScheduleOverrideSet,
    ],
    default: "REFUSE",
  }
