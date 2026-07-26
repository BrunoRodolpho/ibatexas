// ── Ops-plane no-reply incident seam (BKL-235) ────────────────────────────────
//
// THE DEFECT this closes. The customer planes (whatsapp-webhook.ts, routes/chat.ts)
// turn a turn-level delivery failure into a governed `ConversationIncident` and
// auto-close it on the next delivered reply. The OPS planes had NO such wiring: an
// ops turn that exhausted its empty-completion retries and fell to the honest
// `OPS_TURN_FAILED_PTBR` fallback logged one warn line and vanished. The
// LE2-032 ghost-turns RCA proved it — two ops-WhatsApp turns (6935339a, 236b4dd9)
// on 2026-07-21 hit exactly that disposition and `conversation_incidents` has
// count=0 for those sessions. Ops-plane failures were recoverable only by forensic
// store archaeology.
//
// ── This module EXTENDS the customer machinery; it does not fork it ───────────
//
// Everything load-bearing is imported, not re-implemented:
//
//   classifyTurnDelivery   the PURE customer-plane classifier — reused verbatim, so
//                          the ESCALATE-handoff exclusion and the
//                          empty/whitespace/abort cause mapping are the SAME code,
//                          not a parallel copy that can drift.
//   classifyCatchError     the PURE throw discriminator — same, including the F2
//                          post-send exclusion (already-served ⇒ never an incident).
//   emitNoDelivery         the `conversation.no_delivery` notification fan-out.
//   openIncidentInline     the governed open: `buildSystemEnvelope` →
//                          `incident.ticket.open` → kernel → executor. NEVER a raw
//                          DB write, on either plane.
//   closeIncidentOnDeliveredReply  the delivered-reply auto-close.
//
// What is genuinely ops-specific and therefore lives here: the `channel` value, the
// `admin:<staffId>` session id, and the field mapping (no Customer row, no PIX
// side-channel). Both ops ingresses call THIS so the mapping exists once.
//
// ── SCOPE: both ops ingresses, because the invariant spans them ──────────────
//
// WhatsApp (`ops-whatsapp-ingress.ts`) and the dashboard (`admin/ops-chat.ts`) are
// two surfaces on ONE staff conversation: same `sessionId` (`admin:<staffId>`), same
// parks, same ops-history thread. The per-session single-open-incident index therefore
// spans them, so wiring only WhatsApp would MANUFACTURE STUCK-OPEN ROWS — a ghost on
// WhatsApp then a recovery on the dashboard would never self-heal, and that stale open
// row would absorb every later WhatsApp drop as a `dropCount` increment instead of
// opening fresh (so no new staff ping). Both ingresses open, and both auto-close.
//
// The dashboard's response contract is untouched: it still returns 200 with whatever
// `reply` the turn produced. Only the durable record is added.
//
// There is no `retry_exhausted` analog on either. The customer webhook has an
// INGRESS-level second pass (`retryForMissedMessages`) that earns that cause; the ops
// ingress has none. The responder's own empty-completion retries are already
// exhausted by the time this seam sees blank text (it logs
// "responder exhausted empty-completion retries"), so `empty_completion` is the
// honest cause for that turn, not `retry_exhausted`.
//
// ── Distinguishability: `channel`, not a new `kind` ──────────────────────────
//
// `conversation_incidents.channel` is a plain String explicitly so a new plane can
// join without an `ALTER TYPE` ("agent plane later" — schema.prisma). Ops rows carry
// `ops-whatsapp` / `ops-dashboard` (`OPS_WHATSAPP_CHANNEL` / `OPS_DASHBOARD_CHANNEL`
// in @ibatexas/domain, alongside the taxonomy they discriminate), set EXPLICITLY:
// `incident-subscriber.ts` defaults a missing channel to `"whatsapp"`, so omitting it
// would actively MISLABEL an ops ghost as a customer one. ZERO migrations: no new enum
// value, no new column, frozen migrations untouched.
//
// The rows stay on the `no_reply` journal `kind` on purpose. An ops ghost has the
// IDENTICAL lifecycle to a customer ghost — the staffer was owed a reply, got
// silence, and the next delivered reply is the recovery proof — so it must ride the
// same auto-close seam. A separate `kind` is warranted only by an OPPOSITE lifecycle
// (a row a delivered reply must NOT close), which is not this.
//
// ── Why the single-slot session index is not a hazard here ────────────────────
//
// `conversation_incidents_session_open_uq` is UNIQUE(session_id) WHERE status is
// non-terminal — at most one open row per session. Ops rows live on
// `admin:<staffId>`, a namespace no customer session can occupy, so an ops incident
// can never occupy a customer session's slot (or vice versa). WITHIN the ops
// namespace the single slot is the CORRECT semantic, and the same one the customer
// plane relies on: repeat drops on one staff conversation fold into one row via
// `dropCount++` (escalating severity) rather than storming the inbox.
//
// ── `customerImpacted` = `!fallbackDelivered` (the column's actual contract) ──
//
// The column is documented as "false when a canned holding message was delivered
// (degraded, not a ghost)" — it tracks whether the person owed a reply ended up with
// NOTHING, not whether that person was a paying customer. The WhatsApp catch path
// already applies exactly this idiom for its canned apology
// (`customerImpacted: !apologyDelivered`), so ops follows it: a landed fallback is
// degraded (FALSE → `low` while recent), a failed one is a genuine total-silence
// ghost (TRUE).
//
// The consequence is deliberate and visible rather than hidden: because TRUE feeds
// `deriveSeverity`'s `silêncio` branch, a total-silence ops row CAN reach `high` once
// aged or repeated. That is the correct signal — the staffer got nothing at all — and
// it is pinned by an explicit severity test alongside the delivered-fallback case, so
// the weighting is reviewable instead of implicit.
//
// Whether the fallback landed is ALSO recorded in `detail` (a non-PII diagnostic), so
// forensics keeps the distinction in plain text without having to infer it from a
// boolean.

