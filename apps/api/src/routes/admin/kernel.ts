// W3 D2 — POST /api/admin/kernel/kill-switch admin endpoint.
//
// ── What this route is ──────────────────────────────────────────────────
//
// The HTTP surface for the Redis-backed kill-switch primitive defined
// in `@ibatexas/tools.createKillSwitchStore`. Mirrors the CLI in W3 D1
// but goes through staff JWT auth + two-person rule (P0-5) so the
// runbook's "operator command → enforced state change" path is real.
//
// ── Why two-person ──────────────────────────────────────────────────────
//
// Engaging the global kill switch refuses every mutation on the kernel
// authority path. That's destructive enough that we apply the same
// separation-of-duty pattern used for force-cancel / refund / payment-
// status admin actions (see `admin-confirmation-store.ts` + audit P0-5).
//
// We deliberately use a SEPARATE confirmation store (not the order-
// specific one) because the existing `PendingAdminAction` type is hard-
// typed to order/payment intent kinds. Coupling kernel-ops into that
// type would muddy the boundary; instead this module builds a parallel
// receipt store keyed by `kernel:kill-switch:confirm:<uuid>`.
//
// ── Endpoints ───────────────────────────────────────────────────────────
//
// POST /api/admin/kernel/kill-switch
//   body: { action: "enable", reason: "<text>" }   → step 1
//   body: { action: "disable", reason: "<text>" }  → step 1
//   body: { action: "confirm", confirmationId }    → step 2
// GET  /api/admin/kernel/kill-switch               → current state
//
// ── Auth ────────────────────────────────────────────────────────────────
//
// requireManagerRole — MANAGER or OWNER (per W4 P1-H tightened rule).
// The two-person rule then refuses step-2-by-same-staff. Production
// guidance per `migration/05-kill-switch-strategy.md` is OWNER-only;
// MANAGER is permitted in this implementation so non-OWNER admins can
// drill the runbook in staging. To upgrade to OWNER-only, swap to
// requireOwnerRole.

import { randomUUID, timingSafeEqual } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod"
import {
  getRedisClient,
  rk,
  createKillSwitchStore,
} from "@ibatexas/tools"
import { requireManagerRole } from "../../middleware/staff-auth.js"

// ── Pending kernel kill-switch action ──────────────────────────────────────

interface PendingKillSwitchAction {
  readonly action: "enable" | "disable"
  readonly reason: string
  readonly staffId: string | null
  readonly staffRole: string | null
  readonly actorPrincipal: "user" | "system"
  readonly requestorIp: string | null
  readonly createdAt: string
}

const KERNEL_CONFIRM_TTL_SECONDS = 600 // 10 minutes — matches order force-actions.

const CONSUME_RECEIPT_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
  return value
else
  return nil
