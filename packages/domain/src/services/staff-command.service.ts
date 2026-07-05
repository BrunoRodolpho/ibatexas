// StaffCommandService — the OWNER-gated, kernel-governed staff-CRUD plane
// (AUT-038 staff CRUD + AUT-007 role assignment).
//
// Staff records are PII + privilege-granting. Every mutation routes through the
// adjudicate kernel via `withAdjudicate` against `staffCommandPolicyBundle`
// (TRUSTED taint floor; OWNER role enforced by the injected `staffRoleGuard`).
// The four kinds — `staff.create` / `staff.update` / `staff.deactivate` /
// `staff.role.assign` — are HTTP-plane-only verbs, never LLM-proposable
// (absent from every planner / roster / claim surface). This is the NEW command
// service; the read-only `StaffService` (findByPhone / getById) is untouched.
//
// ── Invariants (enforced IN THE SERVICE as typed errors) ─────────────────────
//   - LastOwnerError     — a demote (role.assign away from OWNER) or a
//                          deactivate may NEVER drop the count of ACTIVE OWNERs
//                          to zero. Unconditional — every caller, incl. API key.
//   - SelfMutationError  — a staff member (envelope carries a staffId) may not
//                          deactivate themselves or change their own role.
//                          SKIPPED for API-key callers (no staffId); safe
//                          because the unconditional last-owner guard makes an
//                          org-wide lockout impossible either way.
//   - DuplicatePhoneError — phone is `@unique`. Create on an ACTIVE phone
//                          REFUSEs; create on an INACTIVE phone REACTIVATES that
//                          row (CLI create-staff idiom, auth.ts) updating
//                          name / role / rate per the payload.
//   - StaffNotFoundError — unknown target id.
//   - Validation errors  — E.164 phone (auth.ts idiom), closed-set role,
//                          integer-centavos-≥0-or-null hourly rate; staff.update
//                          REFUSEs a `role` field (privilege change is a distinct
//                          audit kind).
//
// Soft-deactivate ONLY (active = false). There is NO delete method — StaffShift
// FK is ON DELETE CASCADE, so a hard delete would orphan the escala.

import { prisma } from "../client.js"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import type { Guard } from "@adjudicate/core/kernel"
import type { Staff, StaffRole } from "../generated/prisma-client/client.js"
import {
  STAFF_ROLE_VALUES,
  staffCommandPolicyBundle,
  type StaffCreatePayload,
  type StaffDeactivatePayload,
  type StaffRoleAssignPayload,
  type StaffCommandState,
  type StaffUpdatePayload,
} from "./__shared__/staff-policy.js"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"

// ── Typed errors ────────────────────────────────────────────────────────────
// Surfaced to the route layer, which maps each to a pt-BR HTTP response.

/** No staff member exists for the requested id. */
export class StaffNotFoundError extends Error {
  constructor(public readonly staffId: string) {
    super(`Staff not found: ${staffId}`)
    this.name = "StaffNotFoundError"
  }
}

/** An ACTIVE staff member already holds the requested phone (`@unique`). */
export class DuplicatePhoneError extends Error {
  constructor(public readonly phone: string) {
    super(`Active staff already exists for phone: ${phone}`)
    this.name = "DuplicatePhoneError"
  }
}

/**
 * The mutation would reduce the count of ACTIVE OWNERs to zero (deactivating or
 * demoting the last active owner). Unconditional — blocks every caller so the
 * organization can never be locked out of owner-level administration.
 */
export class LastOwnerError extends Error {
  constructor(public readonly staffId: string) {
    super(`Refusing to remove the last active OWNER: ${staffId}`)
    this.name = "LastOwnerError"
  }
}

/**
 * A staff member tried to deactivate themselves or change their own role. Only
 * raised when the envelope actor carries a staffId (JWT caller); API-key callers
 * (no staffId) are exempt — see the class doc on the service.
 */
export class SelfMutationError extends Error {
  constructor(public readonly staffId: string) {
    super(`Staff may not deactivate or re-role themselves: ${staffId}`)
    this.name = "SelfMutationError"
  }
}

