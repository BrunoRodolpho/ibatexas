// Admin staff-administration routes (AUT-038 staff CRUD + AUT-007 role assign).
//
// GET  /api/admin/staff              — list staff (paginated; carries pay data)
// POST /api/admin/staff              — create (or reactivate an inactive phone)
// PATCH /api/admin/staff/:id         — update name / phone / hourly rate (NOT role)
// POST /api/admin/staff/:id/deactivate — soft-deactivate (active = false)
// POST /api/admin/staff/:id/role     — assign role (privilege escalation)
//
// ── Governance ────────────────────────────────────────────────────────────
//
// EVERY route (GET included) is `requireOwnerRole`: this is the staff-
// ADMINISTRATION surface carrying `hourlyRateCentavos` pay data and privilege
// grants. Manager-facing shift views live elsewhere (schedule-shifts.ts).
//
// The four mutations route through `StaffCommandService.*FromEnvelope` against
// `staffCommandPolicyBundle` (TRUSTED taint floor). The service is constructed
// with `authGuards: [staffRoleGuard]` (BKL-074) so the OWNER role band is
// re-established at the kernel, not only by the preHandler. The envelope carries:
//   - actor.principal = "user" (staff JWT) | "system" (API key)
//   - taint           = "TRUSTED" | "SYSTEM"
//   - sessionId       = `admin:{staffId}` | `admin:api-key`
// The service derives the acting staffId from the sessionId for the
// self-mutation guard (API-key callers have no staffId → self-check skipped;
// the unconditional last-owner guard keeps lockout impossible either way).
//
// Kinds are HTTP-plane-only — absent from every planner / roster / claim
// surface. No LLM/agent caller.

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { ZodTypeProvider } from "fastify-type-provider-zod"
import { z } from "zod"
import { buildEnvelope } from "@adjudicate/core"
import {
  createStaffCommandService,
  DuplicatePhoneError,
  InvalidHourlyRateError,
  InvalidStaffPhoneError,
  InvalidStaffRoleError,
  LastOwnerError,
  RoleUpdateForbiddenError,
  SelfMutationError,
  StaffMutationConflictError,
  StaffNotFoundError,
  toE164BR,
  type StaffCreatePayload,
  type StaffDeactivatePayload,
  type StaffRoleAssignPayload,
  type StaffUpdatePayload,
} from "@ibatexas/domain"
import { getAuditSink } from "@ibatexas/audit-sink"
import { requireOwnerRole } from "../../middleware/staff-auth.js"
import { staffRoleGuard } from "../../claustrum/staff-role-guard.js"
import { actorFor, kernelRefusalText, resolveActorRole } from "./_shared-actions.js"

const StaffRoleEnum = z.enum(["OWNER", "MANAGER", "ATTENDANT"])
const StaffIdParams = z.object({ id: z.string().min(1) })

/**
 * CANONICAL E.164 at the zod layer (FIX 3): normalizes formatted input
 * ("+55 11 99999-9999" → "+5511999999999") via the SAME `toE164BR` the login
 * lookup path relies on, and 400s anything unnormalizable. The service
 * re-normalizes defensively; this schema makes the route contract canonical.
 */
const CanonicalPhoneSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    try {
      return toE164BR(value)
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Telefone inválido — use formato internacional: +5511999999999",
      })
      return z.NEVER
    }
  })

