// StaffCommandService + staff-policy — unit tests (no live DB).
//
// AUT-038 (staff CRUD) + AUT-007 (role assignment). Covers:
//   - the TRUSTED taint floor (admin TRUSTED + api-key SYSTEM EXECUTE; an
//     UNTRUSTED/LLM proposal is REFUSED, executor never runs);
//   - the injected `authGuards` (BKL-074) running INSIDE the adjudication;
//   - create: fresh create / duplicate-ACTIVE-phone reject / reactivate an
//     INACTIVE phone / P2002 unique race → typed error / field validation;
//   - update: partial patch / P2025 not-found / P2002 dup / role-field reject;
//   - deactivate: soft-deactivate / not-found / last-active-OWNER guard /
//     self-mutation (JWT) + api-key skip;
//   - assignRole: promote / demote-last-owner guard / self-re-role / not-found;
//   - the pure `actorStaffIdFromEnvelope` sessionId parse;
//   - the paginated `list` read.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { basis, BASIS_CODES, buildEnvelope, decisionRefuse, refuse } from "@adjudicate/core"
import { nameGuard, type Guard } from "@adjudicate/core/kernel"

const mockFindUnique = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockCount = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    staff: {
      findUnique: mockFindUnique,
      create: mockCreate,
      update: mockUpdate,
      count: mockCount,
      findMany: mockFindMany,
    },
  },
}))

import {
  actorStaffIdFromEnvelope,
  createStaffCommandService,
  DuplicatePhoneError,
  InvalidHourlyRateError,
  InvalidStaffPhoneError,
  InvalidStaffRoleError,
  LastOwnerError,
  RoleUpdateForbiddenError,
  SelfMutationError,
  StaffNotFoundError,
} from "../staff-command.service.js"
import type {
  StaffCreatePayload,
  StaffRoleAssignPayload,
  StaffCommandState,
} from "../__shared__/staff-policy.js"

const state: StaffCommandState = { ctx: {} }
const SEEN_AT = new Date("2026-07-05T12:00:00.000Z")

/** Minimal Staff-shaped row (only the fields the service reads/returns). */
function makeRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "staff_01",
    phone: "+5511999990001",
    name: "Ana",
    role: "ATTENDANT",
    active: true,
    hourlyRateCentavos: null,
    createdAt: SEEN_AT,
    updatedAt: SEEN_AT,
    ...over,
  } as never
}

/** P2002/P2025-coded Prisma-like error (the service reads `err.code`). */
function prismaError(code: string) {
  return Object.assign(new Error(`prisma ${code}`), { code })
}

// ── Envelope builders ─────────────────────────────────────────────────────────

const adminEnv = <K extends string, P>(
  kind: K,
  payload: P,
  staffId = "staff_owner_1",
) =>
  buildEnvelope<K, P>({
    kind,
    payload,
    actor: { principal: "user" as const, sessionId: `admin:${staffId}`, role: "OWNER" },
    taint: "TRUSTED" as const,
    nonce: randomUUID(),
  })

const apiKeyEnv = <K extends string, P>(kind: K, payload: P) =>
  buildEnvelope<K, P>({
    kind,
    payload,
    actor: { principal: "system" as const, sessionId: "admin:api-key", role: "OWNER" },
    taint: "SYSTEM" as const,
    nonce: randomUUID(),
  })

const untrustedEnv = <K extends string, P>(kind: K, payload: P) =>
  buildEnvelope<K, P>({
    kind,
    payload,
    actor: { principal: "llm" as const, sessionId: "wa:test" },
    taint: "UNTRUSTED" as const,
    nonce: randomUUID(),
  })

