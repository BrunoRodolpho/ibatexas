// ops-whatsapp-ingress.ts — the WhatsApp owner/staff ingress (BKL-086).
//
// "O dono fala com o gerente pelo WhatsApp": the owner types "acabou a picanha"
// on WhatsApp and the AI manager acts. This is the WhatsApp fork of the SAME ops
// conductor plane the dashboard uses (POST /api/admin/ops/chat) — only the
// ingress + identity binding are new; the conductor, kernel governance, parks,
// and history are all shared by composing the same conductor with the same
// session identity.
//
// SECURITY POSTURE (the ratified BKL-086 design):
//   1. ALLOWLIST = the Staff table. `findStaffByPhone(phone)` is re-read EVERY
//      message (role + active — the STAFFREVOKE analog from middleware/auth.ts).
//      No row OR `active:false` ⇒ fall BACK to the customer path UNCHANGED (never
//      ghost a demoted staffer, never mint an ops actor for a stranger's phone).
//   2. FORK-FIRST. This runs BEFORE resolveWhatsAppSession in the webhook, so an
//      owner command NEVER triggers the customer path's Customer auto-create +
//      welcome credit + LGPD opt-in. A staff-also-customer phone is isolated by
//      fork-first + `staff:{id}` session keying.
//   3. VERB SCOPE. The conductor is composed with `opsVerbScope:"whatsapp"`, which
//      deterministically excludes irreversible money / two-person verbs (the
//      SIM-swap compensating control — see ops-verb-scope.ts). A signed WhatsApp
//      message from a stolen owner phone is legitimate at every technical layer,
//      so v1 advertises REVERSIBLE verbs only; refunds stay dashboard-only.
//   4. IDENTITY = the dashboard's. conversationId `admin:{staffId}`, customerId
//      `staff:{staffId}`, sessionKey `ops:{staffId}`, channel "system", actor
//      {principal:"user", role:"staff", sessionId:`admin:{staffId}`, staffId} —
//      IDENTICAL to routes/admin/ops-chat.ts, so parks/history/confirm-resume are
//      shared across ingresses (a confirm parked on the dashboard is resumable
//      from WhatsApp for IN-SCOPE verbs, and the ops-history thread is keyed by
//      staffId alone — the same durable thread as the dashboard).
//
// The turn reply goes back via the existing kernel-gated sendText (twilioAdjudicated
// egress). A conductor-unavailable / turn failure returns an HONEST pt-BR message
// (mirroring the HTTP route's 503/502 semantics) — never a fabricated success.
//
// The handler is dependency-injected so the crown-jewel e2e can drive a full
// handleTurn against the REAL composed conductor + kernel with fakes; the
// production wiring is `buildOpsWhatsAppIngressDeps`.

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@ibatexas/types";
import { handleTurn, type ChannelMessage, type Conductor } from "@claustrum/core";
import { mintFallbackReply, wrapLegacyResponderText } from "@adjudicate/core";
import { createStaffService } from "@ibatexas/domain";
import type {
  StaffEnvelopeActor,
  StaffEnvelopeRole,
} from "../claustrum/ibatexas-planner.js";
import { getOpsConductorFactory } from "../claustrum-bootstrap.js";
import { acquireAgentLock, releaseAgentLock } from "../whatsapp/session.js";
import { sendText } from "../whatsapp/client.js";
import { appendOpsMessages, buildOpsHistoryBlock } from "./ops-history.js";
import { opsStaleResumeNotice } from "./ops-system-channel.js";
import { excludedKindsForScope } from "./ops-verb-scope.js";
import type { OpsConductorContext } from "./ops-conductor.js";

type LogFn = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

// Honest pt-BR surfaces — mirror the HTTP ops route's 503 / 502 as messages.
const OPS_UNAVAILABLE_PTBR =
  "Canal operacional indisponível no momento. Tente novamente em instantes.";
const OPS_TURN_FAILED_PTBR =
  "Não consegui processar seu comando agora. Tente novamente.";
const OPS_EMPTY_INPUT_PTBR =
  'Não entendi o comando. Envie a instrução em texto (ex.: "86 a picanha").';

/** The minimal Staff-row projection the allowlist gate reads. */
export interface StaffAllowlistRow {
  readonly id: string;
  readonly role: StaffEnvelopeRole;
  readonly active: boolean;
}

/** The outcome of the ops fork: consumed ⇒ never fall through to the customer path. */
export type OpsIngressOutcome =
  | { readonly consumed: false }
  | { readonly consumed: true };