const ListStaffQuery = z.object({
  role: StaffRoleEnum.optional(),
  // Explicit "true"/"false" parse — NOT z.coerce.boolean(), which maps any
  // non-empty string (incl. "false") to true.
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

const CreateStaffBody = z.object({
  phone: CanonicalPhoneSchema,
  name: z.string().min(1),
  role: StaffRoleEnum.optional().default("ATTENDANT"),
  hourlyRateCentavos: z.number().int().min(0).nullable().optional(),
})

// `.strict()` REJECTS a `role` (or `active`) field: a role change is privilege
// escalation and must ride POST /:id/role, not this partial edit.
const UpdateStaffBody = z
  .object({
    name: z.string().min(1).optional(),
    phone: CanonicalPhoneSchema.optional(),
    hourlyRateCentavos: z.number().int().min(0).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: "Informe ao menos um campo para atualizar.",
  })

const AssignRoleBody = z.object({ role: StaffRoleEnum })

/** Map a StaffCommandService typed error to its pt-BR HTTP reply, or null. */
function staffErrorReply(
  err: unknown,
): { readonly code: number; readonly error: string } | null {
  if (err instanceof StaffNotFoundError) {
    return { code: 404, error: "Funcionário não encontrado." }
  }
  if (err instanceof DuplicatePhoneError) {
    // FIX 6a: on UPDATE the colliding row may be INACTIVE — never assert "ativo".
    return {
      code: 409,
      error: `Já existe um funcionário com o telefone "${err.phone}".`,
    }
  }
  if (err instanceof LastOwnerError) {
    return {
      code: 409,
      error:
        "Não é possível desativar ou rebaixar o último proprietário ativo. Promova outro proprietário antes.",
    }
  }
  if (err instanceof StaffMutationConflictError) {
    // FIX 2: Serializable write-conflict persisted past the retry — safe to re-issue.
    return {
      code: 409,
      error:
        "Outra alteração de funcionários foi aplicada ao mesmo tempo. Tente novamente.",
    }
  }
  if (err instanceof SelfMutationError) {
    return {
      code: 403,
      error: "Você não pode desativar ou alterar o seu próprio acesso.",
    }
  }
  if (err instanceof RoleUpdateForbiddenError) {
    return {
      code: 400,
      error:
        "Alteração de nível de acesso não é permitida aqui — use a rota de atribuição de cargo.",
    }
  }
  if (err instanceof InvalidStaffPhoneError) {
    return {
      code: 400,
      error: "Telefone inválido. Use o formato E.164 (ex: +5511999999999).",
    }
  }
  if (err instanceof InvalidStaffRoleError) {
    return { code: 400, error: "Nível de acesso inválido." }
  }
  if (err instanceof InvalidHourlyRateError) {
    return {
      code: 400,
      error: "Valor de remuneração inválido (use centavos inteiros ≥ 0).",
    }
  }
  return null
}

/** Envelope actor fields derived from the authenticated request. */
function actorFields(request: {
  staffId?: string | null
  staffRole?: "OWNER" | "MANAGER" | "ATTENDANT"
  adminApiKeyRole?: "OWNER" | "MANAGER"
}) {
  const staffId = request.staffId ?? null
  const principal: "user" | "system" = staffId ? "user" : "system"
  const taint: "TRUSTED" | "SYSTEM" = staffId ? "TRUSTED" : "SYSTEM"
  const sessionId = staffId ? `admin:${staffId}` : "admin:api-key"
  const role = resolveActorRole(request)
  return { principal, taint, sessionId, role }
}

export async function adminStaffRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>()

  // Defer audit-sink resolution to onReady (see reservations.ts / payments.ts
  // for the boot-order rationale). Inject `staffRoleGuard` (BKL-074) so the
  // OWNER band is enforced at the kernel on the command-service path.
  let svc!: ReturnType<typeof createStaffCommandService>
  server.addHook("onReady", async () => {
    svc = createStaffCommandService({
      auditSink: getAuditSink(),
      log: server.log,
      authGuards: [staffRoleGuard],
    })
  })

  /** Shared non-EXECUTE kernel refusal → 403 for the mutation routes. */
  function kernelRefusal(
    reply: FastifyReply,
    decision: { readonly kind: string; readonly refusal?: { readonly userFacing: string } },
  ) {
    return reply.code(403).send({ error: kernelRefusalText(decision) })
  }

  // GET /api/admin/staff — list (OWNER-only; carries pay data)
  app.get(
    "/api/admin/staff",
    {
      preHandler: requireOwnerRole,
      schema: {
        tags: ["admin"],
        summary: "Listar funcionários (admin — proprietário)",
        querystring: ListStaffQuery,
      },
    },
    async (request, reply) => {
      const { role, active, limit, offset } = request.query as z.infer<
        typeof ListStaffQuery
      >
      try {
        const result = await svc.list({
          ...(role ? { role } : {}),
          ...(active !== undefined ? { active } : {}),
          limit,
          offset,
        })
        return reply.send({ staff: result.staff, total: result.total })
      } catch (err) {
        server.log.error(err, "Failed to list staff")
        return reply.code(500).send({ error: "Falha ao listar os funcionários." })
      }
    },
  )

  // POST /api/admin/staff — create (or reactivate an inactive phone)
  app.post(
    "/api/admin/staff",
    {
      preHandler: requireOwnerRole,
      schema: {
        tags: ["admin"],
        summary: "Criar funcionário (admin — proprietário)",
        body: CreateStaffBody,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateStaffBody>
      const { principal, taint, sessionId, role } = actorFields(request)
      const payload: StaffCreatePayload = {
        phone: body.phone,
        name: body.name,
        role: body.role,
        ...(body.hourlyRateCentavos !== undefined
          ? { hourlyRateCentavos: body.hourlyRateCentavos }
          : {}),
      }
      const envelope = buildEnvelope<"staff.create", StaffCreatePayload>({
        kind: "staff.create",
        payload,
        nonce: randomUUID(),
        actor: actorFor({ principal, sessionId, role }),
        taint,
      })
      try {
        const outcome = await svc.createFromEnvelope(envelope, { ctx: {} })
        if (
          outcome.decision.kind !== "EXECUTE" &&
          outcome.decision.kind !== "REWRITE"
        ) {
          return kernelRefusal(reply, outcome.decision)
        }
        return reply.code(201).send({ staff: outcome.result })
      } catch (err) {
        const mapped = staffErrorReply(err)
        if (mapped) return reply.code(mapped.code).send({ error: mapped.error })
        server.log.error(err, "Failed to create staff")
        return reply.code(500).send({ error: "Falha ao criar o funcionário." })
      }
    },
  )

  // PATCH /api/admin/staff/:id — update name / phone / hourly rate (NOT role)
  app.patch(
    "/api/admin/staff/:id",
    {
      preHandler: requireOwnerRole,
      schema: {
        tags: ["admin"],
        summary: "Atualizar funcionário (admin — proprietário)",
        params: StaffIdParams,
        body: UpdateStaffBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof StaffIdParams>
      const body = request.body as z.infer<typeof UpdateStaffBody>
      const { principal, taint, sessionId, role } = actorFields(request)
      const payload: StaffUpdatePayload = {
        staffId: id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.hourlyRateCentavos !== undefined
          ? { hourlyRateCentavos: body.hourlyRateCentavos }
          : {}),
      }
      const envelope = buildEnvelope<"staff.update", StaffUpdatePayload>({
        kind: "staff.update",
        payload,
        nonce: randomUUID(),
        actor: actorFor({ principal, sessionId, role }),
        taint,
      })
      try {
        const outcome = await svc.updateFromEnvelope(envelope, { ctx: {} })
        if (
          outcome.decision.kind !== "EXECUTE" &&
          outcome.decision.kind !== "REWRITE"
        ) {
          return kernelRefusal(reply, outcome.decision)
        }
        return reply.send({ staff: outcome.result })
      } catch (err) {
        const mapped = staffErrorReply(err)
        if (mapped) return reply.code(mapped.code).send({ error: mapped.error })
        server.log.error(err, "Failed to update staff")
        return reply.code(500).send({ error: "Falha ao atualizar o funcionário." })
      }
    },
  )

  // POST /api/admin/staff/:id/deactivate — soft-deactivate (active = false)
  app.post(
    "/api/admin/staff/:id/deactivate",
    {
      preHandler: requireOwnerRole,
      schema: {
        tags: ["admin"],
        summary: "Desativar funcionário (admin — proprietário)",
        params: StaffIdParams,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof StaffIdParams>
      const { principal, taint, sessionId, role } = actorFields(request)
      const payload: StaffDeactivatePayload = { staffId: id }
      const envelope = buildEnvelope<"staff.deactivate", StaffDeactivatePayload>({
        kind: "staff.deactivate",
        payload,
        nonce: randomUUID(),
        actor: actorFor({ principal, sessionId, role }),
        taint,
      })
      try {
        const outcome = await svc.deactivateFromEnvelope(envelope, { ctx: {} })
        if (
          outcome.decision.kind !== "EXECUTE" &&
          outcome.decision.kind !== "REWRITE"
        ) {
          return kernelRefusal(reply, outcome.decision)
        }
        return reply.send({ staff: outcome.result })
      } catch (err) {
        const mapped = staffErrorReply(err)
        if (mapped) return reply.code(mapped.code).send({ error: mapped.error })
        server.log.error(err, "Failed to deactivate staff")
        return reply.code(500).send({ error: "Falha ao desativar o funcionário." })
      }
    },
  )

  // POST /api/admin/staff/:id/role — assign role (privilege escalation)
  app.post(
    "/api/admin/staff/:id/role",
    {
      preHandler: requireOwnerRole,
      schema: {
        tags: ["admin"],
        summary: "Atribuir cargo ao funcionário (admin — proprietário)",
        params: StaffIdParams,
        body: AssignRoleBody,
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof StaffIdParams>
      const body = request.body as z.infer<typeof AssignRoleBody>
      const { principal, taint, sessionId, role } = actorFields(request)
      const payload: StaffRoleAssignPayload = { staffId: id, role: body.role }
      const envelope = buildEnvelope<"staff.role.assign", StaffRoleAssignPayload>({
        kind: "staff.role.assign",
        payload,
        nonce: randomUUID(),
        actor: actorFor({ principal, sessionId, role }),
        taint,
      })
      try {
        const outcome = await svc.assignRoleFromEnvelope(envelope, { ctx: {} })
        if (
          outcome.decision.kind !== "EXECUTE" &&
          outcome.decision.kind !== "REWRITE"
        ) {
          return kernelRefusal(reply, outcome.decision)
        }
        return reply.send({ staff: outcome.result })
      } catch (err) {
        const mapped = staffErrorReply(err)
        if (mapped) return reply.code(mapped.code).send({ error: mapped.error })
        server.log.error(err, "Failed to assign staff role")
        return reply.code(500).send({ error: "Falha ao atribuir o cargo." })
      }
    },
  )
}
