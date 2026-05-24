// W3 D2 — POST /api/admin/kernel/kill-switch route tests.
//
// Anti-theater (RULE 2): every test in this suite was written FIRST
// and FAILED with 404 (route not registered) before
// `apps/api/src/routes/admin/kernel.ts` existed. After implementation,
// all tests pass; the suite documents the operator-facing contract.
//
// Real-Redis (RULE 3): tests use the shared `setupRedisTestContainer`
// helper so the receipt store + kill-switch flag exercise the actual
// node-redis Lua interpreter, not a Map-backed emulation.
//
// Coverage:
//   - 401 when no JWT and no API key
//   - 403 when ATTENDANT role (requireOwnerRole gate)
//   - 403 when MANAGER role (W7-O4 — OWNER-only per strategy doc)
//   - Step 1 (enable): 202 + receipt + reason carried forward
//   - Step 2 with the SAME staffId is refused (two-person rule, 403)
//   - Step 2 with a DIFFERENT staffId succeeds and flips the Redis flag
//   - Step 1 (disable): mirror flow for the disable action
//   - GET status returns the current Redis state
//   - Receipt is single-use (replay returns 410)
//
// W7-O4 — Role-gate alignment:
//   The strategy doc at `migration/05-kill-switch-strategy.md`
//   §"Authorisation matrix" requires OWNER for global kill-switch toggles.
//   The W3 D2 implementation used `requireManagerRole`; the W6 operational
//   drill (Drill 1, verdict PARTIAL) flagged the mismatch. W7-O4 reconciles
//   the route to OWNER-only and the test fixtures here follow suit — every
//   passing-staffer case below uses OWNER staffRole.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import type { RedisClientType } from "redis"
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod"
import {
  setupRedisTestContainer,
  type RedisTestHarness,
} from "../../../__tests__/helpers/redis-testcontainer.js"

// ── Real Redis harness ─────────────────────────────────────────────────────

let runtimeHarness: RedisTestHarness | null = null

beforeAll(async () => {
  runtimeHarness = await setupRedisTestContainer()
}, 120_000)

afterAll(async () => {
  await runtimeHarness?.teardown()
  runtimeHarness = null
})

function requireRuntimeRedis(): RedisClientType {
  if (!runtimeHarness) {
    throw new Error("real-Redis testcontainer not initialized")
  }
  return runtimeHarness.client
}

// ── Mock the tools redis client to point at the testcontainer ────────────

vi.mock("@ibatexas/tools", async () => {
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>(
    "@ibatexas/tools",
  )
  return {
    ...actual,
    getRedisClient: vi.fn(async () => requireRuntimeRedis()),
    rk: (key: string) => `test-admin:${key}`,
  }
})

beforeEach(async () => {
  if (runtimeHarness) {
    await runtimeHarness.client.flushDb()
  }
})

// ── Fastify app builder ────────────────────────────────────────────────────

interface StaffContext {
  readonly staffId: string | null
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null
  readonly adminApiKeyRole?: "OWNER" | "MANAGER"
}

async function buildApp(defaultStaff: StaffContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Decoration mimics what auth + admin guard would do in production.
  // Fastify's GetterSetter for these optional string fields expects
  // `undefined` (not `null`) as the "absent" sentinel — matches the
  // `declare module "fastify"` shapes in `middleware/auth.ts` and
  // `middleware/staff-auth.ts`. The preHandler below overwrites them
  // with concrete values from the per-test `defaultStaff` / headers.
  app.decorateRequest("staffId", undefined)
  app.decorateRequest("staffRole", undefined)
  app.decorateRequest("adminApiKeyRole", undefined)

  // P0-5 — step 2 tests can override the staff via x-staff-id / x-staff-role
  // headers, mirroring the pattern in force-routes-governance.test.ts.
  app.addHook("preHandler", async (req) => {
    const stub = req as unknown as {
      staffId: string | null
      staffRole: string | null
      adminApiKeyRole?: "OWNER" | "MANAGER"
    }
    const hdrStaffId = req.headers["x-staff-id"]
    const hdrStaffRole = req.headers["x-staff-role"]
    stub.staffId =
      typeof hdrStaffId === "string" ? hdrStaffId : defaultStaff.staffId
    stub.staffRole =
      typeof hdrStaffRole === "string"
        ? hdrStaffRole
        : defaultStaff.staffRole
    if (defaultStaff.adminApiKeyRole && !stub.staffId) {
      stub.adminApiKeyRole = defaultStaff.adminApiKeyRole
    }
  })

  const { adminKernelRoutes } = await import("../kernel.js")
  await app.register(adminKernelRoutes)
  await app.ready()
  return app
}

// W7-O4 — OWNER-only gate (`requireOwnerRole`). The role-passing fixtures
// here are OWNER-typed; the MANAGER fixture below now lives in a 403
// assertion to lock the OWNER-only contract against future regressions.
const OWNER_1: StaffContext = {
  staffId: "staff_owner_1",
  staffRole: "OWNER",
}
const OWNER_2_HEADERS = {
  "x-staff-id": "staff_owner_2",
  "x-staff-role": "OWNER",
}
const MANAGER_1: StaffContext = {
  staffId: "staff_mgr_1",
  staffRole: "MANAGER",
}
const ATTENDANT: StaffContext = {
  staffId: "staff_att_1",
  staffRole: "ATTENDANT",
}
const NO_AUTH: StaffContext = { staffId: null, staffRole: null }

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/admin/kernel/kill-switch — role gate", () => {
  it("returns 401 (or 403) when no JWT + no API key", async () => {
    const app = await buildApp(NO_AUTH)
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "enable", reason: "test" },
    })
    expect([401, 403]).toContain(res.statusCode)
    await app.close()
  })

  it("returns 403 when role is ATTENDANT", async () => {
    const app = await buildApp(ATTENDANT)
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "enable", reason: "test" },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  // W7-O4 — OWNER-only gate. Strategy doc
  // (`migration/05-kill-switch-strategy.md` §"Authorisation matrix") says
  // scope=Global requires OWNER; MANAGER must NOT engage the kill switch.
  it("returns 403 when role is MANAGER (W7-O4: OWNER-only per strategy)", async () => {
    const app = await buildApp(MANAGER_1)
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "enable", reason: "test" },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
  })
})

