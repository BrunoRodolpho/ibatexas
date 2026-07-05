// StaffCommandService + staff-policy — unit tests (no live DB).
//
// AUT-038 (staff CRUD) + AUT-007 (role assignment). Covers:
//   - the TRUSTED taint floor (admin TRUSTED + api-key SYSTEM EXECUTE; an
//     UNTRUSTED/LLM proposal is REFUSED, executor never runs);
//   - the injected `authGuards` (BKL-074) running INSIDE the adjudication;
//   - create: fresh create / duplicate-ACTIVE-phone reject / reactivate an
//     INACTIVE phone / P2002 unique race → typed error / field validation;
//   - FIX 3: canonical E.164 normalization on create AND update (formatted
//     input stored canonical + findable by the login lookup; format variants
//     collide as DuplicatePhone);
//   - update: partial patch / P2025 not-found / P2002 dup / role-field reject;
//   - deactivate + assignRole: FIX 2 — the last-owner invariant runs INSIDE a
//     Serializable interactive transaction (count+write on the tx client, one
//     P2034 retry, persistent conflict → StaffMutationConflictError), plus
//     not-found / self-mutation (JWT) + api-key skip;
//   - the pure `actorStaffIdFromEnvelope` sessionId parse;
//   - the paginated `list` read (id tiebreaker — FIX 6b).