function createPayload(over: Partial<StaffCreatePayload> = {}): StaffCreatePayload {
  return {
    phone: "+5511999990001",
    name: "Ana",
    role: "ATTENDANT",
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

// ── actorStaffIdFromEnvelope (pure) ─────────────────────────────────────────

describe("actorStaffIdFromEnvelope", () => {
  it("parses admin:<staffId>, treats admin:api-key + others as null", () => {
    expect(actorStaffIdFromEnvelope({ actor: { sessionId: "admin:staff_9" } })).toBe("staff_9")
    expect(actorStaffIdFromEnvelope({ actor: { sessionId: "admin:api-key" } })).toBeNull()
    expect(actorStaffIdFromEnvelope({ actor: { sessionId: "admin:" } })).toBeNull()
    expect(actorStaffIdFromEnvelope({ actor: { sessionId: "cust_1" } })).toBeNull()
  })
})

// ── Taint floor (TRUSTED) ────────────────────────────────────────────────────

describe("staff-policy — TRUSTED taint floor", () => {
  it("EXECUTEs a TRUSTED admin create (executor runs)", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow())
    const svc = createStaffCommandService()
    const out = await svc.createFromEnvelope(adminEnv("staff.create", createPayload()), state)
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("EXECUTEs a SYSTEM api-key create too", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow())
    const svc = createStaffCommandService()
    const out = await svc.createFromEnvelope(apiKeyEnv("staff.create", createPayload()), state)
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("REFUSEs an UNTRUSTED (LLM) create — executor never runs, no prisma calls", async () => {
    const svc = createStaffCommandService()
    const out = await svc.createFromEnvelope(untrustedEnv("staff.create", createPayload()), state)
    expect(out.decision.kind).toBe("REFUSE")
    expect(out.result).toBeUndefined()
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// ── Injected authGuards (BKL-074) ────────────────────────────────────────────

describe("staff-command — injected authGuards run inside the adjudication (BKL-074)", () => {
  const alwaysRefuse: Guard<string, unknown, unknown> = nameGuard("testRefuse", () =>
    decisionRefuse(refuse("AUTH", "test_refuse", "bloqueado", "injected guard"), [
      basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, { reason: "test" }),
    ]),
  )

  it("REFUSEs when an injected guard refuses (executor never runs)", async () => {
    const svc = createStaffCommandService({ authGuards: [alwaysRefuse] })
    const out = await svc.createFromEnvelope(adminEnv("staff.create", createPayload()), state)
    expect(out.decision.kind).toBe("REFUSE")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("EXECUTEs with no injected guard (proves the refusal above was the injection)", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow())
    const svc = createStaffCommandService()
    const out = await svc.createFromEnvelope(adminEnv("staff.create", createPayload()), state)
    expect(out.decision.kind).toBe("EXECUTE")
  })
})

// ── create ────────────────────────────────────────────────────────────────────

describe("createFromEnvelope", () => {
  it("creates a fresh staff row with integer-centavos rate", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow({ id: "staff_new" }))
    const svc = createStaffCommandService()
    const out = await svc.createFromEnvelope(
      adminEnv("staff.create", createPayload({ role: "MANAGER", hourlyRateCentavos: 5000 })),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        phone: "+5511999990001",
        name: "Ana",
        role: "MANAGER",
        hourlyRateCentavos: 5000,
      },
    })
  })

  it("REFUSEs a duplicate ACTIVE phone (DuplicatePhoneError, no create)", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ active: true }))
    const svc = createStaffCommandService()
    await expect(
      svc.createFromEnvelope(adminEnv("staff.create", createPayload()), state),
    ).rejects.toBeInstanceOf(DuplicatePhoneError)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("REACTIVATES an existing INACTIVE phone (updates active/name/role, no create)", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "staff_old", active: false, name: "Old", role: "ATTENDANT" }))
    mockUpdate.mockResolvedValue(makeRow({ id: "staff_old", active: true, name: "Ana", role: "MANAGER" }))
    const svc = createStaffCommandService()
    const out = await svc.createFromEnvelope(
      adminEnv("staff.create", createPayload({ name: "Ana", role: "MANAGER", hourlyRateCentavos: 7000 })),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "staff_old" },
      data: { active: true, name: "Ana", role: "MANAGER", hourlyRateCentavos: 7000 },
    })
  })

  it("maps a P2002 unique race on create → DuplicatePhoneError", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockRejectedValue(prismaError("P2002"))
    const svc = createStaffCommandService()
    await expect(
      svc.createFromEnvelope(adminEnv("staff.create", createPayload()), state),
    ).rejects.toBeInstanceOf(DuplicatePhoneError)
  })

  it("rejects a non-E.164 phone (InvalidStaffPhoneError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.createFromEnvelope(adminEnv("staff.create", createPayload({ phone: "11999" })), state),
    ).rejects.toBeInstanceOf(InvalidStaffPhoneError)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it("rejects an out-of-set role (InvalidStaffRoleError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.createFromEnvelope(
        adminEnv("staff.create", createPayload({ role: "SUPERADMIN" as StaffCreatePayload["role"] })),
        state,
      ),
    ).rejects.toBeInstanceOf(InvalidStaffRoleError)
  })

  it("rejects a negative / non-integer hourly rate (InvalidHourlyRateError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.createFromEnvelope(adminEnv("staff.create", createPayload({ hourlyRateCentavos: -1 })), state),
    ).rejects.toBeInstanceOf(InvalidHourlyRateError)
    await expect(
      svc.createFromEnvelope(adminEnv("staff.create", createPayload({ hourlyRateCentavos: 12.5 })), state),
    ).rejects.toBeInstanceOf(InvalidHourlyRateError)
  })
})

