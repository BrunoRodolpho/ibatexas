// AuditRedactor — Task 18 (M4 Audit & observability).
//
// Sits between `buildAuditRecord(...)` and `sink.emit(...)` in
// `intent-audit-wiring.ts`. Walks `record.envelope.payload` recursively and
// scrubs PII before any sink (NATS / console / future Postgres) sees it.
//
// Why this lives here and not in `@adjudicate/*`:
//   Per CLAUDE.md rule #9 the `@adjudicate/*` packages are domain-independent
//   primitives. Per-intent-kind redaction schema is IbateXas (and LGPD)
//   business — that lives in the adopter, not the framework.
//
// Threat model (investigation 08 §"P0 #1"):
//   - `AuditRecord.envelope.payload` carries the LLM's literal tool input.
//   - `set_pix_details` payload contains plaintext name + email + CPF.
//   - The default sink stack publishes to NATS subject
//     `ibatexas.audit.intent.decision.v1`. Any subscriber with permission
//     reads CPF in cleartext.
//   - This module nukes the leak BEFORE fan-out.
//
// ── P0-15: auditHash recomputation (Option A) ─────────────────────────────
//
// Pre-W2 the redactor preserved `auditHash` verbatim while mutating
// `envelope.payload`. `verifyAuditRecord` reading a durable redacted record
// re-derived `sha256Canonical(record \ {auditHash, signature})` against
// the redacted envelope and reported `tampered` for EVERY redacted record.
// Tamper-detection at the audit-record level was structurally inert
// downstream of `getAuditSink()`.
//
// The W2 fix recomputes `auditHash` over the redacted record. The trade-off
// (documented in docs/adjudicate-migration/audit/REDACTION-HASH-DECISION.md):
//
//   - LOSS: the original-content tamper guarantee at the audit-record level.
//     A downstream reader cannot prove the unredacted payload was unmodified;
//     they can only prove the REDACTED payload was unmodified.
//   - GAIN: `verifyAuditRecord` actually works on redacted records (the
//     only kind any downstream sink sees, by invariant #1 of this module).
//   - REPLAY: must redact with the same config to reproduce the same hash.
//     The redaction salt (`AUDIT_REDACT_SECRET`) becomes part of the replay
//     contract — operators MUST snapshot it alongside the audit records.
//
// ── P0-10: actor.sessionId leak (Wave 4 security) ─────────────────────────
//
// HTTP routes set `actor.sessionId = customerId` verbatim (e.g., me.ts:280
// passes `customerId` as sessionId for the LGPD anonymize envelope; cart and
// order-actions follow the same pattern). The redactor previously preserved
// `envelope.actor` whole, so plaintext customerId shipped to NATS + Postgres.
//
// W4 fix: treat `envelope.actor.sessionId` as a HASH field. The full REDACT
// path was rejected because audit replay correlation needs a deterministic
// identifier (same customer → same hash across records). The salted SHA-256
// truncation gives correlation without reversibility.
//
// The `actor` object is otherwise preserved (principal stays plaintext —
// it's a literal "user"|"llm"|"system" enum, no PII).
//
// Invariants (do not break under any pull-request):
//   1. Idempotent — `redact(redact(record))` deep-equals `redact(record)`.
//   2. Hash-stable post-redaction — `redact(record).auditHash` equals
//      `sha256Canonical(redact(record) \ {auditHash, signature})`. The
//      stored hash matches what `verifyAuditRecord` will derive.
//   3. `intentHash` is NEVER recomputed — replay reconstructs the envelope
//      from the redacted record's nonce + actor + taint + createdAt, and
//      since `intentHash` is computed over the ORIGINAL payload at build-
//      time, the redacted record's intentHash is still byte-identical to
//      the originating envelope's. Ledger dedup remains correct.
//   4. Shape-preserving — `decision`, `decision_basis`, `at`, `durationMs`,
//      `version`, `plan`, `supersedes`, `kernelIdentity`, `kernelVersion`,
//      `policyVersion`, `signature`, and the envelope's `taint` / `kind` /
//      `nonce` / `createdAt` / `version` / `intentHash` fields are
//      untouched. `envelope.payload` and `envelope.actor.sessionId` are
//      transformed; `envelope.actor.principal` stays verbatim.
//      `auditHash` is recomputed.
//   5. Fail-open — if a redaction step throws (e.g. cycle in payload), we
//      replace the entire payload with `{ __redactor_error: true }` and
//      log. NEVER block a decision because of a redactor bug. The stub
//      payload's hash is also recomputed for invariant #2.
//   6. Correlation-preserving sessionId — the same input sessionId always
//      hashes to the same output (deterministic with stable hashSecret),
//      so audit consumers can group records by customer without learning
//      the customerId.
//
// See `docs/adjudicate-migration/tasks/18-audit-redactor.md` and
// `docs/adjudicate-migration/investigation/08-security-trust-boundaries.md`
// §"P0 #1" for the full rationale.

import { createHash } from "node:crypto"
import {
  sha256Canonical,
  type AuditRecord,
  type Decision,
  type IntentActor,
} from "@adjudicate/core"
// Single PII taxonomy — shared with the decision-layer createDataClassificationGuard
// so the redactor and guard can never drift (adversarial-audit finding).
import {
  CARD_RE,
  CPF_RE,
  EMAIL_RE,
  HASH_PREFIX,
  isSentinelString,
  PHONE_RE,
  PII_SENTINELS,
} from "@ibatexas/pii"

// ── Field-name rules ──────────────────────────────────────────────────────────
//
// All matches are case-insensitive. The redactor lowercases the field name
// before consulting these sets.
//
// REDACT_FIELDS  → replace value with `"[REDACTED]"`. Use for raw PII whose
//                  value carries no audit-correlation value (CPF, email,
//                  phone, payment-method primitives).
// HASH_FIELDS    → replace value with `"hashed:" + sha256(value+salt)[0..8]`.
//                  Use when the audit team needs to correlate records
//                  ("same customer across two intents") without seeing the
//                  underlying string. `name` and `address` are the canonical
//                  examples per task spec.

/**
 * Canonical PII field names. Case-insensitive match on the lowercased key.
 *
 * Sourced from:
 *   - `apps/api/src/utils/sanitize-analytics.ts` (existing PostHog mask).
 *   - Brazilian government identifier lexicon (CPF, CNPJ, RG).
 *   - Card-payment primitives (PCI-DSS).
 *   - WhatsApp/cellphone aliases (existing IbateXas codebase).
 */
const REDACT_FIELDS: ReadonlySet<string> = new Set([
  // Brazilian identifiers
  "cpf",
  "cnpj",
  "rg",
  // Contact
  "email",
  "phone",
  "cellphone",
  "celular",
  "telefone",
  "whatsapp",
  // Payment-card primitives (PCI)
  "cardnumber",
  "card_number",
  "cvv",
  "cvc",
  "pan",
  "securitycode",
  "security_code",
  // PIX details (set_pix_details aliases)
  "taxid",
  "tax_id",
  // Tokenized phone-shaped session ids (defense-in-depth — actor.sessionId is
  // exempt because actor lives outside payload, but if the LLM ever inserts a
  // sessionId-like field INSIDE payload it gets scrubbed)
  "msisdn",
  // audit-2026-05-25 (I3) — OTP tokens. The customer's 6-digit Twilio
  // Verify OTP flows through CustomerAnonymizePayload.otpToken (see
  // apps/api/src/routes/me.ts ~line 766) and would otherwise reach the
  // audit pipeline verbatim within Twilio's TTL window. The 6-digit
  // OTP shape doesn't match CPF/email/phone/card regex defenses, so we
  // pin it at the field-name layer. The customer.anonymize per-kind
  // rule covers the canonical case; this set entry catches any future
  // intent kind that carries the same field name.
  "otptoken",
  "otp_token",
  "otpcode",
  "otp_code",
])