import {
  OPS_DASHBOARD_CHANNEL,
  OPS_WHATSAPP_CHANNEL,
  type IncidentCause,
} from "@ibatexas/domain";
import {
  classifyCatchError,
  classifyTurnDelivery,
  emitNoDelivery,
  openIncidentInline,
  type LogFn,
  type NoDeliveryClassification,
  type NoDeliverySignal,
  type TurnDisposition,
} from "../conversation/no-delivery.js";
import { closeIncidentOnDeliveredReply } from "../incidents/incident-auto-close.js";

export { OPS_DASHBOARD_CHANNEL, OPS_WHATSAPP_CHANNEL };

/**
 * The ops conversation id — and therefore the incident `sessionId`.
 *
 * `admin:<staffId>` is chosen over the capsule's `sessionKey` (`ops:<staffId>`)
 * because it is the key BOTH forensic stores already use, so an incident joins the
 * evidence for its own turn:
 *
 *   intent_audit — the ops envelope actor is stamped `sessionId: admin:<staffId>`
 *                  (ibatexas-planner.ts:779).
 *   turn_trace   — keyed on `conversation_id` (turn-trace-writer.ts:92), which for
 *                  both ops ingresses IS `admin:<staffId>`.
 *
 * `ops:<staffId>` is the conductor's serialization/lock domain and appears in
 * NEITHER store, so keying incidents on it would reintroduce the exact archaeology
 * BKL-235 exists to remove. Both candidates are 1:1 with the staffer, so the
 * one-open-incident-per-staff-session invariant is identical either way — this choice
 * only adds joinability. Change here and the auto-close lookup follows automatically.
 */
export function opsSessionId(staffId: string): string {
  return `admin:${staffId}`;
}