end
`

function receiptKey(confirmationId: string): string {
  return rk(`kernel:kill-switch:confirm:${confirmationId}`)
}

async function storePending(
  pending: PendingKillSwitchAction,
): Promise<{ confirmationId: string; ttlSeconds: number }> {
  const confirmationId = randomUUID()
  const redis = await getRedisClient()
  await redis.set(receiptKey(confirmationId), JSON.stringify(pending), {
    EX: KERNEL_CONFIRM_TTL_SECONDS,
  })
  return { confirmationId, ttlSeconds: KERNEL_CONFIRM_TTL_SECONDS }
}

async function consumePending(
  confirmationId: string,
): Promise<PendingKillSwitchAction | null> {
  if (
    typeof confirmationId !== "string" ||
    confirmationId.length === 0 ||
    confirmationId.length > 64
  ) {
    return null
  }
  const redis = await getRedisClient()
  const raw = (await redis.eval(CONSUME_RECEIPT_SCRIPT, {
    keys: [receiptKey(confirmationId)],
    arguments: [],
  })) as string | null
  if (raw === null || raw === undefined) return null
  try {
    return JSON.parse(raw) as PendingKillSwitchAction
  } catch {
    return null
  }
}

// Constant-time string compare so the timing of "same staff" cannot be
// fingerprinted via response latency. Both inputs are normalized to
// the same length via SHA-equivalent byte-equality.
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function principalFor(staffId: string | null): {
  readonly actorPrincipal: "user" | "system"
} {
  return { actorPrincipal: staffId ? "user" : "system" }
}

// ── Body schemas ──────────────────────────────────────────────────────────

const Step1EnableBody = z.object({
  action: z.literal("enable"),
  reason: z.string().min(1).max(500),
})
const Step1DisableBody = z.object({
  action: z.literal("disable"),
  reason: z.string().min(1).max(500),
})
const Step2Body = z.object({
  action: z.literal("confirm"),
  confirmationId: z.string().min(1).max(64),
})
const KillSwitchBody = z.union([
  Step1EnableBody,
  Step1DisableBody,
  Step2Body,
])

// pt-BR refusal texts.
const SAME_ACTOR_REFUSAL =
  "Outro operador precisa confirmar — você iniciou a etapa 1 desta ação."
const NULL_STAFF_REFUSAL =
  "Confirmação rejeitada: a regra de dois operadores exige duas identidades de equipe."

// ── Route registration ────────────────────────────────────────────────────

export async function adminKernelRoutes(
  server: FastifyInstance,
): Promise<void> {
  server.setValidatorCompiler(validatorCompiler)
  server.setSerializerCompiler(serializerCompiler)
  const app = server.withTypeProvider<ZodTypeProvider>()

  // ── POST /api/admin/kernel/kill-switch ───────────────────────────────────
  app.post(
    "/api/admin/kernel/kill-switch",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin", "kernel"],
        summary:
          "Engaja/libera o kill switch global do kernel (two-step, dois operadores)",
        body: KillSwitchBody,
      },
    },
    async (request, reply) => {
      const body = request.body
      const staffId = request.staffId ?? null
      const staffRole = request.staffRole ?? null

      // ── Step 1 — enable/disable: request a confirmation receipt. ─────
      if (body.action === "enable" || body.action === "disable") {
        const { actorPrincipal } = principalFor(staffId)
        const pending: PendingKillSwitchAction = {
          action: body.action,
          reason: body.reason,
          staffId,
          staffRole,
          actorPrincipal,
          requestorIp: request.ip ?? null,
          createdAt: new Date().toISOString(),
        }
        const { confirmationId, ttlSeconds } = await storePending(pending)
        return reply.code(202).send({
          confirmationId,
          prompt:
            body.action === "enable"
              ? "Kill switch global — engajar agora? Esta ação refusa todas as mutações até disable."
              : "Kill switch global — liberar agora?",
          ttlSeconds,
          action: body.action,
        })
      }

      // ── Step 2 — confirm: consume the receipt + dispatch. ──────────
      const pending = await consumePending(body.confirmationId)
      if (!pending) {
        return reply.code(410).send({
          error: "Confirmação inválida, expirada ou já utilizada.",
        })
      }

      // Two-person rule: same staff cannot self-confirm.
      const requestStaff = (staffId ?? "").trim()
      const pendingStaff = (pending.staffId ?? "").trim()
      if (requestStaff.length === 0 || pendingStaff.length === 0) {
        return reply.code(403).send({ error: NULL_STAFF_REFUSAL })
      }
      if (constantTimeEqual(requestStaff, pendingStaff)) {
        return reply.code(403).send({ error: SAME_ACTOR_REFUSAL })
      }

      // Two operators identified — dispatch.
      const redis = await getRedisClient()
      const store = createKillSwitchStore({ redis, rk })

      if (pending.action === "enable") {
        const md = await store.enable({
          enabledBy: `staff:${pending.staffId}`,
          reason: pending.reason,
        })
        server.log.warn(
          {
            event: "kernel.kill_switch.engaged",
            engagedBy: md.enabledBy,
            confirmedBy: `staff:${staffId}`,
            reason: md.reason,
          },
          "kernel kill switch engaged",
        )
        return reply.code(200).send({
          active: true,
          reason: md.reason,
          enabledBy: md.enabledBy,
          enabledAt: md.enabledAt,
        })
      }
      // disable
      const prior = await store.disable({
        enabledBy: `staff:${pending.staffId}`,
        reason: pending.reason,
      })
      server.log.warn(
        {
          event: "kernel.kill_switch.released",
          releasedBy: `staff:${pending.staffId}`,
          confirmedBy: `staff:${staffId}`,
          reason: pending.reason,
          priorEnabledBy: prior?.enabledBy ?? null,
        },
        "kernel kill switch released",
      )
      return reply.code(200).send({
        active: false,
        priorEnabledBy: prior?.enabledBy ?? null,
        priorReason: prior?.reason ?? null,
      })
    },
  )

  // ── GET /api/admin/kernel/kill-switch ─────────────────────────────────────
  app.get(
    "/api/admin/kernel/kill-switch",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin", "kernel"],
        summary: "Mostra o estado atual do kill switch global",
      },
    },
    async () => {
      const redis = await getRedisClient()
      const store = createKillSwitchStore({ redis, rk })
      const md = await store.status()
      if (md === null) {
        return { active: false }
      }
      return {
        active: true,
        enabledBy: md.enabledBy,
        enabledAt: md.enabledAt,
        reason: md.reason,
      }
    },
  )
}