import { describe, it, expect, beforeEach, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { basis, BASIS_CODES, buildEnvelope, decisionRefuse, refuse } from "@adjudicate/core"
import { nameGuard, type Guard } from "@adjudicate/core/kernel"

const mockFindUnique = vi.hoisted(() => vi.fn())
const mockCreate = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockCount = vi.hoisted(() => vi.fn())
const mockFindMany = vi.hoisted(() => vi.fn())
// FIX 2 — the Serializable-transaction seam. `$transaction` is a spy whose
// default impl (set in beforeEach) runs the callback against a DISTINCT tx
// client, so tests can prove deactivate/assignRole read+check+write ON THE TX
// (atomic) and never on the root client (the TOCTOU shape the fix closes).
const mockTransaction = vi.hoisted(() => vi.fn())
const mockTxFindUnique = vi.hoisted(() => vi.fn())
const mockTxCount = vi.hoisted(() => vi.fn())
const mockTxUpdate = vi.hoisted(() => vi.fn())

vi.mock("../../client.js", () => ({
  prisma: {
    staff: {
      findUnique: mockFindUnique,
      create: mockCreate,
      update: mockUpdate,
      count: mockCount,
      findMany: mockFindMany,
    },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
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
  StaffMutationConflictError,
  StaffNotFoundError,
} from "../staff-command.service.js"
import type {
  StaffCreatePayload,
  StaffRoleAssignPayload,
  StaffCommandState,
} from "../__shared__/staff-policy.js"

const state: StaffCommandState = { ctx: {} }
const SEEN_AT = new Date("2026-07-05T12:00:00.000Z")

/** The distinct tx client handed to the $transaction callback. */
const TX_CLIENT = {
  staff: {
    findUnique: (...a: unknown[]) => mockTxFindUnique(...a),
    count: (...a: unknown[]) => mockTxCount(...a),
    update: (...a: unknown[]) => mockTxUpdate(...a),
  },
}

type TxFn = (tx: typeof TX_CLIENT) => Promise<unknown>

/** Default: run the callback against TX_CLIENT (a committing transaction). */
function txRuns(fn: TxFn): Promise<unknown> {
  return fn(TX_CLIENT)
}

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

/** P2002/P2025/P2034-coded Prisma-like error (the service reads `err.code`). */
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

beforeEach(() => {
  vi.clearAllMocks()
  // Default committing transaction — individual tests override to inject
  // P2034 serialization conflicts.
  mockTransaction.mockImplementation((fn: TxFn) => txRuns(fn))
})

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

// ── FIX 3 — canonical E.164 normalization (create + update) ─────────────────

describe("phone canonicalization (FIX 3 — same normalizer as the login path)", () => {
  it("create with formatted input LOOKS UP and STORES canonical E.164 (login-findable)", async () => {
    mockFindUnique.mockResolvedValue(null)
    mockCreate.mockResolvedValue(makeRow())
    const svc = createStaffCommandService()
    await svc.createFromEnvelope(
      adminEnv("staff.create", createPayload({ phone: "+55 11 99999-0001" })),
      state,
    )
    // Duplicate lookup runs against the canonical form…
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { phone: "+5511999990001" } })
    // …and the stored value is canonical AND matches the staff-OTP login
    // PhoneSchema regex (routes/auth.ts) — the row can actually log in.
    const stored = (mockCreate.mock.calls[0]?.[0] as { data: { phone: string } }).data.phone
    expect(stored).toBe("+5511999990001")
    expect(/^\+[1-9]\d{7,14}$/.test(stored)).toBe(true)
  })

  it("two format variants of the same number COLLIDE as DuplicatePhone", async () => {
    // The row was created canonical; a formatted variant must find it.
    mockFindUnique.mockResolvedValue(makeRow({ phone: "+5511999990001", active: true }))
    const svc = createStaffCommandService()
    await expect(
      svc.createFromEnvelope(
        adminEnv("staff.create", createPayload({ phone: "+55 (11) 99999.0001" })),
        state,
      ),
    ).rejects.toBeInstanceOf(DuplicatePhoneError)
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { phone: "+5511999990001" } })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("update with formatted input stores canonical E.164", async () => {
    mockUpdate.mockResolvedValue(makeRow({ phone: "+5511988887777" }))
    const svc = createStaffCommandService()
    await svc.updateFromEnvelope(
      adminEnv("staff.update", { staffId: "staff_01", phone: "+55 11 98888-7777" }),
      state,
    )
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "staff_01" },
      data: { phone: "+5511988887777" },
    })
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

// ── FIX 2 — Serializable last-owner transaction ──────────────────────────────

describe("last-owner invariant is TRANSACTIONAL (FIX 2 — Serializable, on-tx, P2034 retry)", () => {
  it("deactivate wraps read+count+write in ONE Serializable transaction ON THE TX CLIENT", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockTxCount.mockResolvedValue(2)
    mockTxUpdate.mockResolvedValue(makeRow({ id: "owner_1", active: false }))
    const svc = createStaffCommandService()
    const out = await svc.deactivateFromEnvelope(
      adminEnv("staff.deactivate", { staffId: "owner_1" }, "owner_2"),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    // The transaction is Serializable — READ COMMITTED would leave the
    // count-then-update TOCTOU open (two racing last-owner mutations both
    // reading count=2 and both committing → zero active OWNERs).
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockTransaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: "Serializable" })
    // Read + count + write all ran on the TX client…
    expect(mockTxFindUnique).toHaveBeenCalledTimes(1)
    expect(mockTxCount).toHaveBeenCalledWith({ where: { role: "OWNER", active: true } })
    expect(mockTxUpdate).toHaveBeenCalledWith({ where: { id: "owner_1" }, data: { active: false } })
    // …and NEVER on the root client (that would be outside the atomic scope).
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("assignRole demote wraps in the same Serializable transaction on the tx client", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockTxCount.mockResolvedValue(2)
    mockTxUpdate.mockResolvedValue(makeRow({ id: "owner_1", role: "MANAGER" }))
    const svc = createStaffCommandService()
    const out = await svc.assignRoleFromEnvelope(
      adminEnv("staff.role.assign", { staffId: "owner_1", role: "MANAGER" }, "owner_2"),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockTransaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: "Serializable" })
    expect(mockTxUpdate).toHaveBeenCalledWith({ where: { id: "owner_1" }, data: { role: "MANAGER" } })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it("racing pair: the serialization LOSER retries once and correctly sees count=1 → LastOwnerError (both cannot commit)", async () => {
    // Simulates the two-last-OWNERs race: the winner committed first, so this
    // caller's Serializable tx aborts with P2034. The single retry re-runs
    // against COMMITTED state — count is now 1 — and the invariant refuses.
    // This is exactly the pair-cannot-both-commit guarantee.
    mockTransaction
      .mockRejectedValueOnce(prismaError("P2034")) // attempt 1: serialization conflict
      .mockImplementationOnce((fn: TxFn) => txRuns(fn)) // attempt 2: re-runs and sees truth
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "owner_2", role: "OWNER", active: true }))
    mockTxCount.mockResolvedValue(1) // the winner already removed the other OWNER
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(
        adminEnv("staff.deactivate", { staffId: "owner_2" }, "owner_9"),
        state,
      ),
    ).rejects.toBeInstanceOf(LastOwnerError)
    expect(mockTransaction).toHaveBeenCalledTimes(2) // one retry, then the typed refusal
    expect(mockTxUpdate).not.toHaveBeenCalled() // the loser never writes
  })

  it("a P2034 that persists past the single retry → StaffMutationConflictError (route 409)", async () => {
    mockTransaction
      .mockRejectedValueOnce(prismaError("P2034"))
      .mockRejectedValueOnce(prismaError("P2034"))
    const svc = createStaffCommandService()
    await expect(
      svc.assignRoleFromEnvelope(
        adminEnv("staff.role.assign", { staffId: "owner_1", role: "MANAGER" }, "owner_2"),
        state,
      ),
    ).rejects.toBeInstanceOf(StaffMutationConflictError)
    expect(mockTransaction).toHaveBeenCalledTimes(2) // exactly one retry
  })

  it("a non-P2034 transaction error propagates untouched (no retry loop)", async () => {
    mockTransaction.mockRejectedValueOnce(prismaError("P1001"))
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(adminEnv("staff.deactivate", { staffId: "s1" }), state),
    ).rejects.toMatchObject({ code: "P1001" })
    expect(mockTransaction).toHaveBeenCalledTimes(1)
  })
})

