// T1a-4 LIVE contract test — minted cookies against the REAL ephemeral test
// stack. Proves the offline mirror in auth-fixture.test.ts equals the API's
// actual verification path:
//
//   • minted customer cookie  → GET /api/auth/me        → 200 + correct sub
//   • minted staff cookie     → GET /api/admin/tables   → 200 (staff JWT leg
//     of the admin guard, routes/admin/index.ts:126-139; requires the seeded
//     ACTIVE staff row — middleware/auth.ts:178-179)
//   • wrong-secret tokens     → 401 on both surfaces
//
// GATED twice so the package suite stays offline-green:
//   1. env flag — runs ONLY under IBX_LIVE_CONTRACT=1;
//   2. stack handshake — beforeAll verifies /health exposes the SAME
//      testFingerprint as .env.test (T1a-10 contract) and fails with a
//      named hint if the stack is down.
//
// How to run (serialize with other agents via /tmp/ibx-test-stack.lock.d):
//   ./scripts/test-stack-up.sh        # T1a-11a/b: infra + migrate + apps + seed
//   IBX_LIVE_CONTRACT=1 pnpm --filter @ibatexas/journeys exec vitest run \
//     src/clients/__tests__/auth-fixture.live.test.ts
//   ./scripts/test-stack-down.sh      # ALWAYS — including after failures
//
// Containment notes: DB reads go through the SELECT-only oracle role
// (ORACLE_DATABASE_URL, T1a-9); the single mutation in setup is the
// documented staff seeding path `ibx auth create-staff` (the fixture itself
// only mints). Secrets come from the gitignored .env.test and are never
// printed.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  mintCustomerToken,
  mintStaffToken,
  cookieHeader,
} from "../auth-fixture.js"
import { requireOracleDatabaseUrl } from "../../oracle/oracle-database-url.js"

const LIVE = process.env["IBX_LIVE_CONTRACT"] === "1"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../../..")
const ENV_TEST_PATH = path.join(REPO_ROOT, ".env.test")

/** Test-profile api base (process-compose.test.yaml binds :3001). */
const API_BASE = process.env["IBX_TEST_API_URL"] ?? "http://localhost:3001"

/** E.164, outside the SEED_CUSTOMERS range — owned by this test. */
const STAFF_PHONE = "+5519900000777"

// Same shape as the offline tests' WRONG_SECRET: ≥32 chars, never a real value.
const WRONG_SECRET = "aaaabbbbccccddddeeeeffff0000111122223333aaaabbbb"

/** Minimal KEY=VALUE parser for the gitignored .env.test (no dotenv dep). */
function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function requireVar(env: Record<string, string>, name: string): string {
  const value = env[name]
  if (value === undefined || value === "") {
    throw new Error(`.env.test is missing ${name} — regenerate with ./scripts/gen-env-test.sh`)
  }
  return value
}

describe.skipIf(!LIVE)("authFixture live contract (IBX_LIVE_CONTRACT=1, test stack up)", () => {
  let testEnv: Record<string, string>
  let jwtSecret: string
  let staffJwtSecret: string
  let oracle: pg.Client
  let customerId: string
  let staffId: string

  beforeAll(async () => {
    testEnv = parseEnvFile(await readFile(ENV_TEST_PATH, "utf8"))
    jwtSecret = requireVar(testEnv, "JWT_SECRET")
    staffJwtSecret = requireVar(testEnv, "STAFF_JWT_SECRET")
    const fingerprint = requireVar(testEnv, "IBX_TEST_FINGERPRINT")

    // The minting gate (D-010): the harness process carries the SAME
    // fingerprint as the stack it drives.
    vi.stubEnv("IBX_TEST_FINGERPRINT", fingerprint)

    // Stack handshake — refuse to run against anything but THIS test stack.
    let health: Response
    try {
      health = await fetch(`${API_BASE}/health`)
    } catch {
      throw new Error(
        `test stack is not up at ${API_BASE} — run ./scripts/test-stack-up.sh first`,
      )
    }
    const body = (await health.json()) as { testFingerprint?: string }
    if (body.testFingerprint !== fingerprint) {
      throw new Error(
        `/health testFingerprint does not match .env.test — refusing (wrong stack?)`,
      )
    }

    // Read-only oracle connection (T1a-9 role) for precondition lookups.
    oracle = new pg.Client({ connectionString: requireOracleDatabaseUrl(testEnv) })
    await oracle.connect()

    // Customer precondition: any customer seeded by `ibx test seed`
    // (SEED_CUSTOMERS via packages/domain seed-domain).
    const customers = await oracle.query("SELECT id FROM ibx_domain.customers LIMIT 1")
    if (customers.rows.length === 0) {
      throw new Error("no seeded customers — run `ibx test seed` (test-stack-up step 4/4)")
    }
    customerId = (customers.rows[0] as { id: string }).id

    // Staff precondition: the DOCUMENTED seeding path (`ibx auth create-staff`,
    // packages/cli/src/commands/auth.ts:168-218). Idempotent: an existing
    // inactive row is reactivated, an active one is left alone. The .env.test
    // contract (DATABASE_URL et al.) is passed explicitly — shell env beats
    // the CLI's dotenv load.
    execFileSync(
      "ibx",
      ["auth", "create-staff", "--phone", STAFF_PHONE, "--name", "Journey Fixture Staff", "--role", "MANAGER"],
      { cwd: REPO_ROOT, env: { ...process.env, ...testEnv }, stdio: "pipe" },
    )
    const staff = await oracle.query(
      "SELECT id, active FROM ibx_domain.staff WHERE phone = $1",
      [STAFF_PHONE],
    )
    if (staff.rows.length === 0) {
      throw new Error("ibx auth create-staff did not produce a staff row")
    }
    const row = staff.rows[0] as { id: string; active: boolean }
    expect(row.active).toBe(true) // middleware/auth.ts:179 requires ACTIVE
    staffId = row.id
  }, 120_000)

  afterAll(async () => {
    await oracle?.end().catch(() => undefined)
    vi.unstubAllEnvs()
  })

  it("minted customer cookie → GET /api/auth/me → 200 with the minted sub", async () => {
    const minted = mintCustomerToken({ customerId, jwtSecret })
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { cookie: cookieHeader(minted) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBe(customerId)
  }, 30_000)

  it("minted staff cookie + seeded ACTIVE staff row → staff route → 200", async () => {
    const minted = mintStaffToken({ staffId, role: "MANAGER", staffJwtSecret })
    const res = await fetch(`${API_BASE}/api/admin/tables`, {
      headers: { cookie: cookieHeader(minted) },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tables: unknown[] }
    expect(Array.isArray(body.tables)).toBe(true)
  }, 30_000)

  it("customer token minted with a WRONG secret → 401", async () => {
    const minted = mintCustomerToken({ customerId, jwtSecret: WRONG_SECRET })
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { cookie: cookieHeader(minted) },
    })
    expect(res.status).toBe(401)
  }, 30_000)

  it("staff token minted with a WRONG secret → 401 on the staff route", async () => {
    const minted = mintStaffToken({ staffId, role: "MANAGER", staffJwtSecret: WRONG_SECRET })
    const res = await fetch(`${API_BASE}/api/admin/tables`, {
      headers: { cookie: cookieHeader(minted) },
    })
    expect(res.status).toBe(401)
  }, 30_000)
})