/**
 * Field names that preserve correlation via salted SHA-256.
 *
 * Replacing `name`/`address` with `[REDACTED]` would erase the audit team's
 * ability to ask "did this customer hit two different intents?". A short
 * deterministic hash answers that question without leaking the underlying
 * string.
 *
 * Salt comes from `AUDIT_REDACT_SECRET` — operator-controlled so a leaked
 * audit log cannot be rainbow-tabled back to plaintext.
 */
const HASH_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "customername",
  "customer_name",
  "fullname",
  "full_name",
  "nome",
  "address",
  "addressline1",
  "address_line1",
  "addressline2",
  "address_line2",
  "endereco",
  "logradouro",
  // CustomerId / orderId-shaped opaque correlation tokens. The kernel's
  // own intentHash is already PII-free; payload-level customerId references
  // need hashing because the LLM's `set_pix_details` input includes them
  // verbatim from the conversational context.
  "customerid",
  "customer_id",
])

// ── Sentinel constants ────────────────────────────────────────────────────────
//
// Idempotency relies on the redactor recognising its own output. The
// sentinel format `[REDACTED:*]` plus the `hashed:xxxxxxxx` prefix gives
// us a stable detection surface — see `isAlreadyRedacted`.

// Aliased from @ibatexas/pii to the existing in-file names so the rest of this
// module is untouched. (HASH_PREFIX + the regexes + isSentinelString are imported.)
const SENTINEL_FIELD = PII_SENTINELS.FIELD
const SENTINEL_CPF = PII_SENTINELS.CPF
const SENTINEL_EMAIL = PII_SENTINELS.EMAIL
const SENTINEL_PHONE = PII_SENTINELS.PHONE
const SENTINEL_CARD = PII_SENTINELS.CARD
const SENTINEL_LONG = PII_SENTINELS.TRUNCATED

// String length cap. Two purposes:
//   - Defense against a runaway LLM payload that embeds a megabyte of taint.
//   - Defense against a free-form `reason` / `note` field with a customer
//     name buried mid-sentence — we truncate to a sensible audit summary
//     length and keep the prefix.
const MAX_STRING_LENGTH = 500

// `isSentinelString` (exact sentinel match or `hashed:` prefix) and the value
// regexes (CPF_RE / EMAIL_RE / PHONE_RE / CARD_RE — tuned for BR PII, g-flagged,
// last-line-of-defense over field values) are imported from @ibatexas/pii, the
// single taxonomy shared with the decision-layer guard.

// ── Public types ──────────────────────────────────────────────────────────────

export interface AuditRedactor {
  /**
   * Return a deep-cloned copy of `record` with `record.envelope.payload`
   * scrubbed. `intentHash` and `auditHash` are preserved verbatim.
   */
  redact(record: AuditRecord): AuditRecord
  /**
   * Test-friendly entrypoint for the inner payload walker. Exposed so tests
   * can exercise the rule engine without building a full `AuditRecord`.
   */
  redactPayload(payload: unknown): unknown
}

export interface AuditRedactorOptions {
  /**
   * Salt for `hashed:*` outputs. In production this MUST be set via
   * `AUDIT_REDACT_SECRET` to prevent rainbow-table attacks. Empty string is
   * legal in dev but the redactor's caller should `console.warn` on boot.
   */
  readonly hashSecret?: string
  /**
   * Optional override of the REDACT field set (case-insensitive). Future
   * Packs that introduce new PII-bearing intents can extend this via the
   * `intent-audit-wiring` composition point.
   */
  readonly extraRedactFields?: ReadonlySet<string>
  /**
   * Optional override of the HASH field set (case-insensitive).
   */
  readonly extraHashFields?: ReadonlySet<string>
  /**
   * Per-intent-kind hook. Returns a list of field paths (dot-joined or
   * bracket-notation) to redact regardless of name match. Used by Packs
   * that ship semi-structured payloads (e.g. `twilio.message.send.body`).
   *
   * Today implemented inline via {@link INTENT_KIND_FIELD_RULES}; the option
   * is exposed for future per-deployment overrides without code changes.
   */
  readonly fieldRulesForKind?: (kind: string) => ReadonlyArray<string>
  /**
   * Optional warn sink for boot-time configuration warnings. Defaults to
   * `console.warn`. Tests inject a vi.fn to assert the warning fires when
   * `hashSecret` is empty.
   */
  readonly warn?: (msg: string) => void
  /**
   * W3-8: optional hook called once per redactor fail-open event with a
   * classification label (cycle, throw, unknown). Adopters wire this to
   * `kernel_audit_redactor_failures_total{reason}`. The hook MUST be
   * fail-open itself — exceptions thrown from `onFailure` are swallowed
   * and never reach the audit pipeline.
   */
  readonly onFailure?: (reason: AuditRedactorFailureReason) => void
}

/** W3-8: classification labels for redactor failures. */
export type AuditRedactorFailureReason = "cycle" | "throw" | "unknown"

function classifyRedactorError(err: unknown): AuditRedactorFailureReason {
  if (!(err instanceof Error)) return "unknown"
  const m = err.message.toLowerCase()
  if (
    m.includes("circular") ||
    m.includes("cycle") ||
    m.includes("converting circular")
  )
    return "cycle"
  if (m.length > 0) return "throw"
  return "unknown"
}

// ── Per-intent-kind field rules ───────────────────────────────────────────────
//
// Some intents stash PII in fields whose NAMES don't trigger the global
// REDACT/HASH sets. Three examples from the IbateXas surface:
//
//   1. `whatsapp.session.handover.*` — free-form reason text that often quotes
//      a customer's last message (which may contain CPF/email).
//   2. `twilio.message.send.body` — the actual outbound message body (the
//      live WhatsApp egress wrapper). The template name is fine; the
//      rendered body is not.
//   3. `customer.anonymize.customerId` — already covered by HASH_FIELDS, but
//      listed here to document the intent.
//
// The map is keyed by `envelope.kind`. Values are dot-separated field paths
// relative to `envelope.payload`. The walker treats any string at the named
// path as if it had matched REDACT_FIELDS — replaced with `[REDACTED]`.
//
// Adding a new intent? Add it here. The contract test will cover it
// automatically via the corpus.
//
// ── Audit-2026-05-24 F-5 / F-6 history ────────────────────────────────────
//
// F-5: pre-2026-05-24 this map keyed on `"whatsapp.handoff.request"` — a
//      taxonomy-doc kind that does NOT exist in pack-whatsapp's
//      `WhatsAppIntentKind` union. The real kind is
//      `"whatsapp.session.handover"`. The typo silently disabled the rule
//      so the reason/lastMessage free-form text reached the audit sink
//      verbatim. Likewise, the WhatsApp template send payload uses
//      `templateVariables` (per `WhatsAppTemplateSendPayload`), not
//      `variables` — so the variable map (which carries rendered customer
//      names) escaped redaction.
//
// F-6: 14 envelope kinds across pack-payments, pack-orders,
//      pack-reservations, pack-whatsapp ship free-form text fields
//      (`reason`, `comment`, `body`, `note`, `specialRequests`) that the
//      global PII regex catches CPF/email/phone/card for — but NOT
//      customer names buried mid-sentence. Adding explicit per-kind rules
//      below makes the redactor over-redact those fields rather than
//      hope the regex catches every leak.