// ── deactivate ────────────────────────────────────────────────────────────────

describe("deactivateFromEnvelope", () => {
  it("soft-deactivates a non-owner (active=false); owner-count NOT read", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "staff_2", role: "ATTENDANT", active: true }))
    mockTxUpdate.mockResolvedValue(makeRow({ id: "staff_2", active: false }))
    const svc = createStaffCommandService()
    const out = await svc.deactivateFromEnvelope(
      adminEnv("staff.deactivate", { staffId: "staff_2" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockTxUpdate).toHaveBeenCalledWith({ where: { id: "staff_2" }, data: { active: false } })
    expect(mockTxCount).not.toHaveBeenCalled()
  })

  it("404s an unknown target (StaffNotFoundError)", async () => {
    mockTxFindUnique.mockResolvedValue(null)
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(adminEnv("staff.deactivate", { staffId: "ghost" }), state),
    ).rejects.toBeInstanceOf(StaffNotFoundError)
    expect(mockTxUpdate).not.toHaveBeenCalled()
  })

  it("REFUSES deactivating the LAST active OWNER (LastOwnerError, no update)", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockTxCount.mockResolvedValue(1)
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(adminEnv("staff.deactivate", { staffId: "owner_1" }, "owner_2"), state),
    ).rejects.toBeInstanceOf(LastOwnerError)
    expect(mockTxUpdate).not.toHaveBeenCalled()
  })

  it("allows deactivating an OWNER when another active OWNER remains", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockTxCount.mockResolvedValue(2)
    mockTxUpdate.mockResolvedValue(makeRow({ id: "owner_1", active: false }))
    const svc = createStaffCommandService()
    const out = await svc.deactivateFromEnvelope(
      adminEnv("staff.deactivate", { staffId: "owner_1" }, "owner_2"),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockTxUpdate).toHaveBeenCalledWith({ where: { id: "owner_1" }, data: { active: false } })
  })

  it("REFUSES self-deactivation for a JWT caller (SelfMutationError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.deactivateFromEnvelope(
        adminEnv("staff.deactivate", { staffId: "staff_self" }, "staff_self"),
        state,
      ),
    ).rejects.toBeInstanceOf(SelfMutationError)
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it("SKIPS the self-mutation check for an api-key caller (no staffId)", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "staff_self", role: "ATTENDANT", active: true }))
    mockTxUpdate.mockResolvedValue(makeRow({ id: "staff_self", active: false }))
    const svc = createStaffCommandService()
    const out = await svc.deactivateFromEnvelope(
      apiKeyEnv("staff.deactivate", { staffId: "staff_self" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockTxUpdate).toHaveBeenCalledTimes(1)
  })
})

