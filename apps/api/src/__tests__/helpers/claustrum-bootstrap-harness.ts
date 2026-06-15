// T2-6a — pg/pgvector + Redis test harness for bootstrap-level claustrum
// tests (the scripted-pipeline harness substrate).
//
// Composes the repo's two established real-infra patterns into one setup:
//
//   - Postgres: the `audit-read-paths.test.ts` / `h3-postgres-container.ts`
//     pattern — a real container with the @adjudicate/audit-postgres
//     migrations applied via the SAME runner `ibx db provision` uses
//     (packages/cli/src/lib/kernel-migrate.ts, loaded through a computed
//     dynamic import because apps/api's tsconfig `rootDir: src` would trip
//     TS6059 on a static cross-package source import). `bootstrapClaustrum()`
//     probes `intent_audit` (table + partitions + record_version CHECK) at
//     boot, so a mock cannot stand in.
//   - Redis: `helpers/redis-testcontainer.ts` (reused directly) — the
//     bootstrap connects the execution ledger and the audit-sink spill
//     through `getRedisClient()` (`REDIS_URL`).
//
// The harness also pins the bootstrap's REQUIRED env contract (the D-008
// fail-fast vars + the WebChannel signing key) and restores every variable it
// touched on teardown:
//
//   DATABASE_URL            → the postgres container
//   REDIS_URL               → the redis container
//   ANTHROPIC_MODEL         → certification target id (requireEnv fail-fast;
//                             never called when a scripted ModelProvider is
//                             injected — zero token cost by construction)
//   EMBEDDING_MODEL_ID      → scripted id (requireEnv fail-fast; same note)
//   WEB_GATEWAY_SIGNING_KEY → fixed test-plane key (≥32 chars; requireSecret)
//   AUDIT_REDACT_SECRET     → fixed test-plane salt (deterministic hashed
//                             session ids; silences the empty-salt warn)
//
// pgvector note: the default image is `postgres:15-alpine` (the repo's
// established container; production-matching). The pgvector EXTENSION is not
// needed at bootstrap level — `createPgVectorGroundingProvider` does no I/O at
// construction and `retrieve()` is fail-safe-wrapped (D-009). Turn-level
// scripted tests that exercise real grounding SQL (T2-6b+) can pass
// `postgresImage: "pgvector/pgvector:pg15"` and apply the claustrum migration
// layer themselves.
//
// Skip behaviour: mirrors both source patterns — `IBX_SKIP_REAL_POSTGRES=1` /
// `IBX_SKIP_REAL_REDIS=1` for local-only dev; CI runs real containers.

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";
import {
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./redis-testcontainer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// helpers → __tests__ → src → api → apps → repo root
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

/** True when the bootstrap-harness suites should run (both infra legs). */
export const RUN_BOOTSTRAP_HARNESS =
  process.env["IBX_SKIP_REAL_POSTGRES"] !== "1" &&
  process.env["IBX_SKIP_REAL_REDIS"] !== "1";

// Fixed test-plane values — not secrets (they exist only inside throwaway
// containers in a vitest process). WEB_GATEWAY_SIGNING_KEY must satisfy
// requireSecret's 32-char minimum.
const TEST_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  // D-010 certification target. The id is never sent anywhere in scripted
  // compositions (the injected ModelProvider replaces the SDK client); it
  // satisfies the requireEnv fail-fast contract with the canonical value.
  ANTHROPIC_MODEL: "claude-sonnet-4-6",
  EMBEDDING_MODEL_ID: "scripted-embedding-test",
  WEB_GATEWAY_SIGNING_KEY:
    "ibx-test-web-gateway-signing-key-0123456789abcdef0123456789abcdef",
  AUDIT_REDACT_SECRET: "ibx-test-audit-redact-secret",
};

// ── kernel-migrate facade (computed dynamic import — see module header) ──────

