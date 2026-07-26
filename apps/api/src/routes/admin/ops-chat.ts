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
  appendOpsMessages,
  buildOpsHistoryBlock,
  loadOpsHistory,
} from "../../ops/ops-history.js";
import {
  OPS_NEGATIVE_DECLINE_ACK_PTBR,
  opsNegativeDeclineTarget,
  opsSoftAffirmativeRestateNotice,
  opsStaleResumeNotice,
  pruneExpiredOpsParks,
} from "../../ops/ops-system-channel.js";

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
      const inbound: ChannelMessage = {
        channel: "system",
        customerId: `staff:${staffId}`,
        conversationId,
        externalId: randomUUID(),
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

      try {
        // FE-D13 — honest stale-resume. If this reply signals a resume of an ops
        // confirm that has EXPIRED (older than OPS_CONFIRM_PARK_TTL_SECONDS — already
        // invisible to matchToParked), restate that the pending confirmation expired
        // and was NOT executed instead of silently running the fresh loop. A still-
        // fresh park the reply resumes takes precedence (handled inside). The turn is
        // SKIPPED on a notice, so no turn_trace/intent_audit row is written — emit a
        // structured warn for forensics and append the reply to history.
        const pending = capsule.loadedSession?.pendingConfirmations ?? [];
        const staleNotice = opsStaleResumeNotice({
          text: message,
          pendingConfirmations: pending,
          nowIso: inbound.receivedAt,
        });
        if (staleNotice !== undefined) {
          // FE-D33 — prune the now-inert expired parks from the session (hygiene;
          // the FE-D13 partition is the enforcement point, so a prune failure is
          // non-fatal). capsule.session.unpark is the sanctioned durable mutation;
          // the Conductor re-reads on close, so this sticks.
          let pruned = 0;
          if (capsule.loadedSession) {
            try {
              pruned = (
                await pruneExpiredOpsParks({
                  session: capsule.session,
                  sessionId: capsule.loadedSession.id,
                  pendingConfirmations: pending,
                  nowIso: inbound.receivedAt,
                })
              ).length;
            } catch (err) {
              request.log.warn(err, "[ops-chat] expired-park prune failed (non-fatal)");
            }
          }
          request.log.warn(
            {
              event: "ops_chat.stale_park_notice",
              staff_id: staffId,
              pending: pending.length,
              pruned,
            },
            "[ops-chat] stale confirm-park resume — restating expiry, pruning zombies, skipping the turn",
          );
          try {
            await appendOpsMessages(staffId, [
              { role: "assistant", content: staleNotice },
            ]);
          } catch (err) {
            request.log.warn(err, "[ops-chat] stale-notice history append failed (non-fatal)");
          }
          return reply.send({
            reply: staleNotice,
            decision: "STALE_PARK_EXPIRED",
            executed: false,
            proposedKinds: [],
          });
        }

        // FE-D32 — a bare SOFT affirmative ("pode"/"ok"/…) aimed at a still-FRESH
        // park is too weak to EXECUTE: restate the parked action and ask for an
        // explicit "sim"/"confirmo". Do NOT prune/unpark — the fresh park survives
        // so a follow-up "sim" executes it. The turn is SKIPPED (no turn_trace row).
        const softRestate = opsSoftAffirmativeRestateNotice({
          text: message,
          pendingConfirmations: pending,
          nowIso: inbound.receivedAt,
        });
        if (softRestate !== undefined) {
          request.log.warn(
            {
              event: "ops_chat.soft_affirm_restate",
              staff_id: staffId,
              pending: pending.length,
            },
            "[ops-chat] soft affirmative on a fresh park — restating, awaiting explicit confirm, skipping the turn",
          );
          try {
            await appendOpsMessages(staffId, [
              { role: "assistant", content: softRestate },
            ]);
          } catch (err) {
            request.log.warn(err, "[ops-chat] soft-restate history append failed (non-fatal)");
          }
          return reply.send({
            reply: softRestate,
            decision: "SOFT_AFFIRM_RESTATE",
            executed: false,
            proposedKinds: [],
          });
        }

        // BKL-191 — a PURE-negative reply ("não, cancela essa ação") on a fresh
        // park DECLINES it at the ingress: unpark + acknowledge, and SKIP the
        // turn so the negative text never reaches the planner (claustrum's own
        // deny path unparks but then re-plans the "no" as a fresh command — the
        // live re-prompt). Fail-honest: if the unpark fails, fall through to the
        // normal loop (claustrum's deny still unparks there) rather than claim
        // a cancellation that did not stick.
        const declineTarget = opsNegativeDeclineTarget({
          text: message,
          pendingConfirmations: pending,
          nowIso: inbound.receivedAt,
        });
        if (declineTarget !== undefined && capsule.loadedSession) {
          let unparked = false;
          try {
            await capsule.session.unpark(
              capsule.loadedSession.id,
              declineTarget.envelope.intentHash,
            );
            unparked = true;
          } catch (err) {
            request.log.warn(
              err,
              "[ops-chat] negative-decline unpark failed — falling through to the normal loop (BKL-191)",
            );
          }
          if (unparked) {
            request.log.warn(
              {
                event: "ops_chat.negative_declined_park",
                staff_id: staffId,
                kind: String(declineTarget.envelope.kind),
              },
              "[ops-chat] negative reply on a fresh park — declined + unparked, skipping the turn (BKL-191)",
            );
            try {
              await appendOpsMessages(staffId, [
                { role: "assistant", content: OPS_NEGATIVE_DECLINE_ACK_PTBR },
              ]);
            } catch (err) {
              request.log.warn(err, "[ops-chat] decline-ack history append failed (non-fatal)");
            }
            return reply.send({
              reply: OPS_NEGATIVE_DECLINE_ACK_PTBR,
              decision: "NEGATIVE_DECLINED_PARK",
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