describe("POST /api/admin/kernel/kill-switch — two-step (enable)", () => {
  it("step 1 returns 202 + receipt + carries the reason", async () => {
    const app = await buildApp(OWNER_1)
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: {
        action: "enable",
        reason: "Refusal-rate spike at 19:35",
      },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json() as {
      confirmationId: string
      prompt: string
      ttlSeconds: number
    }
    expect(body.confirmationId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(body.prompt).toMatch(/kill.switch/i)
    expect(body.ttlSeconds).toBeGreaterThan(0)
    await app.close()
  })

  it("step 2 same actor → 403 (two-person rule)", async () => {
    const app = await buildApp(OWNER_1)
    // Step 1
    const step1 = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "enable", reason: "drill" },
    })
    expect(step1.statusCode).toBe(202)
    const { confirmationId } = step1.json() as { confirmationId: string }
    // Step 2 with the SAME staff
    const step2 = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "confirm", confirmationId },
    })
    expect(step2.statusCode).toBe(403)
    // The Redis flag must NOT be set.
    const raw = await requireRuntimeRedis().get(
      "test-admin:kill-switch:global",
    )
    expect(raw).toBeNull()
    await app.close()
  })

  it("step 2 with a different operator → 200, flag set in Redis", async () => {
    const app = await buildApp(OWNER_1)
    const step1 = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "enable", reason: "incident X" },
    })
    const { confirmationId } = step1.json() as { confirmationId: string }
    const step2 = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "confirm", confirmationId },
      headers: OWNER_2_HEADERS,
    })
    expect(step2.statusCode).toBe(200)
    const body = step2.json() as {
      active: boolean
      reason: string
      enabledBy: string
    }
    expect(body.active).toBe(true)
    expect(body.reason).toBe("incident X")
    expect(body.enabledBy).toContain("staff_owner_1")
    // Confirm the Redis flag is set.
    const raw = await requireRuntimeRedis().get(
      "test-admin:kill-switch:global",
    )
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { reason: string }
    expect(parsed.reason).toBe("incident X")
    await app.close()
  })

  it("receipt is single-use — replay returns 410", async () => {
    const app = await buildApp(OWNER_1)
    const step1 = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "enable", reason: "drill" },
    })
    const { confirmationId } = step1.json() as { confirmationId: string }
    // First step-2 with operator 2 (succeeds).
    await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "confirm", confirmationId },
      headers: OWNER_2_HEADERS,
    })
    // Replay (same receipt, again).
    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "confirm", confirmationId },
      headers: OWNER_2_HEADERS,
    })
    expect(replay.statusCode).toBe(410)
    await app.close()
  })
})

describe("POST /api/admin/kernel/kill-switch — two-step (disable)", () => {
  it("disable step 1 → 202, step 2 → 200 + flag removed", async () => {
    const app = await buildApp(OWNER_1)
    // Pre-engage the flag directly so we have something to release.
    await requireRuntimeRedis().set(
      "test-admin:kill-switch:global",
      JSON.stringify({
        enabledBy: "test-setup",
        enabledAt: new Date().toISOString(),
        reason: "pre-test setup",
      }),
      { EX: 60 },
    )

    const step1 = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "disable", reason: "incident resolved" },
    })
    expect(step1.statusCode).toBe(202)
    const { confirmationId } = step1.json() as { confirmationId: string }

    const step2 = await app.inject({
      method: "POST",
      url: "/api/admin/kernel/kill-switch",
      payload: { action: "confirm", confirmationId },
      headers: OWNER_2_HEADERS,
    })
    expect(step2.statusCode).toBe(200)
    const body = step2.json() as { active: boolean }
    expect(body.active).toBe(false)

    const raw = await requireRuntimeRedis().get(
      "test-admin:kill-switch:global",
    )
    expect(raw).toBeNull()
    await app.close()
  })
})

describe("GET /api/admin/kernel/kill-switch — status", () => {
  it("returns active=false when no flag set", async () => {
    const app = await buildApp(OWNER_1)
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/kernel/kill-switch",
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { active: boolean }
    expect(body.active).toBe(false)
    await app.close()
  })

  it("returns active=true + metadata when flag is set", async () => {
    const app = await buildApp(OWNER_1)
    await requireRuntimeRedis().set(
      "test-admin:kill-switch:global",
      JSON.stringify({
        enabledBy: "staff:test",
        enabledAt: "2026-05-23T12:00:00.000Z",
        reason: "test-status",
      }),
      { EX: 60 },
    )
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/kernel/kill-switch",
    })
    const body = res.json() as {
      active: boolean
      reason: string
      enabledBy: string
    }
    expect(body.active).toBe(true)
    expect(body.reason).toBe("test-status")
    expect(body.enabledBy).toBe("staff:test")
    await app.close()
  })
})