/** Phone is not E.164 (mirrors the CLI create-staff check, auth.ts). */
export class InvalidStaffPhoneError extends Error {
  constructor(public readonly phone: string) {
    super(`Invalid E.164 phone: ${phone}`)
    this.name = "InvalidStaffPhoneError"
  }
}

/** Role is outside the closed {OWNER, MANAGER, ATTENDANT} set. */
export class InvalidStaffRoleError extends Error {
  constructor(public readonly role: string) {
    super(`Invalid staff role: ${role}`)
    this.name = "InvalidStaffRoleError"
  }
}

/** hourlyRateCentavos is not a non-negative integer (nor null). */
export class InvalidHourlyRateError extends Error {
  constructor(public readonly value: unknown) {
    super(`Invalid hourlyRateCentavos (want integer ≥ 0 or null): ${String(value)}`)
    this.name = "InvalidHourlyRateError"
  }
}

/**
 * A `staff.update` payload carried a `role` field. Role changes are privilege
 * escalation and MUST ride `staff.role.assign` (its own audit kind). Defensive
 * mirror of the route's `.strict()` zod body.
 */
export class RoleUpdateForbiddenError extends Error {
  constructor() {
    super("staff.update must not carry a role field — use staff.role.assign")
    this.name = "RoleUpdateForbiddenError"
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Read the Prisma known-error code (`P2002`, `P2025`, …) if present. */
function prismaErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

/** The `admin:` sessionId namespace minted by the staff admin routes. */
const STAFF_SESSION_NAMESPACE = "admin:"
/** The API-key sessionId (no staff identity). */
const API_KEY_SESSION = "admin:api-key"

/**
 * The acting staff member's id derived from the adjudicated envelope actor:
 * `admin:<staffId>` → `<staffId>`; `admin:api-key` (or any other shape) → null.
 * Binding the self-mutation identity to the kernel-adjudicated envelope (not a
 * separate parameter) means it cannot be spoofed independently of the actor the
 * kernel authorized.
 */
export function actorStaffIdFromEnvelope(envelope: {
  readonly actor: { readonly sessionId: string }
}): string | null {
  const { sessionId } = envelope.actor
  if (sessionId === API_KEY_SESSION) return null
  if (sessionId.startsWith(STAFF_SESSION_NAMESPACE)) {
    const id = sessionId.slice(STAFF_SESSION_NAMESPACE.length)
    return id.length > 0 ? id : null
  }
  return null
}

/** E.164 validation — mirrors the CLI create-staff guard (auth.ts). */
function assertValidPhone(phone: string): void {
  if (!phone.startsWith("+") || phone.replace(/\D/g, "").length < 10) {
    throw new InvalidStaffPhoneError(phone)
  }
}

function assertValidRole(role: string): asserts role is StaffRole {
  if (!(STAFF_ROLE_VALUES as readonly string[]).includes(role)) {
    throw new InvalidStaffRoleError(role)
  }
}

/** hourlyRateCentavos must be an integer ≥ 0, or null. Undefined is "unset". */
function assertValidHourlyRate(value: number | null | undefined): void {
  if (value === undefined || value === null) return
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidHourlyRateError(value)
  }
}

// ── Service options ───────────────────────────────────────────────────────────

export interface StaffCommandServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
  /**
   * WS7 / BKL-074 — adopter AUTH guards (the OWNER `staffRoleGuard`) injected
   * into EVERY `withAdjudicate` call this service makes. The admin staff routes
   * pass `[staffRoleGuard]` so a mis-scoped staff role is REFUSED at the kernel
   * on the command-service adjudication path (the raw `staffCommandPolicyBundle`
   * carries no adopter auth guards), not only by the Fastify preHandler. Inert
   * for non-`admin:` envelopes.
   */
  readonly authGuards?: readonly Guard<string, unknown, unknown>[]
}

export interface StaffListParams {
  readonly role?: StaffRole
  readonly active?: boolean
  readonly limit?: number
  readonly offset?: number
}

export interface StaffListResult {
  readonly staff: Staff[]
  readonly total: number
}

// ── Service ─────────────────────────────────────────────────────────────────

/** ACTIVE-owner headcount — the last-owner invariant reads this. */
async function activeOwnerCount(): Promise<number> {
  return prisma.staff.count({ where: { role: "OWNER", active: true } })
}