export const INTENT_KIND_FIELD_RULES: Readonly<Record<string, ReadonlyArray<string>>> = {
  // ── WhatsApp handover reason / append body fields ──────────────────────
  // BKL-177: the whatsapp.message.send + whatsapp.template.send rules were
  // retired with those kinds. The identical body/text/variable redaction for
  // LIVE WhatsApp egress lives on the `twilio.message.send` wrapper rule
  // below (exempt `twilio.` prefix) — no live PII vector is uncovered.
  // F-5: the staff-driven takeover kind. `reason`/`lastMessage` carry
  // free-form text that often quotes the customer.
  "whatsapp.session.handover": ["reason", "lastMessage"],
  // BKL-030: the customer-side escalation on-ramp (now a real Pack union
  // member). Its `reason` is optional customer free-text — redact it.
  "whatsapp.handoff.request": ["reason"],
  // F-6: persistence-side conversation append. The `body` field carries
  // the literal customer-typed text (often CPF/email/name fragments). The
  // live wire-egress `twilio.message.send.body` is covered below; this is
  // the archival sibling per pack-whatsapp's W5-6 design.
  "conversation.message.append": ["body", "text"],

  // ── Payment-domain free-form reasons (F-6) ──────────────────────────────
  // `PaymentRefundIssuePayload.reason`, `PaymentWaivePayload.reason`,
  // `PaymentStatusForcePayload.reason`. Reasons are free-form admin
  // strings that can quote customer language (CPF, names) so they are
  // redacted as a subtree.
  "payment.refund.issue": ["reason"],
  "payment.waive": ["reason"],
  "payment.status.force": ["reason"],
  "pix.charge.refund": ["reason"],
  // Defense-in-depth — this `reason` field is typed but technically a
  // closed enum in pack-payments. We still over-redact in case a Pack
  // bump introduces a free-form string in the future. (BKL-176 removed the
  // retired payment.charge.fail/cancel entries here.)
  "payment.status.transition": ["reason"],

  // ── Order-domain free-form text fields (F-6) ───────────────────────────
  // `OrderCancelPayload.reason`, `OrderNoteAddPayload.body`,
  // `OrderReviewSubmitPayload.comment`, `OrderStatusTransitionPayload.reason`.
  "order.cancel": ["reason"],
  "order.note.add": ["body"],
  "order.review.submit": ["comment"],
  "order.status.transition": ["reason"],

  // ── Reservation-domain free-form text fields (F-6) ─────────────────────
  // `ReservationCreatePayload.specialRequests` and `.modify.specialRequests`
  // are arrays of free-form strings (the kind-rule path match collapses
  // every leaf to `[REDACTED]`). `ReservationCancelPayload.reason` is a
  // free-form cancellation reason.
  "reservation.create": ["specialRequests"],
  "reservation.modify": ["specialRequests"],
  "reservation.cancel": ["reason"],

  // ── Customer-onboarding free-form fields (F-6) ─────────────────────────
  // `CustomerAnonymizePayload` is bounded (scope/customerId/otpToken) but
  // older audit fixtures and route layers attach a free-form `reason`
  // string. We over-redact it.
  //
  // audit-2026-05-25 (I3): otpToken — the customer's 6-digit Twilio
  // Verify OTP is embedded literal in CustomerAnonymizePayload (see
  // apps/api/src/routes/me.ts ~line 766). It is NOT a CPF/email/phone
  // shape so the regex defenses don't catch it; it is NOT in
  // REDACT_FIELDS or HASH_FIELDS by name. Pre-fix, the literal OTP
  // flowed to NATS subject ibatexas.audit.intent.decision.v1 + Postgres
  // intent_audit in cleartext within Twilio Verify's validity window.
  // Per-kind rule explicitly covers it as a subtree; the field is also
  // added to REDACT_FIELDS globally for defense-in-depth across any
  // future intent kind that carries it.
  "customer.anonymize": ["reason", "otpToken"],
  "customer.anonymize.cancel": ["reason", "otpToken"],

  // ── Ops Pack free-form fields (NEW-032 slice C1 + BKL-088) ─────────────
  // `ProductAvailabilitySetPayload` is bounded (productId opaque id +
  // available boolean) EXCEPT the optional free-form `reason` operator note.
  // Over-redact `reason` — same posture as order/payment status-transition.
  "product.availability.set": ["reason"],
  // NEW-004 — `ProductPriceSetPayload` is bounded (productId opaque id +
  // priceCentavos integer) EXCEPT the optional free-form `reason` operator note,
  // which an owner could type with a customer name / detail in it. Over-redact
  // `reason` (same posture as product.availability.set).
  "product.price.set": ["reason"],
  // BKL-088 — the two OWNED ops-plane RESOLUTION verbs. Bounded payloads
  // (`{alertId|incidentId}` opaque id) EXCEPT the optional free-form `reason`
  // operator note, which an owner could type with a customer name / detail in
  // it. Over-redact `reason` (same posture as product.availability.set). The
  // SAME-named SYSTEM write layer (`ops.alert.resolve` / `incident.ticket.close`)
  // carries only `{id, resolvedBy:"staff:<id>", resolutionType}` — opaque ids +
  // a role-free staff token — so it needs no rule (id-only, PII-free) and is
  // deliberately off KNOWN_INTENT_KINDS, hence not iterated by the conformance
  // corpus; the reason never reaches it.
  "ops.alert.resolve.staff": ["reason"],
  "incident.ticket.close.staff": ["reason"],
  // SCN-127 — `ScheduleOverrideSetPayload` is bounded (date + isOpen + blocks of
  // {label,start,end} HH:MM windows) EXCEPT the optional free-form `note`
  // operator note, which an owner could type with a customer name / detail in it.
  // Over-redact `note` (same posture as the other ops verbs' `reason`).
  "schedule.override.set": ["note"],

  // ── AUT-038 staff-CRUD plane (HTTP-only, off KNOWN_INTENT_KINDS) ─────────
  // staff.create / staff.update payloads carry `hourlyRateCentavos` — employee
  // pay data (the staff routes OWNER-gate even the GET list for exactly this
  // field; LGPD employee-remuneration class). Phone is covered by the global
  // REDACT_FIELDS and name by the global HASH_FIELDS, but the rate is a NUMBER,
  // which the walker passes by identity — so it needs this per-kind rule
  // (redactFieldValue coerces numeric values to the sentinel). Like the
  // ops-plane staff verbs above, these kinds are deliberately off
  // KNOWN_INTENT_KINDS, so the conformance corpus never forces a
  // classification — the rule must be added here, not discovered by the gate.
  // staff.deactivate / staff.role.assign are id-only + closed-enum → see
  // PII_FREE_KIND_ALLOWLIST.
  "staff.create": ["hourlyRateCentavos"],
  "staff.update": ["hourlyRateCentavos"],

  // ── Wrapper-level intent kinds (audit-2026-05-25 I3) ────────────────────
  // The 4 wrapper meta types (twilio/stripe/medusa/medusa-store) emit
  // intent kinds OUTSIDE KNOWN_INTENT_KINDS per the D10 policy
  // (`packages/llm-provider/src/intent-kinds.ts`). The per-intent-redactor
  // conformance test iterates KNOWN_INTENT_KINDS so the gap was invisible;
  // the gap-sweep finding flagged that `twilio.message.send`'s `body`
  // field (rendered pt-BR customer-name greetings like "Olá João, …")
  // bypassed both the global field-name rules (no match on "body") and
  // the regex defenses (first names aren't CPF/email/phone shapes).
  //
  // Rules below cover the common PII vectors in each wrapper namespace:
  //   - body/text/templateVariables — customer-typed or LLM-rendered
  //   - description/title — admin or customer free-form fields
  //   - note/comment — admin annotations
  //   - metadata — opaque object that can carry arbitrary PII
  "twilio.message.send": ["body", "text", "templateVariables", "variables"],
  "medusa.admin.customer.update": ["metadata", "first_name", "last_name", "company_name"],
  "medusa.admin.order.update_metadata": ["metadata"],
  "medusa.admin.order.edit.create": ["description", "internal_note"],
  "medusa.admin.product.update": ["description", "subtitle", "metadata"],
  "medusa.cart.update": ["metadata", "context"],
  "medusa.cart.complete": ["metadata"],
  "medusa.store.cart.update": ["metadata", "context"],
  "medusa.store.cart.email.update": ["metadata"],
  "medusa.store.cart.metadata.update": ["metadata"],
  "medusa.store.cart.complete": ["metadata"],
  "stripe.payment_intent.create": ["description", "metadata", "statement_descriptor"],
  "stripe.refund.create": ["reason", "metadata"],
  "stripe.charge.update": ["description", "metadata"],

  // ── Validation events (synthesised payloads carry customer-typed text) ─
  "validation.text.rewrite": ["originalText", "rewritten"],
  "validation.text.refuse": ["originalText", "rewritten"],
}