interface PgClientLike {
  query(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

interface KernelMigrateLib {
  resolveAuditMigrationsDir(root: string, override?: string): string;
  runAuditMigrations(
    client: PgClientLike,
    opts: {
      migrationsDir: string;
      now: Date;
      partitionsBack?: number;
      partitionsForward?: number;
      log?: (msg: string) => void;
    },
  ): Promise<{
    applied: string[];
    skipped: string[];
    partitionsEnsured: string[];
  }>;
}

async function loadKernelMigrateLib(): Promise<KernelMigrateLib> {
  const modulePath = path.join(
    REPO_ROOT,
    "packages/cli/src/lib/kernel-migrate.ts",
  );
  return (await import(modulePath)) as KernelMigrateLib;
}

// ── Harness ──────────────────────────────────────────────────────────────────

export interface ClaustrumBootstrapHarnessOptions {
  /** Override the postgres image (e.g. "pgvector/pgvector:pg15" for T2-6b). */
  readonly postgresImage?: string;
  /** Extra env to pin for the suite (restored on teardown like the rest). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ClaustrumBootstrapTestHarness {
  /** Connection string of the migrated audit-postgres container. */
  readonly pgUrl: string;
  /** URL of the redis container (also exported as REDIS_URL). */
  readonly redisUrl: string;
  /** The redis-testcontainer harness (direct client access for assertions). */
  readonly redis: RedisTestHarness;
  /**
   * Stop both containers and restore every env var the harness touched.
   * Does NOT close the shared `@ibatexas/tools` Redis singleton — the test
   * owns that (call `closeRedisClient()` BEFORE teardown so the client does
   * not reconnect-spin against a stopped container).
   */
  readonly teardown: () => Promise<void>;
}

/**
 * Boot postgres (audit migrations applied) + redis containers and pin the
 * bootstrap env contract. Call from `beforeAll` with a generous timeout
 * (~240s: two image pulls + initdb + migrations on a cold cache).
 */
export async function setupClaustrumBootstrapHarness(
  options: ClaustrumBootstrapHarnessOptions = {},
): Promise<ClaustrumBootstrapTestHarness> {
  const image = options.postgresImage ?? "postgres:15-alpine";

  // Boot both containers concurrently — they are independent.
  const [pgContainer, redisHarness] = await Promise.all([
    new GenericContainer(image)
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: "ibx_test",
        POSTGRES_PASSWORD: "ibx_test",
        POSTGRES_DB: "ibx_bootstrap_test",
      })
      // initdb restarts postgres once; the port being open is not enough.
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .withStartupTimeout(120_000)
      .start(),
    setupRedisTestContainer(),
  ]);

  let stopped = false;
  const stopContainers = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all([
      pgContainer
        .stop({ remove: true, timeout: 10_000 })
        .catch(() => undefined),
      redisHarness.teardown(),
    ]);
  };

  const pgUrl =
    `postgresql://ibx_test:ibx_test@${pgContainer.getHost()}:` +
    `${pgContainer.getMappedPort(5432)}/ibx_bootstrap_test`;

  // Apply the audit-postgres migrations + intent_audit partitions with the
  // CLI's runner, on a single pg.Client (the runner wraps each file in
  // BEGIN/COMMIT — a Pool would spread the transaction across connections).
  try {
    const { resolveAuditMigrationsDir, runAuditMigrations } =
      await loadKernelMigrateLib();
    const migrationClient = new pg.Client({ connectionString: pgUrl });
    await migrationClient.connect();
    try {
      await runAuditMigrations(migrationClient, {
        migrationsDir: resolveAuditMigrationsDir(REPO_ROOT),
        now: new Date(),
      });
    } finally {
      await migrationClient.end();
    }
  } catch (err) {
    await stopContainers();
    throw err;
  }

  // Pin the env contract; remember prior values for restoration.
  const pinned: Record<string, string> = {
    ...TEST_ENV_DEFAULTS,
    ...options.env,
    DATABASE_URL: pgUrl,
    REDIS_URL: redisHarness.url,
  };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(pinned)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  return {
    pgUrl,
    redisUrl: redisHarness.url,
    redis: redisHarness,
    async teardown() {
      for (const [key, prior] of saved) {
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      }
      await stopContainers();
    },
  };
}