/** Injected collaborators (production wiring: {@link buildOpsWhatsAppIngressDeps}). */
export interface OpsWhatsAppIngressDeps {
  /** Allowlist read — the Staff table, re-read EVERY message (no caching). */
  readonly findStaffByPhone: (phone: string) => Promise<StaffAllowlistRow | null>;
  /** Compose the per-request ops conductor (throws if bootstrap has not run). */
  readonly composeConductor: (
    actor: StaffEnvelopeActor,
    context: OpsConductorContext,
  ) => Conductor;
  /** Acquire the WhatsApp agent lock (phoneHash) — null when already held. */
  readonly acquireLock: (hash: string) => Promise<string | null>;
  readonly releaseLock: (hash: string, value: string) => Promise<void>;
  /** Render the prior-turns ops-history block for this staff thread. */
  readonly loadHistoryBlock: (staffId: string) => Promise<string | undefined>;
  /** Append to the staff's ops-history thread (shared with the dashboard). */
  readonly appendHistory: (staffId: string, messages: AgentMessage[]) => Promise<void>;
  /** Send the turn reply (kernel-gated egress). */
  readonly sendReply: (text: string) => Promise<void>;
  /** Send an honest error surface (branded fallback). */
  readonly sendError: (text: string) => Promise<void>;
}

/**
 * The ops fork. Returns `{consumed:false}` ONLY for a non-staff / inactive phone
 * (the caller then runs the customer path unchanged); any active-staff phone is
 * `{consumed:true}` — handled here (or errored honestly), never the customer path.
 */
export async function handleOpsWhatsAppMessage(
  deps: OpsWhatsAppIngressDeps,
  args: {
    readonly phone: string;
    readonly hash: string;
    readonly text: string;
    readonly log: LogFn;
  },
): Promise<OpsIngressOutcome> {
  const { phone, hash, text, log } = args;

  // 1. Allowlist = the Staff table, re-read EVERY message (role + active). No row
  //    OR inactive ⇒ fall BACK to the customer path (never ghost a demoted staffer).
  //
  //    The fall-back rule EXTENDS to a read ERROR: the fork runs for EVERY inbound
  //    phone, so a Staff-table-specific read failure (with the rest of the stack
  //    healthy) must NOT black out the customer channel with apologies. On a read
  //    error we fail OPEN to the customer path — the phone gains no ops authority
  //    (a genuine owner's command degrades once to the customer persona, which
  //    refuses staff verbs — safe and self-evident). This ONLY covers the allowlist
  //    read; a failure AFTER staff identity is established keeps consuming with the
  //    honest ops apology (runOpsTurn below).
  let staff: StaffAllowlistRow | null;
  try {
    staff = await deps.findStaffByPhone(phone);
  } catch (err) {
    log.warn(
      { event: "ops_wa.allowlist_read_failed", phone_hash: hash, err },
      "[ops-wa] staff allowlist read failed — falling back to the customer path",
    );
    return { consumed: false };
  }
  if (staff === null || !staff.active) {
    return { consumed: false };
  }
  const staffId = staff.id;
  const actor: StaffEnvelopeActor = { staffId, role: staff.role };

  // From here the message is an OPS message: it NEVER reaches the customer path.

  // 2. Empty / blank command (media- or location-only inbound, or whitespace):
  //    consume with an honest nudge rather than falling through (Customer-create
  //    must not fire for a staff phone). v1 does not parse media/interactive on
  //    the ops channel (documented residual).
  const command = text.trim();
  if (command === "") {
    log.info({ phone_hash: hash, staff_id: staffId }, "[ops-wa] empty ops command — nudging");
    await deps.sendError(OPS_EMPTY_INPUT_PTBR).catch(() => {});
    return { consumed: true };
  }

  // 3. Serialize concurrent messages from the same phone via the WhatsApp agent
  //    lock (reused unchanged from the customer path). A held lock ⇒ a concurrent
  //    ops turn is in flight; consume without a second turn. The conductor's own
  //    advisory session lock is the deeper serialization (documented residual: a
  //    rare same-instant second command may be skipped here).
  const lockValue = await deps.acquireLock(hash);
  if (lockValue === null) {
    log.info(
      { phone_hash: hash, staff_id: staffId },
      "[ops-wa] agent lock held — concurrent ops turn in flight; skipping",
    );
    return { consumed: true };
  }

  try {
    await runOpsTurn(deps, { staffId, actor, command, phone, hash, log });
  } finally {
    await deps.releaseLock(hash, lockValue);
  }
  return { consumed: true };
}