// ── PII-free intent-kind allowlist (audit-2026-05-24 T3) ──────────────────
//
// Conformance contract: every kind in `KNOWN_INTENT_KINDS` MUST appear in
// EITHER `INTENT_KIND_FIELD_RULES` (above) OR `PII_FREE_KIND_ALLOWLIST`
// (below). The conformance test at
// `apps/api/src/__tests__/audit-2026-05-24/per-intent-redactor-conformance.test.ts`
// pins this invariant — adding a new intent kind without classifying it
// here fails CI with a file:line pointer.
//
// Entries are kinds whose payloads are PII-free by construction:
//
//   - **Opaque-id-only** — payload carries `{orderId, paymentId, cartId,
//     reservationId, itemId, variantId, addressId, waitlistId,
//     chargeId, providerTxId, ...}` plus closed enums/numbers/booleans.
//     The global REDACT/HASH field-name rules and the regex defenses
//     cover any incidental PII a malicious LLM might smuggle into a
//     free-form string slot; the typed payload shape itself has no
//     free-form text.
//   - **Already-redacted PII** — `phoneHash` is a one-way SHA-256 by the
//     time it enters the audit pipeline (cf. pack-whatsapp/sanitize.ts).
//     The hash is itself the audit-correlation token; no additional
//     redaction would add safety.
//   - **PII covered by global field-name rules** — kinds whose only
//     PII-bearing fields are `{name, email, cpf, cnpj, phone, address,
//     customerId, ...}` are fully covered by the global REDACT_FIELDS /
//     HASH_FIELDS sets above. They do NOT need a per-kind rule because
//     the walker's field-name match fires unconditionally on those
//     literal names regardless of `envelope.kind`.
//
// Adding a new entry requires a 1-line WHY comment naming the payload's
// PII surface (or explicit "no PII fields"). Catch-all comments
// ("looks fine") are rejected by code review.
/**
 * Kernel-governed HTTP-plane intent kinds that are DELIBERATELY absent from
 * KNOWN_INTENT_KINDS (they are not Pack kinds — no planner/roster/claim
 * surface; the ops-alert-policy idiom). They still ride `withAdjudicate` and
 * therefore reach every audit sink, so the per-intent conformance corpus
 * validates their redactor classification against THIS set instead of the
 * Pack union. Every entry here MUST be classified in INTENT_KIND_FIELD_RULES
 * or PII_FREE_KIND_ALLOWLIST (the conformance test enforces it), and a typo'd
 * rule key still trips the F-5 sentinel because it matches neither set.
 */
export const HTTP_PLANE_GOVERNED_KINDS: ReadonlySet<string> = new Set<string>([
  // AUT-038 staff-CRUD plane (routes/admin/staff.ts → StaffCommandService)
  "staff.create",
  "staff.update",
  "staff.deactivate",
  "staff.role.assign",
])