// ── assignRole ────────────────────────────────────────────────────────────────

describe("assignRoleFromEnvelope", () => {
  it("promotes an ATTENDANT to MANAGER (owner-count NOT read)", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "staff_2", role: "ATTENDANT", active: true }))
    mockTxUpdate.mockResolvedValue(makeRow({ id: "staff_2", role: "MANAGER" }))
    const svc = createStaffCommandService()
    const out = await svc.assignRoleFromEnvelope(
      adminEnv("staff.role.assign", { staffId: "staff_2", role: "MANAGER" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockTxUpdate).toHaveBeenCalledWith({ where: { id: "staff_2" }, data: { role: "MANAGER" } })
    expect(mockTxCount).not.toHaveBeenCalled()
  })

  it("REFUSES demoting the LAST active OWNER (LastOwnerError, no update)", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockTxCount.mockResolvedValue(1)
    const svc = createStaffCommandService()
    await expect(
      svc.assignRoleFromEnvelope(
        adminEnv("staff.role.assign", { staffId: "owner_1", role: "MANAGER" }, "owner_2"),
        state,
      ),
    ).rejects.toBeInstanceOf(LastOwnerError)
    expect(mockTxUpdate).not.toHaveBeenCalled()
  })

  it("allows demoting an OWNER when another active OWNER remains", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "owner_1", role: "OWNER", active: true }))
    mockTxCount.mockResolvedValue(2)
    mockTxUpdate.mockResolvedValue(makeRow({ id: "owner_1", role: "MANAGER" }))
    const svc = createStaffCommandService()
    const out = await svc.assignRoleFromEnvelope(
      adminEnv("staff.role.assign", { staffId: "owner_1", role: "MANAGER" }, "owner_2"),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockTxUpdate).toHaveBeenCalledWith({ where: { id: "owner_1" }, data: { role: "MANAGER" } })
  })

  it("promoting TO owner never trips the last-owner guard (owner-count NOT read)", async () => {
    mockTxFindUnique.mockResolvedValue(makeRow({ id: "staff_2", role: "MANAGER", active: true }))
    mockTxUpdate.mockResolvedValue(makeRow({ id: "staff_2", role: "OWNER" }))
    const svc = createStaffCommandService()
    const out = await svc.assignRoleFromEnvelope(
      adminEnv("staff.role.assign", { staffId: "staff_2", role: "OWNER" }),
      state,
    )
    expect(out.decision.kind).toBe("EXECUTE")
    expect(mockTxCount).not.toHaveBeenCalled()
  })

  it("REFUSES self-re-role for a JWT caller (SelfMutationError)", async () => {
    const svc = createStaffCommandService()
    await expect(
      svc.assignRoleFromEnvelope(
        adminEnv("staff.role.assign", { staffId: "staff_self", role: "OWNER" }, "staff_self"),
        state,
      ),
    ).rejects.toBeInstanceOf(SelfMutationError)
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it("404s an unknown target (StaffNotFoundError)", async () => {
    mockTxFindUnique.mockResolvedValue(null)
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
  it("returns { staff, total }, threads role/active/limit/offset, and orders with the id tiebreaker (FIX 6b)", async () => {
    mockFindMany.mockResolvedValue([makeRow()])
    mockCount.mockResolvedValue(1)
    const svc = createStaffCommandService()
    const out = await svc.list({ role: "OWNER", active: true, limit: 10, offset: 5 })
    expect(out.total).toBe(1)
    expect(out.staff).toHaveLength(1)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: "OWNER", active: true },
        take: 10,
        skip: 5,
        // Deterministic pagination: `id` is the final unique tiebreaker.
        orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }],
      }),
    )
  })
})
