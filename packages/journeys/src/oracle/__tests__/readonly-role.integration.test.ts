// T1a-9 integration test — the SELECT-only oracle role, provisioned by the
// REAL scripts/test-stack/create-readonly-role.sql against a real Postgres.
//
// Why a testcontainer, not a mock: the property under test IS the Postgres
// privilege boundary — ibx_oracle_ro can SELECT from the public (intent_audit)
// and ibx_domain schemas, while INSERT/UPDATE/DELETE/CREATE fail with SQLSTATE
// 42501 insufficient_privilege. A mock would only pin SQL strings.
//
// The test applies the checked-in SQL (substituting the __ORACLE_PASSWORD__
// sentinel exactly like scripts/test-stack/provision-oracle-role.sh does) as
// the same role that created the tables — mirroring the test-stack-up path
// where the compose POSTGRES_USER runs both migrations and provisioning.
//
// Convention mirror (apps/api audit-read-paths.test.ts): local opt-out via
// IBX_SKIP_REAL_POSTGRES=1; CI runs real. Image matches the test stack's
// Postgres major (17).
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers"

const SKIP_REAL_POSTGRES = process.env["IBX_SKIP_REAL_POSTGRES"] === "1"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../../..")
const SQL_PATH = path.join(REPO_ROOT, "scripts/test-stack/create-readonly-role.sql")

const ADMIN_USER = "ibatexas"
const ADMIN_PASSWORD = "ibx-admin-test-pw"
const DB_NAME = "ibatexas_test"
const ORACLE_PASSWORD = "0123456789abcdef0123456789abcdef" // hex, like gen-env-test.sh

async function loadProvisioningSql(): Promise<string> {
  const template = await readFile(SQL_PATH, "utf8")
  expect(template).toContain("__ORACLE_PASSWORD__")
  return template.replaceAll("__ORACLE_PASSWORD__", ORACLE_PASSWORD)
}

/** Runs `query` and returns the SQLSTATE it failed with (fails the test if it succeeds). */
async function sqlStateOf(client: pg.Client, query: string): Promise<string | undefined> {
  try {
    await client.query(query)
  } catch (error) {
    return (error as { code?: string }).code
  }
  expect.fail(`query unexpectedly succeeded for the read-only role: ${query}`)
}