// ── update ────────────────────────────────────────────────────────────────────

describe("updateFromEnvelope", () => {
  it("applies a partial patch (name only)", async () => {
    mockUpdate.mockResolvedValue(makeRow({ name: "Nova" }))
    const svc = createStaffCommandService()
    const out = await svc.updateFromEnvelope(
      adminEnv("staff.update", { staffId: "staff_01", name: "Nova" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: "staff_01" }, data: { name: "Nova" } })
  })

  it("REFUSEs a payload carrying a role field (RoleUpdateForbiddenError, no update)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.updateFromEnvelope(
        adminEnv("staff.update", { staffId: "staff_01", role: "OWNER" } as never),
        state,
      ),
    ).rejects.toBeInstanceOf(RoleUpdateForbiddenError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("maps P2025 → StaffNotFoundError", async () => {
    mockUpdate.mockRejectedValue(prismaError("P2025"))
    const svc = createStaffCommandService()
    await expect(
      svc.updateFromEnvelope(adminEnv("staff.update", { staffId: "ghost", name: "X" }), state),
    ).rejects.toBeInstanceOf(StaffNotFoundError)
  })

  it("maps P2002 → DuplicatePhoneError", async () => {
    mockUpdate.mockRejectedValue(prismaError("P2002"))
    const svc = createStaffCommandService()
    await expect(
      svc.updateFromEnvelope(
        adminEnv("staff.update", { staffId: "staff_01", phone: "+5511988887777" }),
        state,
      ),
    ).rejects.toBeInstanceOf(DuplicatePhoneError)
  })

  it("rejects a non-E.164 phone in the patch (InvalidStaffPhoneError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.updateFromEnvelope(adminEnv("staff.update", { staffId: "staff_01", phone: "bad" }), state),
    ).rejects.toBeInstanceOf(InvalidStaffPhoneError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

// ── deactivate ────────────────────────────────────────────────────────────────

describe("deactivateFromEnvelope", () => {
  it("soft-deactivates a non-owner (active=false); owner-count NOT read", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "staff_2", role: "ATTENDANT", active: true }))
    mockUpdate.mockResolvedValue(makeRow({ id: "staff_2", active: false }))
    const svc = createStaffCommandService()
    const out = await svc.deactivateFromEnvelope(
      adminEnv("staff.deactivate", { staffId: "staff_2" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: "staff_2" }, data: { active: false } })
    expect(mockCount).not.toHaveBeenCalled()
  })

  it("404s an unknown target (StaffNotFoundError)", async () => {
    mockFindUnique.mockResolvedValue(null)
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(adminEnv("staff.deactivate", { staffId: "ghost" }), state),
    ).rejects.toBeInstanceOf(StaffNotFoundError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("REFUSES deactivating the LAST active OWNER (LastOwnerError, no update)", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockCount.mockResolvedValue(1)
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(adminEnv("staff.deactivate", { staffId: "owner_1" }, "owner_2"), state),
    ).rejects.toBeInstanceOf(LastOwnerError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("allows deactivating an OWNER when another active OWNER remains", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockCount.mockResolvedValue(2)
    mockUpdate.mockResolvedValue(makeRow({ id: "owner_1", active: false }))
    const svc = createStaffCommandService()
    const out = await svc.deactivateFromEnvelope(
      adminEnv("staff.deactivate", { staffId: "owner_1" }, "owner_2"),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: "owner_1" }, data: { active: false } })
  })

  it("REFUSES self-deactivation for a JWT caller (SelfMutationError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(
        adminEnv("staff.deactivate", { staffId: "staff_self" }, "staff_self"),
        state,
      ),
    ).rejects.toBeInstanceOf(SelfMutationError)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it("SKIPS the self-mutation check for an api-key caller (no staffId)", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "staff_self", role: "ATTENDANT", active: true }))
    mockUpdate.mockResolvedValue(makeRow({ id: "staff_self", active: false }))
    const svc = createStaffCommandService()
    const out = await svc.deactivateFromEnvelope(
      apiKeyEnv("staff.deactivate", { staffId: "staff_self" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})

// ── assignRole ────────────────────────────────────────────────────────────────

describe("assignRoleFromEnvelope", () => {
  it("promotes an ATTENDANT to MANAGER (owner-count NOT read)", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "staff_2", role: "ATTENDANT", active: true }))
    mockUpdate.mockResolvedValue(makeRow({ id: "staff_2", role: "MANAGER" }))
    const svc = createStaffCommandService()
    const out = await svc.assignRoleFromEnvelope(
      adminEnv("staff.role.assign", { staffId: "staff_2", role: "MANAGER" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: "staff_2" }, data: { role: "MANAGER" } })
    expect(mockCount).not.toHaveBeenCalled()
  })

  it("REFUSES demoting the LAST active OWNER (LastOwnerError, no update)", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockCount.mockResolvedValue(1)
    const svc = createStaffCommandService()
    await expect(
      svc.assignRoleFromEnvelope(
        adminEnv("staff.role.assign", { staffId: "owner_1", role: "MANAGER" }, "owner_2"),
        state,
      ),
    ).rejects.toBeInstanceOf(LastOwnerError)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("allows demoting an OWNER when another active OWNER remains", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockCount.mockResolvedValue(2)
    mockUpdate.mockResolvedValue(makeRow({ id: "owner_1", role: "MANAGER" }))
    const svc = createStaffCommandService()
    const out = await svc.assignRoleFromEnvelope(
      adminEnv("staff.role.assign", { staffId: "owner_1", role: "MANAGER" }, "owner_2"),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: "owner_1" }, data: { role: "MANAGER" } })
  })

  it("promoting TO owner never trips the last-owner guard (owner-count NOT read)", async () => {
    mockFindUnique.mockResolvedValue(makeRow({ id: "staff_2", role: "MANAGER", active: true }))
    mockUpdate.mockResolvedValue(makeRow({ id: "staff_2", role: "OWNER" }))
    const svc = createStaffCommandService()
    const out = await svc.assignRoleFromEnvelope(
      adminEnv("staff.role.assign", { staffId: "staff_2", role: "OWNER" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockCount).not.toHaveBeenCalled()
  })

  it("REFUSES self-re-role for a JWT caller (SelfMutationError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.assignRoleFromEnvelope(
        adminEnv("staff.role.assign", { staffId: "staff_self", role: "OWNER" }, "staff_self"),
        state,
      ),
    ).rejects.toBeInstanceOf(SelfMutationError)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it("404s an unknown target (StaffNotFoundError)", async () => {
    mockFindUnique.mockResolvedValue(null)
    const svc = createStaffCommandService()
    await expect(
      svc.assignRoleFromEnvelope(
        adminEnv("staff.role.assign", { staffId: "ghost", role: "MANAGER" }),
        state,
      ),
    ).rejects.toBeInstanceOf(StaffNotFoundError)
  })

  it("rejects an out-of-set role (InvalidStaffRoleError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.assignRoleFromEnvelope(
        adminEnv("staff.role.assign", {
          staffId: "staff_2",
          role: "ROOT" as StaffRoleAssignPayload["role"],
        }),
        state,
      ),
    ).rejects.toBeInstanceOf(InvalidStaffRoleError)
  })
})

// ── list ──────────────────────────────────────────────────────────────────────

describe("list", () => {
  it("returns { staff, total } and threads role/active/limit/offset", async () => {
    mockFindMany.mockResolvedValue([makeRow()])
    mockCount.mockResolvedValue(1)
    const svc = createStaffCommandService()
    const out = await svc.list({ role: "OWNER", active: true, limit: 10, offset: 5 })
    expect(out.total).toBe(1)
    expect(out.staff).toHaveLength(1)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "OWNER", active: true }, take: 10, skip: 5 }),
    )
  })
})
