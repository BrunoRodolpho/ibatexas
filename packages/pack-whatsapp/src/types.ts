/**
 * @ibatexas/pack-whatsapp — domain types.
 *
 * IbateXas's third first-party Pack: governs the WhatsApp egress channel.
 * Mirrors the `pack-reservations` layout so subsequent Packs can keep
 * templating off the same shape.
 *
 * Authoritative intent vocabulary: `docs/adjudicate-migration/governance/
 * 01-intent-taxonomy.md` §"Domain: whatsapp". The kinds enumerated here
 * track that taxonomy exactly — if a new kind appears in
 * `apps/api/src/whatsapp/client.ts` or `subscribers/cart-intelligence.ts`,
 * update the taxonomy doc FIRST.
 *
 * # Scope (this Pack)
 *
 * Per investigation 05 §"Packs ibatexas should write":
 *   "@ibatexas/pack-whatsapp — channel-level intents.
 *    whatsapp.message.send, whatsapp.template.send,
 *    whatsapp.session.handover. Threading + 24-hour-window business
 *    rules naturally fit the kernel's state guards."
 *
 * The taxonomy's full whatsapp domain also enumerates
 * `whatsapp.handoff.request`, `whatsapp.followup.schedule`, and
 * `whatsapp.outreach.send` — those land in subsequent tasks (handoff
 * rate-limit + outreach campaign gating). This Pack stays narrow.
 *
 * # Intent surface (this Pack)
 *
 *   - whatsapp.message.send       — sys, s. Free-form WhatsApp text. The
 *                                    24-hour customer-initiated window
 *                                    rule (Meta/Twilio Business API)
 *                                    restricts non-template messages to
 *                                    sessions where the customer wrote
 *                                    in the last 24h. Outside the window,
 *                                    REFUSE — only templated messages
 *                                    are permitted by Twilio.
 *   - whatsapp.template.send      — sys. Templated WhatsApp message that
 *                                    bypasses the 24h window. SYSTEM-only
 *                                    (no LLM-proposable path).
 *   - whatsapp.session.handover   — sys. Staff bridge. SYSTEM-only;
 *                                    initiated by a staff command or the
 *                                    handoff subscriber. The Pack
 *                                    rate-limits this per customer phone
 *                                    hash to prevent abuse per
 *                                    investigation 08 P1 #4.
 *
 * # Source of existing logic
 *
 * `apps/api/src/whatsapp/client.ts` (sendText/sendMedia/sendTemplate)
 * carries the imperative implementation today. This Pack extracts the
 * *policy* layer (window enforcement / rate-limit / sanitization)
 * without re-implementing the side effects — task 15
 * (`WhatsAppCommandService`) and task 16 (NATS subscriber refactor)
 * consume the Pack's adjudication and dispatch to the existing client.
 *
 * # PII discipline
 *
 * Per investigation 08, phone numbers MUST be hashed before flowing
 * through this Pack's state. The `to` field on payloads is the E.164
 * recipient (only the command service / subscriber knows the raw
 * value); state fields key on `phoneHash` (`hashPhone(phone)` from
 * `apps/api/src/whatsapp/session.ts` — 12-hex-char SHA-256 prefix).
 */

import { createSystemTaintPolicy } from "@adjudicate/primitives"

export type WhatsAppIntentKind =
  | "whatsapp.message.send"
  | "whatsapp.template.send"
  | "whatsapp.session.handover"

// ── Payloads ────────────────────────────────────────────────────────────

/**
 * Recipient role — drives the customer→staff sanitization path and the
 * 24h-window applicability check.
 *
 *   - `customer` — outbound to a customer's phone. Subject to the
 *     24h window rule when sending a free-form (non-template) message.
 *   - `staff`    — outbound to a staff member's phone. Free-form text
 *     is allowed but customer-controlled strings must be sanitized
 *     (no template-injection, no PII echo) — investigation 08 P1 #4.
 *   - `system`   — internal sender. Used by handover signals.
 */
export type WhatsAppRecipientRole = "customer" | "staff" | "system"

/**
 * Sender role — orthogonal to recipient. The customer→staff sanitization
 * path fires when `senderRole = "customer"` AND `recipientType = "staff"`.
 */