/** Run ONE ops turn for a staff WhatsApp message (identity IDENTICAL to the HTTP route). */
async function runOpsTurn(
  deps: OpsWhatsAppIngressDeps,
  ctx: {
    readonly staffId: string;
    readonly actor: StaffEnvelopeActor;
    readonly command: string;
    readonly phone: string;
    readonly hash: string;
    readonly log: LogFn;
  },
): Promise<void> {
  const { staffId, actor, command, hash, log } = ctx;

  // History (best-effort, both appends): render the PRIOR-turns block BEFORE
  // appending the current message (so the live message is the inbound, not a
  // duplicated history line) — mirrors the HTTP route. The staffId key is shared
  // with the dashboard thread, so a WhatsApp turn and a dashboard turn share
  // history. A store failure logs and continues — it must never break the turn.
  const historyBlock = await deps.loadHistoryBlock(staffId);
  try {
    await deps.appendHistory(staffId, [{ role: "user", content: command }]);
  } catch (err) {
    log.warn(err, "[ops-wa] user-message history append failed (non-fatal)");
  }

  // Compose the per-request ops conductor with the AUTHENTICATED identity (never
  // model-derived) + the WHATSAPP verb scope. A missing factory (bootstrap not
  // run) throws → honest "indisponível" (mirror the HTTP route's 503).
  let conductor: Conductor;
  try {
    conductor = deps.composeConductor(actor, {
      ...(historyBlock ? { historyBlock } : {}),
      opsVerbScope: "whatsapp",
    });
  } catch (err) {
    log.error(err, "[ops-wa] ops conductor factory unavailable");
    await deps.sendError(OPS_UNAVAILABLE_PTBR).catch(() => {});
    return;
  }

  const conversationId = `admin:${staffId}`;
  const inbound: ChannelMessage = {
    channel: "system",
    customerId: `staff:${staffId}`,
    conversationId,
    externalId: randomUUID(),
    text: command,
    receivedAt: new Date().toISOString(),
    locale: "pt-BR",
  };

  try {
    const capsule = await conductor.openCapsule({
      channel: "system",
      customerId: `staff:${staffId}`,
      sessionKey: `ops:${staffId}`,
      actor: {
        principal: "user",
        role: "staff",
        sessionId: conversationId,
        staffId,
      },
      inbound,
    });
    try {
      // FE-D13 — honest stale-resume (with BKL-086 parity). Drop the out-of-scope
      // money verbs FIRST (excludedKindsForScope — the SAME set scopeResumeChannel
      // hides from matchToParked), so WhatsApp never restates a dashboard-only park
      // it could not resume; then, if the reply signals a resume of an EXPIRED
      // in-scope park, send the honest expiry restatement instead of running the
      // fresh loop. The turn is SKIPPED on a notice (no turn_trace row) — emit a
      // structured warn for forensics and append the reply to history.
      const pending = capsule.loadedSession?.pendingConfirmations ?? [];
      const staleNotice = opsStaleResumeNotice({
        text: command,
        pendingConfirmations: pending,
        nowIso: inbound.receivedAt,
        excludedKinds: excludedKindsForScope("whatsapp"),
      });
      if (staleNotice !== undefined) {
        log.warn(
          {
            event: "ops_wa.stale_park_notice",
            staff_id: staffId,
            phone_hash: hash,
            pending: pending.length,
          },
          "[ops-wa] stale confirm-park resume — restating expiry, skipping the turn",
        );
        try {
          await deps.appendHistory(staffId, [
            { role: "assistant", content: staleNotice },
          ]);
        } catch (err) {
          log.warn(err, "[ops-wa] stale-notice history append failed (non-fatal)");
        }
        await deps.sendReply(staleNotice);
        return;
      }

      const turn = await handleTurn(capsule, inbound);
      // Persist the assistant reply AFTER a successful turn (best-effort).
      try {
        await deps.appendHistory(staffId, [
          { role: "assistant", content: turn.response.text },
        ]);
      } catch (err) {
        log.warn(err, "[ops-wa] assistant-reply history append failed (non-fatal)");
      }
      const replyText = turn.response.text ?? "";
      if (replyText.trim().length > 0) {
        await deps.sendReply(replyText);
      } else {
        // The ops responder always produces staff-facing text; a blank completion
        // would ghost the owner — send the honest fallback instead of silence.
        log.warn(
          { phone_hash: hash, staff_id: staffId, decision: turn.decision.kind },
          "[ops-wa] empty ops completion — sending fallback",
        );
        await deps.sendError(OPS_TURN_FAILED_PTBR).catch(() => {});
      }
    } finally {
      await conductor.closeCapsule(capsule);
    }
  } catch (err) {
    // Never fabricate success: an honest 502-equivalent pt-BR message.
    log.error(err, "[ops-wa] ops conductor turn failed");
    await deps.sendError(OPS_TURN_FAILED_PTBR).catch(() => {});
  }
}

/**
 * Production wiring: bind the injected collaborators to the real Staff service,
 * ops conductor factory, WhatsApp agent lock, ops-history store, and the
 * kernel-gated sendText (branded via the same minters the customer path uses).
 */
export function buildOpsWhatsAppIngressDeps(
  phone: string,
  log: LogFn,
): OpsWhatsAppIngressDeps {
  void log;
  const to = `whatsapp:${phone}`;
  return {
    findStaffByPhone: async (p) => {
      const staff = await createStaffService().findByPhone(p);
      return staff === null
        ? null
        : { id: staff.id, role: staff.role as StaffEnvelopeRole, active: staff.active };
    },
    composeConductor: (actor, context) => getOpsConductorFactory()(actor, context),
    acquireLock: (h) => acquireAgentLock(h),
    releaseLock: (h, v) => releaseAgentLock(h, v),
    loadHistoryBlock: (staffId) => buildOpsHistoryBlock(staffId),
    appendHistory: (staffId, messages) => appendOpsMessages(staffId, messages),
    sendReply: (text) => sendText(to, wrapLegacyResponderText(text)),
    sendError: (text) => sendText(to, mintFallbackReply(text)),
  };
}