export const PII_FREE_KIND_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // ── Order Pack — opaque-id-only payloads ────────────────────────────
  "order.cart.ensure", // cartId only
  "order.item.add", // cartId/variantId/quantity/allergens(enum array)
  "order.item.update", // cartId/itemId/quantity
  "order.item.remove", // cartId/itemId
  "order.cart.sync", // cartId/items[]; items are variantId+quantity+allergens
  "order.coupon.apply", // cartId/code; code is a short opaque promo handle
  "order.checkout.create", // PII in pixDetails covered by global REDACT (name/email/cpf)
  "order.pix.details.set", // PII in name/email/cpf covered by global REDACT_FIELDS
  "order.amend.request", // orderId + changes[] (op enum + variantId/itemId)
  "order.amend.add_item", // orderId/variantId/quantity/allergens
  "order.amend.update_qty", // orderId/itemId/quantity
  "order.amend.remove_item", // orderId/itemId
  "order.address.change", // address.{street,number,...} covered by global HASH_FIELDS
  "order.type.switch", // orderId + newType: closed enum + optional httpVocab enum
  "order.reorder", // previousOrderId + paymentMethod: closed enum
  // LE2-021 — the reorder-last workflow's anchor. The strongest member of this
  // list: its payload has NO authored fields at all. The only key that ever
  // rides it is the runtime-written `_workflowInstanceId` (a UUID the workflow
  // runtime mints), and the workflow declares zero slots, so the parse seam's
  // `sanitizeWorkflowSlots` drops every key the model tries to attach — there is
  // no free-form string slot for PII to reach, smuggled or otherwise.
  "order.reorder.request",
  "order.projection.create", // customerId covered by global HASH_FIELDS
  "order.status.reconcile", // orderId/newStatus(short status enum)/source: closed enum
  "order.fiscal.emit", // NEW-014 — orderId only (customerTaxId lives in the PR2 provider input, never on the envelope)

  // ── Reservation Pack — opaque-id-only payloads ───────────────────────
  "reservation.checkin", // reservationId only
  "reservation.complete", // reservationId only
  "reservation.no_show.mark", // reservationId only
  "reservation.waitlist.join", // timeSlotId/partySize

  // ── AUT-038 staff-CRUD plane — id-only / closed-enum payloads ────────
  // (staff.create / staff.update are NOT here — they carry hourlyRateCentavos
  // pay data and are classified in INTENT_KIND_FIELD_RULES above.)
  "staff.deactivate", // staffId only
  "staff.role.assign", // staffId + role: closed {OWNER,MANAGER,ATTENDANT} enum

  // ── Ops Pack (SCN-114) — id/date/centavos, no PII, no free-form field ──
  "menu.special.set", // productId (opaque)/date (YYYY-MM-DD)/promoPriceCentavos (int)

  // ── WhatsApp Pack — phone fields are pre-hashed ─────────────────────
  // `WhatsAppSessionHandoverPayload.fromHashedPhone` is SHA-256 of the
  // customer's number (per pack-whatsapp). The kind ALSO carries a free-
  // form `reason` and `lastMessage` — but those are already in
  // INTENT_KIND_FIELD_RULES above (which is why this kind is NOT
  // allowlisted; `whatsapp.session.handover` MUST be classified as ruled,
  // not PII-free). This comment lives here as documentation of the
  // boundary; no kind is allowlisted in this section today.

  // ── Payment Pack — opaque-id-only or closed-enum reason payloads ─────
  // (BKL-176 removed the retired payment.charge.create/confirm/expire entries.)
  "payment.create", // orderId/paymentId/method enum/amountCentavos/stripePaymentIntentId
  "payment.pix.regenerate", // orderId/paymentId/currentRegenerationCount
  "payment.method.switch", // customerId covered by global HASH_FIELDS
  "payment.retry", // orderId/previousPaymentId/newMethod enum
  "payment.refund.confirm", // paymentId/wireStatus/stripeEventId
  "payment.dispute.open", // paymentId/stripeEventId/disputeAmountCentavos
  "payment.cash.confirm", // orderId/paymentId/amountCentavos/staffId (operator id, no customer PII)
  "payment.status.reconcile", // paymentId/newStatus/stripeEventId/timestamp

  // ── Customer Onboarding — fields hit global REDACT / pre-hashed ─────
  "customer.create", // phoneHash is already SHA-256 (audit-correlation token)
  "customer.profile.update", // name/email covered by global HASH/REDACT
  "customer.preferences.update", // allergenExclusions/dietaryFlags (short controlled-vocabulary strings)
  "customer.pix.details.save", // name/email/cpf covered by global HASH/REDACT
  "customer.address.add", // address.{street,...} covered by global HASH_FIELDS
  "customer.address.remove", // addressId only

  // ── Loyalty (audit-2026-05-25 I13) ───────────────────────────────────
  "loyalty.stamp.add", // {customerId} only — covered by global HASH_FIELDS

  // ── PIX Charge (adjudicate/pack-payments-pix) ───────────────────────
  // `pix.charge.create.payerDocument` is digit-only CPF (11) or CNPJ (14).
  // The CPF regex defense catches the 11-digit shape; the 14-digit CNPJ
  // shape is caught by CARD_RE (13-19 digit run → `[REDACTED:CARD]`).
  // The label is imperfect (CNPJ flagged as CARD) but the value is
  // redacted — that's the load-bearing invariant.
  "pix.charge.create",
  "pix.charge.confirm", // chargeId/providerTxId/timestamp
  // `pix.charge.refund` has free-form `reason` admin text, ruled in
  // INTENT_KIND_FIELD_RULES alongside payment.refund.issue / payment.waive.
])