/**
 * PURE. The ops reply-text disposition. Mirrors the derivation `runConductorTurn`
 * applies on the WhatsApp customer path (`whatsapp-webhook.ts`), so an empty
 * completion and a whitespace-only one keep their DISTINCT frozen causes here too
 * — the ops ingresses' own `replyText.trim().length > 0` send gate collapses both
 * into "blank", which is right for deciding whether to send but too lossy for the
 * incident journal.
 *
 * There is no `suppressed_paused` case: neither ops ingress runs a bot-pause gate
 * (a staffer is never "paused for human takeover" — they ARE the human).
 */
export function classifyOpsReply(
  replyText: string | null | undefined,
): TurnDisposition {
  const raw = replyText ?? "";
  if (raw.length === 0) return "empty_completion";
  if (raw.trim() === "") return "whitespace_only";
  return "deliverable";
}

/** The per-ingress context every ops incident needs. */
export interface OpsTurnContext {
  readonly staffId: string;
  /** `OPS_WHATSAPP_CHANNEL` | `OPS_DASHBOARD_CHANNEL` — set explicitly; never left
   *  to `incident-subscriber.ts`'s `"whatsapp"` default. */
  readonly channel: string;
  /**
   * `capsule.turnId` — audit correlation + the dedup key's preferred component.
   * Absent when the capsule never opened (the catch path).
   */
  readonly turnId?: string | null;
  /**
   * Per-message dedup fallback when no `turnId` is in scope, mirroring the customer
   * path's `body.MessageSid`. Both ops ingresses already mint a per-inbound
   * `externalId` (randomUUID) — pass THAT, so a catch-path drop still gets a
   * per-turn-unique `externalId` instead of collapsing every future failure for this
   * staffer onto one `<session>:no-id` row.
   */
  readonly messageRef?: string | null;
  /** Channel-addressable handle so a manager can reply to the ghosted staffer. */
  readonly senderRef?: string | null;
  /** LGPD hash for correlation — never raw E.164. */
  readonly phoneHash?: string | null;
  readonly log: LogFn;
}

/** Shared signal builder + the ordered emit → governed open. Never throws. */
async function recordOpsDrop(
  ctx: OpsTurnContext,
  cause: IncidentCause,
  customerImpacted: boolean,
  detail: string,
  decisionKind?: string | null,
): Promise<void> {
  const signal: NoDeliverySignal = {
    sessionId: opsSessionId(ctx.staffId),
    cause,
    // `!fallbackDelivered` — the column's documented contract (degraded vs ghost),
    // the same idiom the WhatsApp catch path uses. See the header.
    customerImpacted,
    channel: ctx.channel,
    // NO Customer row exists for a staffer. The ops ingresses bind
    // `customerId: staff:<staffId>` on the CAPSULE (a conductor-side marker), but
    // this column is customer-scoped — it is `@@index`ed and the admin
    // incident-reply route does `prisma.customer.findUnique` on it. Writing a
    // `staff:` marker there would poison a customer lookup, so it stays null; the
    // staff identity is fully carried by `sessionId` (`admin:<staffId>`) + senderRef.
    customerId: null,
    senderRef: ctx.senderRef ?? null,
    phoneHash: ctx.phoneHash ?? null,
    turnId: ctx.turnId ?? null,
    messageSid: ctx.messageRef ?? null,
    decisionKind: decisionKind ?? null,
    detail,
  };
  // Ordered emit → open, matching the customer seam: the notification fan-out is
  // the redelivery backstop, the inline open is the durable net. The durable
  // `incident-subscriber` re-derives the SAME externalId from the published signal,
  // so the inline + NATS paths collapse to ONE row.
  await emitNoDelivery(signal, ctx.log);
  await openIncidentInline(signal, ctx.log);
}

/**
 * The ops analog of the customer webhook's `classify → emit → open` block. Call it
 * once per completed ops turn with the REAL send outcome; it is a no-op (returns
 * `null`) whenever the turn was fine, so the caller needs no branch of its own.
 *
 * `replyDelivered` MUST reflect the actual send, not the text — that is what makes
 * the abort-with-text false-negative catchable on this plane too (a non-blank reply
 * whose send threw is still a drop).
 */