export type WhatsAppSenderRole = "customer" | "staff" | "system"

/**
 * Free-form WhatsApp message. Outside the 24h customer-initiated window,
 * REFUSE — Twilio's Business API rejects free-form messages outside the
 * window, and the silent failure mode in production today is
 * indistinguishable from a delivery success.
 *
 * `to` is the E.164 phone of the recipient. The adopter (command service)
 * is the only layer that holds the raw phone; the Pack's state keys on
 * `phoneHash`. The Pack does not inspect `to` for PII purposes — it
 * trusts the adopter projected `phoneHash` into state.
 */
export interface WhatsAppMessageSendPayload {
  readonly to: string
  readonly body: string
  readonly senderRole: WhatsAppSenderRole
  /**
   * Optional template hint. When present AND `templateVariables` is
   * present, the message is treated as a templated message and bypasses
   * the 24h window. (The Pack does not validate the template name
   * itself — that's the WhatsApp client's responsibility downstream.)
   */
  readonly templateName?: string
  readonly templateVariables?: Readonly<Record<string, string>>
}

/**
 * Templated WhatsApp message — always permitted regardless of the
 * customer-initiated 24h window (Meta/Twilio policy: pre-approved
 * templates bypass the window). SYSTEM-only at the taint layer.
 */
export interface WhatsAppTemplateSendPayload {
  readonly to: string
  readonly templateName: string
  readonly templateVariables: Readonly<Record<string, string>>
}

/**
 * Staff bridge / session handover. Triggered when a staff user takes
 * over a customer conversation. Rate-limited per customer phone hash
 * (`WHATSAPP_HANDOFF_LIMIT_MINUTES`) to prevent abuse where a malicious
 * customer floods the staff channel via repeated handovers.
 */
export interface WhatsAppSessionHandoverPayload {
  readonly sessionId: string
  readonly fromActor: "customer" | "llm" | "staff"
  readonly toActor: "customer" | "staff"
  /**
   * Customer phone hash — keyed into the rate-limit counter. SHA-256/12
   * prefix per `apps/api/src/whatsapp/session.ts.hashPhone`. Required
   * so the rate-limit threshold guard has a non-PII identity to count
   * against.
   */
  readonly customerPhoneHash: string
}

/**
 * Discriminated payload union — typed by `kind`. Guards narrow via
 * `envelope.kind` and may cast `envelope.payload` to the matching
 * member; payload contracts are validated by the guards in
 * `./policies.ts` and by the wire schema upstream.
 */
export type WhatsAppPayload =
  | WhatsAppMessageSendPayload
  | WhatsAppTemplateSendPayload
  | WhatsAppSessionHandoverPayload

// ── Context (per-turn caller identity / channel surface) ────────────────

/**
 * Per-turn context the planner consumes. Mirrors the relevant slice of
 * IbateXas's session context; structurally independent from the
 * `OrderContext` / `ReservationContext` so the planner here doesn't
 * accidentally couple to those domains.
 */
export interface WhatsAppContext {
  readonly channel: "whatsapp" | "web" | "staff"
  readonly customerId: string | null
  /** Staff principal — distinct from customerId, present only for `staff` channel. */
  readonly staffId: string | null
}

// ── State (per-session snapshot the kernel adjudicates against) ─────────

/**
 * Per-session state the Pack's policies inspect. Adopters embed this into
 * their session context shape. Fields here track exactly what the
 * WhatsApp client and the cart-intelligence subscriber read off Redis +
 * Prisma at decision time — the Pack does not pull from those stores
 * directly, the adopter projects state in.
 *
 * Time fields:
 *   - `now` is the wall-clock the policy compares against. Adopter
 *     supplies it (injection point for deterministic tests + audit
 *     replay).
 *   - `lastCustomerMessageAt` is the timestamp of the most-recent
 *     customer-initiated inbound message on this conversation. Drives
 *     the 24h-window guard. Absence means "no prior customer message
 *     known" — the window guard treats this conservatively as
 *     "outside the window" so a free-form outbound is REFUSEd.
 *
 * Rate-limit fields:
 *   - `perCustomerHandoffCount` maps `phoneHash` → count of handover
 *     events within the rolling rate-limit window
 *     (`WHATSAPP_HANDOFF_LIMIT_MINUTES`). The adopter projects this
 *     from Redis. The Pack reads it; the side-effect path increments
 *     it.
 *
 * Recipient classification:
 *   - `recipientType` is the role of the recipient phone for the
 *     in-flight envelope. The customer→staff sanitization path requires
 *     this to fire correctly; absent it, the path is skipped.
 */
