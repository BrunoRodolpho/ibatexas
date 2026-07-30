// admin/ops-chat.ts — the ops-actor ingress (NEW-032 slice B): the staff
// "run the restaurant by message" channel goes live.
//
//   POST /api/admin/ops/chat  { message }  → { reply, decision, executed, proposedKinds }
//
// Behind `requireStaff` (JWT-only — no API-key conversational actor). The route
// captures {staffId, staffRole} from the JWT, composes the OPS conductor for the
// turn (getOpsConductorFactory — the H1 per-request recomposition), opens a
// "system"-channel capsule whose actor is `admin:${staffId}` + role, runs one
// kernel-gated turn, and returns the reply synchronously (no SSE in v1).
//
// Layered role enforcement (defense in depth): route preHandler
// (authentication) → capability planner (advertisement, staff-gated) →
// staffRoleGuard + the staff-role matrix (kernel authorization) → per-kind pack
// guards. A conductor throw returns an honest 502 with a pt-BR message — never a
// fabricated success.
//
// v1 posture: a REQUEST_CONFIRMATION surfaces the kernel prompt honestly and
// resolution is out-of-band (no conversational confirm-resume on this channel
// yet — a registered follow-up).
//
// BKL-084 — conversation history. This channel now persists a per-staff thread on
// its OWN OPS-namespaced Redis list (never the customer chat store) and threads a
// BOUNDED, DATA-fenced history block into the planner system prompt so anaphora
// ("e o brisket?") resolves. History is prompt CONTEXT only — the envelope/actor/
// adjudication path is untouched. Both appends are best-effort: a store failure
// logs and continues (it must never break the turn).
//   GET /api/admin/ops/chat/history  → the caller's persisted thread (UI hydrate).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { handleTurn, type ChannelMessage } from "@claustrum/core";
import { beginWireTurn } from "../../claustrum/wire-capture.js";
import { requireStaff } from "../../middleware/staff-auth.js";
import { getOpsConductorFactory } from "../../claustrum-bootstrap.js";
import {
  opsParkTriagePolicy,
  triageParkReply,
  unparkParks,
  type ParkTriageBranch,
} from "../../claustrum/park-reply-triage.js";
import {
  appendOpsMessages,
  buildOpsHistoryBlock,
  loadOpsHistory,
} from "../../ops/ops-history.js";
import {
  OPS_DASHBOARD_CHANNEL,
  closeOpsIncidentOnDeliveredReply,
  recordOpsTurnDelivery,
} from "../../ops/ops-turn-incident.js";

/** The structured-event namespace this SURFACE stamps on a triage verdict. */
const OPS_CHAT_TRIAGE_EVENT_PREFIX = "ops_chat";

/** The `decision` code each triage branch reports on this route's HTTP contract.
 *  Surface-owned (the dashboard's response shape), not part of the decision. */
const OPS_CHAT_TRIAGE_DECISION: Readonly<Record<ParkTriageBranch, string>> = {
  "stale-resume": "STALE_PARK_EXPIRED",
  "soft-affirmative-restate": "SOFT_AFFIRM_RESTATE",
  "negative-decline": "NEGATIVE_DECLINED_PARK",
};

/** Per-branch non-fatal warn for a failed triage-notice history append. */
const OPS_CHAT_TRIAGE_APPEND_FAILED: Readonly<Record<ParkTriageBranch, string>> = {
  "stale-resume": "[ops-chat] stale-notice history append failed (non-fatal)",
  "soft-affirmative-restate":
    "[ops-chat] soft-restate history append failed (non-fatal)",
  "negative-decline": "[ops-chat] decline-ack history append failed (non-fatal)",
};

const OpsChatBody = z.object({
  message: z
    .string({ error: "Informe uma mensagem." })
    .trim()
    .min(1, "A mensagem não pode estar vazia.")
    .max(2000, "A mensagem é muito longa (máximo 2000 caracteres)."),
});

/** Was a mutation actually committed this turn? (dispatch matrix — handleTurn). */
function wasExecuted(acted: { kind?: string } | undefined): boolean {
  const kind = acted?.kind;
  return (
    kind === "executed" ||
    kind === "rewritten_and_executed" ||
    kind === "executed_plan"
  );
}