export async function recordOpsTurnDelivery(args: {
  readonly ctx: OpsTurnContext;
  readonly replyText: string | null | undefined;
  /** Did anything actually reach the staffer this turn? */
  readonly replyDelivered: boolean;
  /** Did the honest fallback land? Drives `customerImpacted` AND is recorded in `detail`. */
  readonly fallbackDelivered: boolean;
  /** `turn.decision.kind` — an ESCALATE handoff is never a drop. */
  readonly decisionKind?: string | null;
}): Promise<NoDeliveryClassification | null> {
  const { ctx, replyText, replyDelivered, fallbackDelivered, decisionKind } = args;
  // The PURE customer-plane classifier, reused verbatim (ESCALATE exclusion + the
  // frozen cause mapping live there, once).
  const classification = classifyTurnDelivery({
    disposition: classifyOpsReply(replyText),
    ...(decisionKind != null ? { decisionKind } : {}),
    deliveredText: replyDelivered,
  });
  if (!classification) return null;

  await recordOpsDrop(
    ctx,
    classification.cause,
    !fallbackDelivered,
    `[OPS] ${ctx.channel} turn left the staff member without a reply; honest fallback ${
      fallbackDelivered ? "delivered" : "ALSO failed (total silence)"
    }`,
    decisionKind,
  );
  return classification;
}

/**
 * The ops analog of the customer webhook's CATCH arm. Discriminates the throw with
 * the shared `classifyCatchError` and opens an incident only for a genuine drop:
 *
 *   - `timeout`      → its own frozen cause.
 *   - `send_failed`  → the throw happened inside the send.
 *   - `turn_error` PRE-send → mapped INTO the frozen `send_failed` (the BKL-175
 *     never-silent parity both customer planes already apply): the staffer was owed
 *     a reply and the turn died before one left.
 *   - `turn_error` POST-send → NO incident (F2 already-served exclusion): the reply
 *     was delivered, so a later throw did not ghost anyone.
 *
 * Returns whether an incident path ran, so a caller can log honestly.
 */
export async function recordOpsTurnFailure(args: {
  readonly ctx: OpsTurnContext;
  readonly error: unknown;
  /** Set true immediately BEFORE the reply send, false until then. */
  readonly sendEntered: boolean;
  /** Set true immediately AFTER the reply send returns. */
  readonly sendCompleted: boolean;
  /** Did the honest fallback land? */
  readonly fallbackDelivered: boolean;
}): Promise<boolean> {
  const { ctx, error, sendEntered, sendCompleted, fallbackDelivered } = args;
  const cause = classifyCatchError({
    // Neither ops ingress runs a turn-level AbortController; a genuine timeout is
    // still caught by the shared `/timed out/i` message test inside the classifier.
    aborted: false,
    message: error instanceof Error ? error.message : String(error),
    sendEntered,
    sendCompleted,
  });
  if (cause === "turn_error" && sendEntered) return false; // F2: already served.

  await recordOpsDrop(
    ctx,
    cause === "timeout" ? "timeout" : "send_failed",
    !fallbackDelivered,
    `[OPS] ${ctx.channel} turn threw before the staff member was served (${cause}); honest fallback ${
      fallbackDelivered ? "delivered" : "ALSO failed (total silence)"
    }`,
  );
  return true;
}

/**
 * Delivered-reply auto-close for the ops plane — the SAME governed
 * `incident.ticket.close` seam the customer planes use, keyed on the ops session.
 * Idempotent, fail-open, and a fast null when no incident is open.
 *
 * Shared across both ops ingresses on purpose: they are one staff conversation, so
 * a dashboard reply legitimately self-heals a WhatsApp-opened ops incident.
 */
export async function closeOpsIncidentOnDeliveredReply(
  staffId: string,
  deliveredTurnId: string,
  log?: LogFn,
): Promise<void> {
  return closeIncidentOnDeliveredReply(opsSessionId(staffId), deliveredTurnId, log);
}