export function createAuditRedactor(
  opts: AuditRedactorOptions = {},
): AuditRedactor {
  const hashSecret = opts.hashSecret ?? ""
  const warn = opts.warn ?? ((m: string) => console.warn(m))

  if (hashSecret.length === 0) {
    warn(
      "[audit-redactor] AUDIT_REDACT_SECRET is empty — hashed fields are " +
        "rainbow-table-attackable. Set a 32-char random value in production.",
    )
  }

  // Merge default sets with caller-supplied extras. Lowercase normalisation
  // is applied once here so the hot-path walker can compare against a single
  // set without repeating `.toLowerCase()`.
  const redactFields = mergeLower(REDACT_FIELDS, opts.extraRedactFields)
  const hashFields = mergeLower(HASH_FIELDS, opts.extraHashFields)
  const fieldRulesForKind =
    opts.fieldRulesForKind ??
    ((kind: string): ReadonlyArray<string> =>
      INTENT_KIND_FIELD_RULES[kind] ?? [])

  function redactPayload(payload: unknown): unknown {
    return walk(payload, "", {
      redactFields,
      hashFields,
      kindFieldPaths: new Set<string>(),
      hashSecret,
    })
  }

  function redact(record: AuditRecord): AuditRecord {
    try {
      const kind = record.envelope.kind
      const kindRules = fieldRulesForKind(kind)
      // Pre-compute the path-prefixed kind rules so the walker can hit them
      // with a single Set lookup. Paths use dot notation for objects and
      // bracket notation for arrays; the rules are relative to payload root.
      const kindFieldPaths = new Set<string>(kindRules)

      const redactedPayload = walk(record.envelope.payload, "", {
        redactFields,
        hashFields,
        kindFieldPaths,
        hashSecret,
      })

      // P0-10: hash `actor.sessionId` so HTTP routes that set
      // `actor.sessionId = customerId` (me.ts, cart.ts, order-actions.ts)
      // no longer leak plaintext customerId to NATS + Postgres. The hash
      // is deterministic so audit consumers can correlate records for the
      // same customer.
      //
      // Already-redacted sentinels and WhatsApp's pre-hashed session ids
      // (sha256-of-phone) are short-circuited via `isSentinelString` and
      // the `hashed:` prefix detection. The hashed form is idempotent —
      // a second pass re-hashes the prefix and the result remains stable
      // because the inputs converge (see `isSentinelString` short-circuit).
      const redactedActor = redactActorSessionId(
        record.envelope.actor,
        hashSecret,
      )

      // FE-T05 review (MAJOR-1a) — walk `record.metadata` (the ADR-124 v5
      // governance/observability sidecar — e.g. the Language Engine's
      // materialized ExtractionIR/HydratedIntentIR, `apps/api/src/claustrum/
      // language-engine/audit-metadata.ts`) through the SAME global REDACT/
      // HASH/regex defenses as the payload. No per-intent-kind path rules
      // here (`kindFieldPaths` empty) — metadata's shape is a sidecar, not
      // the payload, so path-relative kind rules don't apply, but the
      // GLOBAL field-name (redactFields/hashFields) and regex (CPF/email/
      // phone/card) defenses still catch anything PII-shaped at any depth —
      // defense-in-depth alongside the schema-driven filter in
      // `buildLanguageEngineAuditMetadata` (which limits what gets IN in
      // the first place). Safe to recompute the hash afterward: `metadata`
      // is EXCLUDED from the auditHash pre-image (v5+, ADR-124 — verified
      // below in `recomputeAuditHash`), so redacting it can never invalidate
      // tamper-evidence.
      const redactedMetadata =
        record.metadata === undefined
          ? undefined
          : (walk(record.metadata, "", {
              redactFields,
              hashFields,
              kindFieldPaths: new Set<string>(),
              hashSecret,
            }) as Record<string, unknown>)

      // P1-2 (audit-2026-05-24 C-1): walk `decision.rewritten.payload`
      // with the SAME per-kind rule as `envelope.payload`.
      //
      // Threat: when the kernel decides REWRITE, the decision carries a
      // post-rewrite envelope at `decision.rewritten`. Adopters wire
      // sanitizers like pack-whatsapp's `sanitizeCustomerString` into
      // the REWRITE path — but those sanitizers do NOT do PII
      // detection (see pack-whatsapp/src/sanitize.ts header). The
      // post-rewrite payload therefore still carries CPF/email/phone
      // typed by the customer, and the pre-2026-05-24 redactor's
      // shallow spread on the AuditRecord skipped `decision.rewritten`
      // entirely. The unredacted payload landed on NATS subject
      // `ibatexas.audit.intent.decision.v1` in cleartext.
      //
      // Fix: when the decision is REWRITE, redact the rewritten
      // payload using the SAME kind rules. The intent kind is preserved
      // across REWRITE (sanitization, normalization, capping only — see
      // `decision.ts`), so reusing `kindFieldPaths` is safe.
      //
      // audit-2026-05-25 (I3): ALSO walk decision.basis[].detail. The
      // gap-sweep review found that subscribers like
      // apps/api/src/subscribers/customer-anonymize-medusa-resolver.ts
      // build EXECUTE-shaped decisions with
      // `basis: [{category:'business', code:RULE_VIOLATED,
      // detail: {errorMessage: (err as Error).message ?? String(err)}}]`.
      // Pre-fix, the redactor's walk skipped decision.basis entirely
      // (the file-level comment explicitly listed `decision_basis` as
      // "untouched"). MedusaRequestError messages can quote PII
      // ("Could not find customer with email user@example.com") so the
      // unredacted detail flowed to NATS + Postgres. Fix walks each
      // basis entry's detail object through the same redactor (no
      // kindFieldPaths because rules are payload-keyed; global
      // REDACT/HASH/regex defenses still apply).
      const redactedDecision = redactDecisionPayload(
        record.decision,
        {
          redactFields,
          hashFields,
          kindFieldPaths,
          hashSecret,
        },
      )

      // Shallow-clone the record and envelope, substituting the redacted
      // payload and actor. Invariant #3: intentHash is NEVER recomputed —
      // replay uses it to look up the original envelope and that lookup
      // must remain stable.
      const redactedRecord: AuditRecord = {
        ...record,
        envelope: {
          ...record.envelope,
          actor: redactedActor,
          payload: redactedPayload,
        },
        decision: redactedDecision,
        // FE-T05 review (MAJOR-1a) — omit the key entirely when there was no
        // metadata to begin with (hash-stable / no-`undefined`-key precision,
        // matching the rest of this module's spread conventions).
        ...(redactedMetadata === undefined ? {} : { metadata: redactedMetadata }),
      }

      // P0-15 Option A: recompute auditHash over the redacted record so
      // `verifyAuditRecord` reading from a downstream sink (NATS, Postgres)
      // can verify tamper-evidence on the redacted record. The pre-W2
      // redactor preserved the unredacted-payload auditHash verbatim,
      // which guaranteed `verifyAuditRecord` reported `tampered` for
      // every redacted record (the only kind any sink ever sees).
      //
      // Replay implications: a replay tool re-deriving auditHash against
      // a stored record MUST redact with the same config (rule sets +
      // hashSecret) to reproduce the stored hash. Operators MUST snapshot
      // `AUDIT_REDACT_SECRET` alongside the audit stream.
      return recomputeAuditHash(redactedRecord)
    } catch (err) {
      // Invariant #5: fail-open. Surface a structured stand-in so downstream
      // sinks can detect the failure (presence of `__redactor_error`) without
      // having access to the original PII.
      warn(
        `[audit-redactor] redact() threw on intent ${record.envelope.kind}: ${
          (err as Error).message
        } — replacing payload with stub.`,
      )
      // W3-8 — kernel_audit_redactor_failures_total. The redactor doesn't
      // import the recorder directly (it's a package-boundary concern); the
      // adopter passes an `onFailure` hook in the options. The
      // `__redactor_error` sentinel still appears in the stub for downstream
      // sinks to detect; the metric is the operator-facing counterpart.
      if (opts.onFailure) {
        try {
          opts.onFailure(classifyRedactorError(err))
        } catch {
          // The metric hook must NEVER block the fail-open path.
        }
      }
      // P0-10: stub the actor.sessionId on the fail-open path too so the
      // stub record itself doesn't leak the customerId via a path that
      // bypassed the payload walker.
      const stubbedActor = redactActorSessionId(
        record.envelope.actor,
        hashSecret,
      )
      // P1-2: if the failed-redact record is a REWRITE, also stub the
      // rewritten payload — the fail-open path must not leak PII via the
      // decision-level envelope either.
      const stubbedDecision: Decision =
        record.decision.kind === "REWRITE"
          ? {
              ...record.decision,
              rewritten: {
                ...record.decision.rewritten,
                actor: redactActorSessionId(
                  record.decision.rewritten.actor,
                  hashSecret,
                ),
                payload: { __redactor_error: true },
              },
            }
          : record.decision
      const stubbed: AuditRecord = {
        ...record,
        envelope: {
          ...record.envelope,
          actor: stubbedActor,
          payload: { __redactor_error: true },
        },
        decision: stubbedDecision,
        // FE-T05 review (MAJOR-1a) — the fail-open path must not leak
        // metadata PII either (mirrors the payload/decision stubbing above).
        ...(record.metadata === undefined
          ? {}
          : { metadata: { __redactor_error: true } }),
      }
      // The fail-open stub payload also needs a recomputed auditHash so
      // `verifyAuditRecord` doesn't surface false-positive tamper warnings
      // for stub records.
      return recomputeAuditHash(stubbed)
    }
  }

  return { redact, redactPayload }
}

// ── P1-2: decision.rewritten.payload helper ──────────────────────────────
//
// REWRITE decisions carry a transformed envelope at `decision.rewritten`.
// Per `@adjudicate/core/decision.ts` REWRITE is scope-restricted to
// sanitization/normalization/safe capping — never business transformation
// — so the rewritten envelope's `kind` is identical to the original
// envelope's kind. The per-kind rules used on `envelope.payload` apply
// without modification.
//
// Why redact REWRITE's rewritten payload at all? Adopters (pack-whatsapp's
// REWRITE guard via `sanitizeCustomerString`) sanitize template-injection
// shapes but DO NOT do PII detection — see the file-level comment in
// pack-whatsapp/src/sanitize.ts. A customer who types
// `meu cpf é 123.456.789-00` produces a rewritten payload whose `body` still
// carries the CPF. Pre-fix, that field reached NATS unredacted.
//
// Returns a fresh Decision object. Non-REWRITE decisions are returned
// unchanged — they carry no envelope payload at the decision level.
function redactDecisionPayload(
  decision: Decision,
  ctx: WalkContext,
): Decision {
  // audit-2026-05-25 (I3): every decision kind has `basis: BasisEntry[]`
  // and each entry may carry a free-form `detail` object. Walk every
  // detail through the redactor so embedded PII (Medusa error strings
  // quoting customer email/CPF, free-form business-rule violation
  // notes, etc.) gets scrubbed. Uses a context with EMPTY kindFieldPaths
  // because the kind-rule prefixes are payload-keyed; the global
  // REDACT_FIELDS / HASH_FIELDS sets and the regex defenses still apply
  // at every nesting level.
  const basisCtx: WalkContext = { ...ctx, kindFieldPaths: new Set<string>() }
  const redactedBasis = (decision.basis ?? []).map((b) => {
    if (b.detail === undefined) return b
    const redactedDetail = walk(b.detail, "", basisCtx)
    return { ...b, detail: redactedDetail as Record<string, unknown> }
  })
  const baseWithBasis: Decision = {
    ...decision,
    basis: redactedBasis,
  } as Decision

  if (baseWithBasis.kind !== "REWRITE") {
    return baseWithBasis
  }

  // REWRITE-only: also walk the rewritten envelope's payload + actor.
  const rewrittenPayload = walk(baseWithBasis.rewritten.payload, "", ctx)
  // Also hash the rewritten envelope's actor.sessionId for parity with
  // the top-level actor redaction (P0-10). If the kernel rebuilt the
  // rewritten envelope with the original actor, hashing here is
  // defense-in-depth: a misbehaving REWRITE that swapped the actor for
  // a customerId-bearing sessionId would still get scrubbed.
  const rewrittenActor = redactActorSessionId(
    baseWithBasis.rewritten.actor,
    ctx.hashSecret,
  )
  return {
    ...baseWithBasis,
    rewritten: {
      ...baseWithBasis.rewritten,
      actor: rewrittenActor,
      payload: rewrittenPayload,
    },
  }
}