describe.skipIf(SKIP_REAL_POSTGRES)(
  "ibx_oracle_ro — SELECT-only oracle role (postgres testcontainer)",
  () => {
    let container: StartedTestContainer
    let admin: pg.Client
    let oracle: pg.Client

    beforeAll(async () => {
      container = await new GenericContainer("postgres:17-alpine")
        .withExposedPorts(5432)
        .withEnvironment({
          POSTGRES_USER: ADMIN_USER,
          POSTGRES_PASSWORD: ADMIN_PASSWORD,
          POSTGRES_DB: DB_NAME,
        })
        // initdb restarts postgres once; the port being open is not enough.
        .withWaitStrategy(
          Wait.forLogMessage(/database system is ready to accept connections/, 2),
        )
        .withStartupTimeout(120_000)
        .start()

      const host = container.getHost()
      const port = container.getMappedPort(5432)

      admin = new pg.Client({
        host,
        port,
        user: ADMIN_USER,
        password: ADMIN_PASSWORD,
        database: DB_NAME,
      })
      await admin.connect()

      // Stand-in for the migration layers: the two schemas the role covers,
      // one audit-shaped table in public, one domain table in ibx_domain.
      await admin.query(`
        CREATE SCHEMA ibx_domain;
        CREATE TABLE public.intent_audit (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          intent_kind TEXT NOT NULL,
          session_id TEXT NOT NULL,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE ibx_domain.order_projections (
          id TEXT PRIMARY KEY,
          version INTEGER NOT NULL
        );
        INSERT INTO public.intent_audit (intent_kind, session_id)
          VALUES ('order.checkout.create', 'web:sess-t1a9');
        INSERT INTO ibx_domain.order_projections (id, version)
          VALUES ('ord_t1a9', 1);
      `)

      // Apply the real provisioning SQL — twice, to pin idempotency
      // (second run takes the ALTER ROLE re-sync path).
      const provisioningSql = await loadProvisioningSql()
      await admin.query(provisioningSql)
      await admin.query(provisioningSql)

      oracle = new pg.Client({
        host,
        port,
        user: "ibx_oracle_ro",
        password: ORACLE_PASSWORD,
        database: DB_NAME,
      })
      await oracle.connect()
    }, 180_000)

    afterAll(async () => {
      await oracle?.end().catch(() => undefined)
      await admin?.end().catch(() => undefined)
      await container?.stop()
    }, 60_000)

    it("SELECT succeeds on the public (intent_audit) schema", async () => {
      const result = await oracle.query(
        "SELECT intent_kind, session_id FROM public.intent_audit",
      )
      expect(result.rows).toEqual([
        { intent_kind: "order.checkout.create", session_id: "web:sess-t1a9" },
      ])
    })

    it("SELECT succeeds on the ibx_domain schema", async () => {
      const result = await oracle.query(
        "SELECT id, version FROM ibx_domain.order_projections",
      )
      expect(result.rows).toEqual([{ id: "ord_t1a9", version: 1 }])
    })

    it("INSERT fails with insufficient_privilege (42501) on both schemas", async () => {
      expect(
        await sqlStateOf(
          oracle,
          `INSERT INTO public.intent_audit (intent_kind, session_id) VALUES ('forged.kind', 'x')`,
        ),
      ).toBe("42501")
      expect(
        await sqlStateOf(
          oracle,
          `INSERT INTO ibx_domain.order_projections (id, version) VALUES ('ord_forged', 1)`,
        ),
      ).toBe("42501")
    })

    it("UPDATE fails with insufficient_privilege (42501) on both schemas", async () => {
      expect(
        await sqlStateOf(oracle, `UPDATE public.intent_audit SET session_id = 'tampered'`),
      ).toBe("42501")
      expect(
        await sqlStateOf(oracle, `UPDATE ibx_domain.order_projections SET version = 99`),
      ).toBe("42501")
    })

    it("DELETE and TRUNCATE fail with insufficient_privilege (42501)", async () => {
      expect(await sqlStateOf(oracle, `DELETE FROM public.intent_audit`)).toBe("42501")
      expect(await sqlStateOf(oracle, `TRUNCATE ibx_domain.order_projections`)).toBe("42501")
    })

    it("CREATE TABLE fails with insufficient_privilege (42501) in both schemas", async () => {
      expect(await sqlStateOf(oracle, `CREATE TABLE public.oracle_escape (id INT)`)).toBe(
        "42501",
      )
      expect(await sqlStateOf(oracle, `CREATE TABLE ibx_domain.oracle_escape (id INT)`)).toBe(
        "42501",
      )
    })

    it("tables created AFTER provisioning stay SELECT-able (default privileges — monthly intent_audit partitions)", async () => {
      await admin.query(`
        CREATE TABLE public.intent_audit_2026_07 (id INT);
        INSERT INTO public.intent_audit_2026_07 (id) VALUES (7);
      `)
      const result = await oracle.query("SELECT id FROM public.intent_audit_2026_07")
      expect(result.rows).toEqual([{ id: 7 }])
      expect(
        await sqlStateOf(oracle, `INSERT INTO public.intent_audit_2026_07 (id) VALUES (8)`),
      ).toBe("42501")
    })

    it("fails loudly when applied before the migration layers (no ibx_domain schema)", async () => {
      await admin.query(`CREATE DATABASE ordering_guard_check`)
      const bare = new pg.Client({
        host: container.getHost(),
        port: container.getMappedPort(5432),
        user: ADMIN_USER,
        password: ADMIN_PASSWORD,
        database: "ordering_guard_check",
      })
      await bare.connect()
      try {
        await expect(admin.query("SELECT 1")).resolves.toBeDefined() // sanity: admin link alive
        await expect(bare.query(await loadProvisioningSql())).rejects.toThrow(/ibx_domain/)
      } finally {
        await bare.end()
      }
    })
  },
)