export function createStaffCommandService(options?: StaffCommandServiceOptions) {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.log ? { log: options.log } : {}),
    ...(options?.authGuards ? { authGuards: options.authGuards } : {}),
  } as const

  // ── Executors ──────────────────────────────────────────────────────────────

  async function createExecutor(payload: StaffCreatePayload): Promise<Staff> {
    assertValidPhone(payload.phone)
    assertValidRole(payload.role)
    assertValidHourlyRate(payload.hourlyRateCentavos)

    const existing = await prisma.staff.findUnique({
      where: { phone: payload.phone },
    })
    if (existing) {
      if (existing.active) {
        throw new DuplicatePhoneError(payload.phone)
      }
      // Reactivate the inactive row (CLI create-staff idiom) — refresh
      // name / role and, when provided, the hourly rate.
      return prisma.staff.update({
        where: { id: existing.id },
        data: {
          active: true,
          name: payload.name,
          role: payload.role,
          ...(payload.hourlyRateCentavos !== undefined
            ? { hourlyRateCentavos: payload.hourlyRateCentavos }
            : {}),
        },
      })
    }

    try {
      return await prisma.staff.create({
        data: {
          phone: payload.phone,
          name: payload.name,
          role: payload.role,
          hourlyRateCentavos: payload.hourlyRateCentavos ?? null,
        },
      })
    } catch (err) {
      // `withAdjudicate` does NOT swallow executor errors — map the unique-race
      // P2002 to the typed error (a concurrent create won the phone).
      if (prismaErrorCode(err) === "P2002") {
        throw new DuplicatePhoneError(payload.phone)
      }
      throw err
    }
  }

  async function updateExecutor(payload: StaffUpdatePayload): Promise<Staff> {
    // Defensive backstop for the route's `.strict()` body: a role change is a
    // distinct audit kind and must never ride staff.update.
    if ("role" in payload) {
      throw new RoleUpdateForbiddenError()
    }
    if (payload.phone !== undefined) assertValidPhone(payload.phone)
    assertValidHourlyRate(payload.hourlyRateCentavos)

    try {
      return await prisma.staff.update({
        where: { id: payload.staffId },
        data: {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
          ...(payload.hourlyRateCentavos !== undefined
            ? { hourlyRateCentavos: payload.hourlyRateCentavos }
            : {}),
        },
      })
    } catch (err) {
      const code = prismaErrorCode(err)
      if (code === "P2025") throw new StaffNotFoundError(payload.staffId)
      if (code === "P2002") throw new DuplicatePhoneError(payload.phone ?? "")
      throw err
    }
  }

  function deactivateExecutor(actorStaffId: string | null) {
    return async (payload: StaffDeactivatePayload): Promise<Staff> => {
      // Self-mutation — only for JWT callers (actorStaffId present).
      if (actorStaffId !== null && actorStaffId === payload.staffId) {
        throw new SelfMutationError(payload.staffId)
      }
      const target = await prisma.staff.findUnique({
        where: { id: payload.staffId },
      })
      if (!target) throw new StaffNotFoundError(payload.staffId)

      // Last-owner (unconditional): count precondition inside the mutation
      // (table.service idiom). Only an ACTIVE owner reduces the headcount.
      if (target.role === "OWNER" && target.active) {
        if ((await activeOwnerCount()) <= 1) {
          throw new LastOwnerError(payload.staffId)
        }
      }

      return prisma.staff.update({
        where: { id: payload.staffId },
        data: { active: false },
      })
    }
  }

  function assignRoleExecutor(actorStaffId: string | null) {
    return async (payload: StaffRoleAssignPayload): Promise<Staff> => {
      assertValidRole(payload.role)
      // Self-mutation — only for JWT callers (actorStaffId present).
      if (actorStaffId !== null && actorStaffId === payload.staffId) {
        throw new SelfMutationError(payload.staffId)
      }
      const target = await prisma.staff.findUnique({
        where: { id: payload.staffId },
      })
      if (!target) throw new StaffNotFoundError(payload.staffId)

      // Last-owner (unconditional): demoting the last ACTIVE owner away from
      // OWNER is refused. Count precondition inside the mutation.
      if (
        target.role === "OWNER" &&
        target.active &&
        payload.role !== "OWNER"
      ) {
        if ((await activeOwnerCount()) <= 1) {
          throw new LastOwnerError(payload.staffId)
        }
      }

      return prisma.staff.update({
        where: { id: payload.staffId },
        data: { role: payload.role },
      })
    }
  }

  return {
    /**
     * Governed `staff.create`. OWNER-only. EXECUTE → creates a fresh staff row
     * OR reactivates an existing INACTIVE phone (refreshing name/role/rate);
     * throws {@link DuplicatePhoneError} on an ACTIVE phone. Kernel REFUSE
     * (taint / role) → the executor never runs.
     */
    async createFromEnvelope(
      envelope: IntentEnvelope<"staff.create", StaffCreatePayload>,
      state: StaffCommandState,
    ): Promise<AdjudicatedResult<Staff>> {
      return withAdjudicate(
        envelope,
        state,
        staffCommandPolicyBundle,
        (payload) => createExecutor(payload as StaffCreatePayload),
        adjudicateOptions,
      )
    },

    /**
     * Governed `staff.update`. OWNER-only. Edits name / phone / hourly rate.
     * REFUSEs a `role` field ({@link RoleUpdateForbiddenError}). 404 via
     * {@link StaffNotFoundError}; duplicate phone via {@link DuplicatePhoneError}.
     */
    async updateFromEnvelope(
      envelope: IntentEnvelope<"staff.update", StaffUpdatePayload>,
      state: StaffCommandState,
    ): Promise<AdjudicatedResult<Staff>> {
      return withAdjudicate(
        envelope,
        state,
        staffCommandPolicyBundle,
        (payload) => updateExecutor(payload as StaffUpdatePayload),
        adjudicateOptions,
      )
    },

    /**
     * Governed `staff.deactivate`. OWNER-only. Soft-deactivate (active=false).
     * Blocks self-deactivation ({@link SelfMutationError}, JWT callers) and the
     * last active OWNER ({@link LastOwnerError}, unconditional).
     */
    async deactivateFromEnvelope(
      envelope: IntentEnvelope<"staff.deactivate", StaffDeactivatePayload>,
      state: StaffCommandState,
    ): Promise<AdjudicatedResult<Staff>> {
      const actorStaffId = actorStaffIdFromEnvelope(envelope)
      return withAdjudicate(
        envelope,
        state,
        staffCommandPolicyBundle,
        (payload) =>
          deactivateExecutor(actorStaffId)(payload as StaffDeactivatePayload),
        adjudicateOptions,
      )
    },

    /**
     * Governed `staff.role.assign`. OWNER-only. Changes a staff member's role
     * (privilege escalation ⇒ its own audit kind). Blocks self-re-role
     * ({@link SelfMutationError}, JWT callers) and demoting the last active
     * OWNER ({@link LastOwnerError}, unconditional).
     */
    async assignRoleFromEnvelope(
      envelope: IntentEnvelope<"staff.role.assign", StaffRoleAssignPayload>,
      state: StaffCommandState,
    ): Promise<AdjudicatedResult<Staff>> {
      const actorStaffId = actorStaffIdFromEnvelope(envelope)
      return withAdjudicate(
        envelope,
        state,
        staffCommandPolicyBundle,
        (payload) =>
          assignRoleExecutor(actorStaffId)(payload as StaffRoleAssignPayload),
        adjudicateOptions,
      )
    },

    /**
     * Paginated staff list for the OWNER staff-administration surface (carries
     * `hourlyRateCentavos` pay data — OWNER-gated at the route). Optional role /
     * active filters. Returns rows + an independent total for the filter.
     */
    async list(params: StaffListParams = {}): Promise<StaffListResult> {
      const where = {
        ...(params.role ? { role: params.role } : {}),
        ...(params.active !== undefined ? { active: params.active } : {}),
      }
      const limit = params.limit ?? 50
      const offset = params.offset ?? 0
      const [staff, total] = await Promise.all([
        prisma.staff.findMany({
          where,
          orderBy: [{ active: "desc" }, { name: "asc" }],
          take: limit,
          skip: offset,
        }),
        prisma.staff.count({ where }),
      ])
      return { staff, total }
    },
  }
}

export type StaffCommandService = ReturnType<typeof createStaffCommandService>