export async function adminOpsChatRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/admin/ops/chat",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Canal operacional do agente (comandar por mensagem)",
        body: OpsChatBody,
      },
    },
    async (request, reply) => {
      // requireStaff guarantees both are set (JWT-only); narrow for TS + a
      // belt-and-suspenders fail-closed if the guard is ever bypassed.
      const staffId = request.staffId;
      const staffRole = request.staffRole;
      if (!staffId || !staffRole) {
        return reply.code(403).send({ error: "Acesso restrito a funcionários." });
      }

      const { message } = request.body;
      const conversationId = `admin:${staffId}`;
      // BKL-235 — the per-inbound ref doubles as the incident dedup key, mirroring
      // the customer webhook's `body.MessageSid`.
      const turnRef = randomUUID();
      const inbound: ChannelMessage = {
        channel: "system",
        customerId: `staff:${staffId}`,
        conversationId,
        externalId: turnRef,
        text: message,
        receivedAt: new Date().toISOString(),
        locale: "pt-BR",
      };

      // Render the PRIOR-turns context block BEFORE appending the current message
      // (so the live message is the inbound, not a duplicated history line). Then
      // persist the user message. Both are best-effort — never break the turn.
      const historyBlock = await buildOpsHistoryBlock(staffId);
      try {
        await appendOpsMessages(staffId, [{ role: "user", content: message }]);
      } catch (err) {
        request.log.warn(err, "[ops-chat] user-message history append failed (non-fatal)");
      }

      // Compose the per-request ops conductor with the AUTHENTICATED identity
      // (never model-derived) and the per-request history context. A missing
      // factory (bootstrap not run) throws — a 500-class server error, surfaced
      // honestly below.
      let conductor;
      try {
        conductor = getOpsConductorFactory()(
          { staffId, role: staffRole },
          { ...(historyBlock ? { historyBlock } : {}) },
        );
      } catch (err) {
        request.log.error(err, "[ops-chat] ops conductor factory unavailable");
        return reply.code(503).send({
          error: "Canal operacional indisponível no momento.",
        });
      }

      const capsule = await conductor.openCapsule({
        channel: "system",
        customerId: `staff:${staffId}`,
        // The entity-scoped serialization domain (the conductor's default lock
        // key ignores sessionKey; it still feeds actor.sessionId / TenantResolver).
        sessionKey: `ops:${staffId}`,
        actor: {
          principal: "user",
          role: "staff",
          sessionId: conversationId,
          staffId,
        },
        inbound,
      });

      /**
       * BKL-235 — every DELIVERED dashboard reply is recovery proof for an OPEN ops
       * incident on this staff conversation, INCLUDING one opened from the WhatsApp
       * ingress: both ingresses share `sessionId = admin:<staffId>`, so they are one
       * conversation with two surfaces. Detached + fail-open + idempotent so it never
       * gates the HTTP response — the same idiom the web chat seam uses.
       */
      const healOnDeliveredReply = (text: string): void => {
        if (text.trim().length > 0 && capsule.turnId) {
          void closeOpsIncidentOnDeliveredReply(
            staffId,
            capsule.turnId,
            request.log,
          ).catch(() => {});
        }
      };

      try {
        // ── PARK-REPLY TRIAGE (R4-S1) ────────────────────────────────────────
        // ONE decision, owned by ../../claustrum/park-reply-triage.ts:
        // stale-resume (FE-D13) → soft-affirmative restate (FE-D32) →
        // pure-negative decline (BKL-191) → run the turn. The branch ORDER and the
        // fail-honest unpark contract are documented there, once. The dashboard
        // declares the OPS policy with NO verb-scope exclusion (unlike the WhatsApp
        // surface, it may resume every ops kind). A skip-with-reply verdict SKIPS
        // the turn, so no turn_trace/intent_audit row is written — this ingress
        // emits the verdict's structured event for forensics, appends the reply to
        // history, and maps the branch onto its own HTTP `decision` code.
        const pending = capsule.loadedSession?.pendingConfirmations ?? [];
        const triage = triageParkReply({
          text: message,
          pendingConfirmations: pending,
          nowIso: inbound.receivedAt,
          policy: opsParkTriagePolicy({
            eventPrefix: OPS_CHAT_TRIAGE_EVENT_PREFIX,
          }),
        });
        if (triage.kind === "skip-with-reply") {
          // FE-D33 — prune the now-inert expired parks the verdict names (hygiene;
          // the freshness partition is the enforcement point, so a prune failure is
          // non-fatal). capsule.session.unpark is the sanctioned durable mutation;
          // the Conductor re-reads on close, so this sticks.
          let pruned = 0;
          if (triage.prune.length > 0 && capsule.loadedSession) {
            try {
              pruned = (
                await unparkParks({
                  session: capsule.session,
                  sessionId: capsule.loadedSession.id,
                  parks: triage.prune,
                })
              ).length;
            } catch (err) {
              request.log.warn(err, "[ops-chat] expired-park prune failed (non-fatal)");
            }
          }

          // The verdict's `unpark` is LOAD-BEARING: the decline acknowledgment
          // asserts the pending action was cancelled, so it may only be sent once
          // the unpark STUCK. Fail-honest — a failure falls through to the normal
          // loop (claustrum's deny still unparks there) rather than claiming a
          // cancellation that did not stick.
          let deliverNotice = true;
          if (triage.unpark.length > 0) {
            deliverNotice = false;
            if (capsule.loadedSession) {
              try {
                await unparkParks({
                  session: capsule.session,
                  sessionId: capsule.loadedSession.id,
                  parks: triage.unpark,
                });
                deliverNotice = true;
              } catch (err) {
                request.log.warn(
                  err,
                  "[ops-chat] negative-decline unpark failed — falling through to the normal loop (BKL-191)",
                );
              }
            }
          }

          if (deliverNotice) {
            switch (triage.branch) {
              case "stale-resume":
                request.log.warn(
                  {
                    event: triage.event,
                    staff_id: staffId,
                    pending: pending.length,
                    pruned,
                  },
                  "[ops-chat] stale confirm-park resume — restating expiry, pruning zombies, skipping the turn",
                );
                break;
              case "soft-affirmative-restate":
                request.log.warn(
                  {
                    event: triage.event,
                    staff_id: staffId,
                    pending: pending.length,
                  },
                  "[ops-chat] soft affirmative on a fresh park — restating, awaiting explicit confirm, skipping the turn",
                );
                break;
              case "negative-decline":
                request.log.warn(
                  {
                    event: triage.event,
                    staff_id: staffId,
                    kind: String(triage.unpark[0]!.envelope.kind),
                  },
                  "[ops-chat] negative reply on a fresh park — declined + unparked, skipping the turn (BKL-191)",
                );
                break;
            }
            try {
              await appendOpsMessages(staffId, [
                { role: "assistant", content: triage.notice },
              ]);
            } catch (err) {
              request.log.warn(err, OPS_CHAT_TRIAGE_APPEND_FAILED[triage.branch]);
            }
            healOnDeliveredReply(triage.notice);
            return reply.send({
              reply: triage.notice,
              decision: OPS_CHAT_TRIAGE_DECISION[triage.branch],
              executed: false,
              proposedKinds: [],
            });
          }
        }

        const turn = await beginWireTurn(() => handleTurn(capsule, inbound));
        // Persist the assistant reply AFTER a successful turn (best-effort).
        try {
          await appendOpsMessages(staffId, [
            { role: "assistant", content: turn.response.text },
          ]);
        } catch (err) {
          request.log.warn(err, "[ops-chat] assistant-reply history append failed (non-fatal)");
        }
        const replyText = turn.response.text ?? "";
        healOnDeliveredReply(replyText);
        // BKL-235 — the governed ops incident. `fallbackDelivered:false` because
        // this route has NO honest error surface for a blank completion: it returns
        // 200 with an empty `reply`, so the staffer gets a blank bubble and nothing
        // else. That is a genuine ghost (`customerImpacted:true`), and it is why the
        // dashboard needs the journal as much as WhatsApp does. The response contract
        // is deliberately UNCHANGED — this adds the durable record, not a new surface.
        await recordOpsTurnDelivery({
          ctx: {
            staffId,
            channel: OPS_DASHBOARD_CHANNEL,
            turnId: capsule.turnId,
            messageRef: turnRef,
            // No addressable channel + no phone in scope on the dashboard ingress.
            senderRef: null,
            phoneHash: null,
            log: request.log,
          },
          replyText,
          replyDelivered: replyText.trim().length > 0,
          fallbackDelivered: false,
          decisionKind: turn.decision.kind,
        });
        return reply.send({
          reply: turn.response.text,
          decision: turn.decision.kind,
          executed: wasExecuted(turn.acted),
          proposedKinds: turn.plan.envelopes.map((e) => String(e.kind)),
        });
      } catch (err) {
        // Never fabricate success: an honest 502 with a pt-BR message.
        request.log.error(err, "[ops-chat] ops conductor turn failed");
        return reply.code(502).send({
          error: "Não consegui processar seu comando agora. Tente novamente.",
        });
      } finally {
        await conductor.closeCapsule(capsule);
      }
    },
  );

  // GET /api/admin/ops/chat/history — the caller's persisted ops thread, so the
  // admin UI can hydrate on reload. Scoped to the AUTHENTICATED staffId (never a
  // query param) — a manager only ever reads their own thread. Read-only; a store
  // failure yields an empty thread rather than a 5xx (best-effort hydrate).
  app.get(
    "/api/admin/ops/chat/history",
    {
      preHandler: [requireStaff],
      schema: {
        tags: ["admin"],
        summary: "Histórico do canal operacional do agente (para o funcionário atual)",
      },
    },
    async (request, reply) => {
      const staffId = request.staffId;
      if (!staffId) {
        return reply.code(403).send({ error: "Acesso restrito a funcionários." });
      }
      let messages: Array<{ role: string; content: string }> = [];
      try {
        messages = (await loadOpsHistory(staffId)).map((m) => ({
          role: m.role,
          content: m.content,
        }));
      } catch (err) {
        request.log.warn(err, "[ops-chat] history read failed (returning empty)");
      }
      return reply.send({ messages, count: messages.length });
    },
  );
}