// ── P0-10: actor.sessionId hash helper ────────────────────────────────────
//
// HTTP routes set `actor.sessionId = customerId` (e.g., LGPD anonymize at
// me.ts, cart sessionId at cart.ts). Hash it with the same salted SHA-256
// as the payload HASH_FIELDS path so:
//
//   - Audit consumers can group records for the same customer (deterministic)
//   - No plaintext customerId reaches NATS or Postgres
//   - WhatsApp pre-hashed session ids (already `sha256-of-phone`) survive
//     unchanged because the second hash on an already-hashed-shape would
//     still be deterministic, but more efficiently we short-circuit when
//     the sessionId is already a sentinel
//
// D-017 / Phase-3 managed agents: a managed agent's sessionId has the strict
// shape `agent:<kebab-id>@<x.y.z>:entity:<entityId>` (minted by
// `agentSessionId()` in @ibatexas/agents). Every segment is an OPERATIONAL
// identifier — the `agent:` audit namespace, the agent id@version, and an
// entity (order/payment) id — never customer PII (CPF/email/phone/name, which
// the payload field rules scrub independently). It MUST stay UNHASHED so the
// time-windowed production-signal consumers (kernel-replay `--ci`, impact
// graph, drift baseline) can exclude shadow/agent rows via
// `session_id LIKE 'agent:%'` / `startsWith("agent:")`. The pattern is strict
// (kebab id + semver) so a FORGED `agent:<pii>` sessionId can never bypass the
// hash — only a properly-minted namespace is exempt.
const AGENT_SESSION_ID_RE =
  /^agent:[a-z][a-z0-9]*(?:-[a-z0-9]+)*@\d+\.\d+\.\d+:entity:.+$/

// Returns a fresh actor object — never mutates input.
function redactActorSessionId(
  actor: IntentActor,
  hashSecret: string,
): IntentActor {
  const sessionId = actor.sessionId
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return actor
  }
  // Idempotent: if the sessionId is already a redactor sentinel (e.g.,
  // `hashed:xxxxxxxx`), leave it alone so a second redact pass produces
  // the same record.
  if (isSentinelString(sessionId)) {
    return actor
  }
  // D-017: managed-agent namespaces are operational, not PII — keep unhashed so
  // the agent-namespace exclusion filters work on the stored row (see above).
  if (AGENT_SESSION_ID_RE.test(sessionId)) {
    return actor
  }
  return {
    ...actor,
    sessionId: hashValue(sessionId, hashSecret),
  }
}

// ── Audit-hash recomputation helper ───────────────────────────────────────────
//
// `verifyAuditRecord` from `@adjudicate/core` (audit.ts) does (v5+):
//   const { auditHash, signature, metadata, ...rest } = record
//   const derived = sha256Canonical(rest)
//   return derived === auditHash ? verified : tampered
//
// To produce a record where this returns `verified: true`, the redactor
// must compute the SAME canonical-JSON hash over the SAME record minus
// auditHash + signature + metadata. We replicate the strip-and-hash here.
//
// Records lacking a v4 `auditHash` (pre-v4 audit records) get a freshly
// computed one — this is upgrade-friendly. Records with a signature: the
// signature would be invalidated by hash change, so we drop it on
// redaction. If non-repudiation is needed downstream, the signer must
// re-sign post-redaction (out of scope for the redactor).
function recomputeAuditHash(record: AuditRecord): AuditRecord {
  // Strip auditHash + signature + metadata before deriving. Mirrors
  // verifyAuditRecord (core audit.ts): metadata (v5+) is EXCLUDED from the hash
  // pre-image, so a record that later carries governance metadata still
  // verifies. We re-attach metadata to the output unchanged — it survives
  // redaction but is never part of the tamper-evident pre-image.
  const { auditHash: _previous, signature: _signature, metadata, ...rest } = record
  const auditHash = sha256Canonical(rest)
  return metadata === undefined ? { ...rest, auditHash } : { ...rest, metadata, auditHash }
}

// ── Walker ────────────────────────────────────────────────────────────────────
//
// Recursive structural walk. Visits every key in objects and every index in
// arrays. The four return paths:
//
//   1. Primitive non-string  → identity (numbers, booleans, null, bigint).
//   2. String                → regex-scrub and length-cap.
//   3. Object                → re-create with each key's value walked.
//   4. Array                 → re-create with each index's value walked.
//
// Path tracking is dot-and-bracket: `customer.address[0].line1`. Tracked so
// per-intent-kind rules (`fieldRulesForKind`) can match by structural
// location, not just by leaf field name.

interface WalkContext {
  redactFields: ReadonlySet<string>
  hashFields: ReadonlySet<string>
  kindFieldPaths: ReadonlySet<string>
  hashSecret: string
}

function walk(value: unknown, path: string, ctx: WalkContext): unknown {
  // Primitives.
  if (value === null || value === undefined) return value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint" || typeof value === "symbol") return value

  if (typeof value === "string") return walkString(value, path, ctx)
  if (Array.isArray(value)) return walkArray(value, path, ctx)
  if (typeof value === "object") {
    return walkObject(value as Record<string, unknown>, path, ctx)
  }

  // Fallback (functions, exotic types) — drop to sentinel so we never leak
  // a stringified function body containing closure-captured PII.
  return SENTINEL_FIELD
}

// String leaf. If this string is at a path that the per-intent-kind rule names,
// it gets the full `[REDACTED]` treatment regardless of content. This is how we
// scrub `twilio.message.send.body` even when the body is a fully-formed
// sentence with no PII regex match. Otherwise the regex/length defenses run.
function walkString(value: string, path: string, ctx: WalkContext): string {
  if (path.length > 0 && pathMatchesKindRule(path, ctx.kindFieldPaths)) {
    // Idempotency guard — don't replace an already-redacted sentinel.
    return isSentinelString(value) ? value : SENTINEL_FIELD
  }
  return redactString(value)
}

// Array — re-create, walking each index with its `[i]` path segment.
function walkArray(value: unknown[], path: string, ctx: WalkContext): unknown[] {
  const out: unknown[] = new Array(value.length)
  for (let i = 0; i < value.length; i++) {
    out[i] = walk(value[i], path.length === 0 ? `[${i}]` : `${path}[${i}]`, ctx)
  }
  return out
}