export interface WhatsAppState {
  readonly ctx: WhatsAppContext & {
    /** Wall-clock snapshot. Injected by the adopter; required for window guards. */
    readonly now?: Date | null
    /** Timestamp of the most recent customer-initiated message. */
    readonly lastCustomerMessageAt?: Date | null
    /** Rate-limit counter projection. Keyed on phoneHash → count in current window. */
    readonly perCustomerHandoffCount?: Readonly<Record<string, number>>
    /** Role of the recipient phone for the in-flight envelope. */
    readonly recipientType?: WhatsAppRecipientRole | null
  }
}

// ── Taint policy ────────────────────────────────────────────────────────

/**
 * SYSTEM-only kinds: `whatsapp.template.send` (only the templated
 * outreach + cart-intelligence jobs may emit it) and
 * `whatsapp.session.handover` (only the staff bridge / handoff subscriber
 * emits it). The LLM must never forge a template message or a handover.
 *
 * `whatsapp.message.send` is UNTRUSTED-tolerant — the LLM can propose a
 * customer-bound message, but the window + sanitization guards in
 * `policies.ts` decide whether to admit / rewrite / refuse it.
 */
export const whatsappTaintPolicy = createSystemTaintPolicy({
  systemOnlyKinds: ["whatsapp.template.send", "whatsapp.session.handover"],
  userMinimum: "UNTRUSTED",
})

// ── Business thresholds (env-driven; CLAUDE.md rule #3) ─────────────────

/**
 * Read a non-negative number from an env var with a fallback. Mirrors
 * the `pack-reservations` helper.
 */
function readPositiveNumber(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue === "") return fallback
  const n = Number.parseFloat(envValue)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/**
 * Rolling rate-limit window for `whatsapp.session.handover`. Default
 * 10 minutes — one handover per customer per 10 minutes. Operators
 * override via `WHATSAPP_HANDOFF_LIMIT_MINUTES`. The threshold guard
 * REQUEST_CONFIRMATIONs on the 2nd handover within the window and
 * REFUSEs on the 3rd+ (the "clearly abusive" envelope per the task
 * spec).
 */
export const WHATSAPP_HANDOFF_LIMIT_MINUTES = readPositiveNumber(
  process.env.WHATSAPP_HANDOFF_LIMIT_MINUTES,
  10,
)

/**
 * Grace period (seconds) for the 24h customer-initiated window. Allows
 * a small overshoot before hard REFUSE — useful for messages composed
 * within the window but submitted seconds after expiry. Default 300
 * seconds (5 min). Operators override via `WHATSAPP_24H_WINDOW_GRACE_SECONDS`.
 */
export const WHATSAPP_24H_WINDOW_GRACE_SECONDS = readPositiveNumber(
  process.env.WHATSAPP_24H_WINDOW_GRACE_SECONDS,
  300,
)

/**
 * Total window in milliseconds — `24h + grace`. Computed once at module
 * load so the policy hot path is branchless.
 */
export const WHATSAPP_24H_WINDOW_MS =
  24 * 60 * 60 * 1000 + WHATSAPP_24H_WINDOW_GRACE_SECONDS * 1000

/**
 * Confirmation threshold — 2nd handover within the rolling window
 * (handover #2 → REQUEST_CONFIRMATION).
 */
export const WHATSAPP_HANDOFF_CONFIRM_COUNT = 2

/**
 * Hard refuse threshold — 3rd+ handover within the rolling window
 * (handover #3 → REFUSE as clearly abusive).
 */
export const WHATSAPP_HANDOFF_REFUSE_COUNT = 3

/**
 * Max sanitized customer-string length (chars). Truncation guard against
 * template-injection floods and oversized free-form bodies routed to
 * staff WhatsApp. Tuned to fit a single-line preview comfortably.
 */
export const WHATSAPP_SANITIZE_MAX_LENGTH = 100