// Object — re-create on a null-prototype container, dropping pollution-class
// keys, and route each value through the REDACT / HASH / per-kind / recurse
// rules in that priority order (identical to the pre-refactor if/continue chain).
function walkObject(
  obj: Record<string, unknown>,
  path: string,
  ctx: WalkContext,
): Record<string, unknown> {
  // NEW-P0-X5: use `Object.create(null)` so assigning a key called
  // `__proto__` does NOT mutate the prototype chain of our output. We
  // also reject `__proto__` / `constructor` / `prototype` as own-key
  // names during walk — a JSON.parse'd payload with `{"__proto__": ...}`
  // exposes the key via `Object.keys`, and `out["__proto__"] = X` on a
  // plain `{}` would silently set the prototype. With a null-prototype
  // container the assignment becomes a regular property (still rejected
  // explicitly so downstream JSON serialisation doesn't carry the
  // pollution shape forward).
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >
  for (const rawKey of Object.keys(obj)) {
    // Drop pollution-class keys outright. These never carry useful audit
    // payload; an LLM emitting an envelope with `__proto__` is either
    // adversarial or unintentionally constructing a polluted object.
    if (
      rawKey === "__proto__" ||
      rawKey === "constructor" ||
      rawKey === "prototype"
    ) {
      continue
    }
    const v = obj[rawKey]
    // Key-level scrub: if a KEY itself contains a PII shape (rare but the
    // bypass corpus includes it — e.g. `"12345678900_was_processed"`), we
    // run it through the same regex defense so the JSON-serialised record
    // doesn't leak the value-as-key.
    const key = redactString(rawKey)
    const childPath = path.length === 0 ? key : `${path}.${key}`
    const lowerKey = rawKey.toLowerCase()

    // Field-name match — REDACT. The match is on the ORIGINAL key (pre-
    // scrub) so that a key like `"cpf"` still routes to REDACT even though
    // the key itself has no PII shape.
    if (ctx.redactFields.has(lowerKey)) {
      out[key] = redactFieldValue(v)
    } else if (ctx.hashFields.has(lowerKey)) {
      // Field-name match — HASH.
      out[key] = hashFieldValue(v, ctx.hashSecret)
    } else if (pathMatchesKindRule(childPath, ctx.kindFieldPaths)) {
      // Per-intent-kind path match — REDACT entire subtree.
      out[key] = redactFieldValue(v)
    } else {
      // Recurse — let the regex defense pick up any leaf PII strings.
      out[key] = walk(v, childPath, ctx)
    }
  }
  return out
}

// REDACT replacement for a single field value (used by both the field-name
// REDACT match and the per-intent-kind path match — historically identical
// branches). String / number / bigint values coerce to the sentinel: a numeric
// CPF (e.g. `cpf: 12345678900`) must not survive as a number; its digits are
// still a PII shape in the JSON-serialised record. null/undefined pass through;
// non-scalars recurse via `redactSubtree`, replacing every leaf string.
function redactFieldValue(v: unknown): unknown {
  if (typeof v === "string") {
    return isSentinelString(v) ? v : SENTINEL_FIELD
  }
  if (
    typeof v === "number" ||
    typeof v === "bigint" ||
    typeof v === "boolean"
  ) {
    // Booleans don't leak PII but we still scrub for shape uniformity.
    return SENTINEL_FIELD
  }
  if (v === null || v === undefined) {
    return v
  }
  return redactSubtree(v)
}

// HASH replacement for a single field value. Strings hash directly; numbers and
// bigints are stringified first; null/undefined pass through; non-scalars are
// JSON-coerced then hashed (captures `{name: {first: "x"}}` shapes).
function hashFieldValue(v: unknown, hashSecret: string): unknown {
  if (typeof v === "string") {
    return isSentinelString(v) ? v : hashValue(v, hashSecret)
  }
  if (typeof v === "number" || typeof v === "bigint") {
    return hashValue(String(v), hashSecret)
  }
  if (v === null || v === undefined) {
    return v
  }
  return hashValue(JSON.stringify(v), hashSecret)
}

// Replace every leaf string in a subtree with the REDACT sentinel. Used when
// a parent field name is on the REDACT list and the value is non-scalar.
function redactSubtree(value: unknown): unknown {
  if (typeof value === "string") {
    return isSentinelString(value) ? value : SENTINEL_FIELD
  }
  if (value === null || value === undefined) return value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value.map((v) => redactSubtree(v))
  }
  if (typeof value === "object") {
    // NEW-P0-X5: null-prototype container + reject pollution-class keys.
    const out: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") {
        continue
      }
      out[k] = redactSubtree(v)
    }
    return out
  }
  return SENTINEL_FIELD
}

// Apply regex defenses to a string value and cap its length.
function redactString(value: string): string {
  // Length cap first — extremely long strings burn regex cycles and any PII
  // beyond the cap is unrecoverable anyway.
  let working =
    value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)} ${SENTINEL_LONG}`
      : value

  // Idempotency — short-circuit on exact sentinel.
  if (isSentinelString(working)) return working

  // Order matters:
  //   1. Email (most distinctive shape).
  //   2. CPF (anchored 11-digit shape).
  //   3. Phone (BR-style with +55 prefix or (DD) format) — must run BEFORE
  //      card because the card regex is a greedy run of 13-19 digits that
  //      can otherwise eat a "+55 11 99999-9999" sequence.
  //   4. Card (last — remaining 13-19 digit runs that look like cards).
  working = working.replace(EMAIL_RE, SENTINEL_EMAIL)
  working = working.replace(CPF_RE, SENTINEL_CPF)
  working = working.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, "")
    // 10-13 digits is the BR phone shape range. Anything outside that range
    // (e.g. a 4-digit standalone code) is left alone — the card regex picks
    // up the longer card-shape runs separately.
    if (digits.length >= 10 && digits.length <= 13) {
      return SENTINEL_PHONE
    }
    return m
  })
  working = working.replace(CARD_RE, (m) => {
    const digits = m.replace(/\D/g, "")
    return digits.length >= 13 ? SENTINEL_CARD : m
  })

  return working
}

// Salted SHA-256, truncated to 8 hex chars. Collision rate ~1/(16^8) ≈
// 1 in 4 billion — sufficient for audit-correlation purposes; insufficient
// for cryptographic uniqueness, which is intentional (we WANT this to be
// truncated so reversal is harder).
function hashValue(value: string, secret: string): string {
  const h = createHash("sha256")
  h.update(value)
  h.update(secret)
  return `${HASH_PREFIX}${h.digest("hex").slice(0, 8)}`
}

// Path-match helper. Supports literal path or any prefix where the suffix
// would be an array index. e.g. rule `"variables"` matches both
// `"variables"` and `"variables[0]"`.
function pathMatchesKindRule(
  path: string,
  rules: ReadonlySet<string>,
): boolean {
  if (rules.size === 0) return false
  if (rules.has(path)) return true
  // Strip a trailing `[N]` and try again — array element of a redacted field.
  const stripped = path.replace(/\[\d+\]$/, "")
  if (stripped !== path && rules.has(stripped)) return true
  // Any ancestor in the rule set — `variables.foo` matches rule `variables`.
  const parts = path.split(".")
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join(".")
    const ancestorStripped = ancestor.replace(/\[\d+\]$/, "")
    if (rules.has(ancestor) || rules.has(ancestorStripped)) return true
  }
  return false
}

// Merge the canonical set with optional extras and lowercase everything.
function mergeLower(
  base: ReadonlySet<string>,
  extra?: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!extra || extra.size === 0) {
    // base is already lowercase by construction.
    return base
  }
  const merged = new Set<string>()
  for (const k of base) merged.add(k.toLowerCase())
  for (const k of extra) merged.add(k.toLowerCase())
  return merged
}
