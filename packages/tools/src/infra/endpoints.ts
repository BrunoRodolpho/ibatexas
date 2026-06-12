// infra/endpoints.ts — infra address resolution (source of truth).
//
// MOVED from `packages/cli/src/services.ts` (T1a-10, per D-010): the journeys
// harness pre-flight needs the resolved infra addresses for its hostname
// denylist, and the dependency direction is journeys→tools / cli→tools —
// journeys may NEVER import the cli. The cli re-exports this module from
// `services.ts`, so `ibx dev urls` / `ibx svc status` call sites are
// unchanged and this stays the single port source of truth.
//
// Resolves the docker-compose infra addresses from env (same vars + defaults
// as docker-compose.yml — dev ports 5433/6379/8108/4222; the test stack
// overrides via .env.test).

export interface InfraEndpoint {
  name: string
  address: string
}

/** Resolve the docker-compose infra addresses from env (same vars + defaults as
 *  docker-compose.yml). Source-of-truth for infra ports shown by `ibx dev urls`,
 *  probed by `ibx svc status`, and denylist-checked by the journeys pre-flight.
 *  `env` is injectable for tests; defaults to `process.env`. */
export function infraEndpoints(
  env: Record<string, string | undefined> = process.env,
): InfraEndpoint[] {
  const databaseUrl = env.DATABASE_URL ?? ""
  const redisUrl = env.REDIS_URL ?? "redis://localhost:6379"
  const typesenseHost = env.TYPESENSE_HOST ?? "localhost"
  const typesensePort = env.TYPESENSE_PORT ?? "8108"
  const natsUrl = env.NATS_URL ?? "nats://localhost:4222"

  const dbUrl = new URL(databaseUrl || "postgresql://localhost:5433/ibatexas")
  const redisUrlParsed = new URL(redisUrl)
  const natsUrlParsed = new URL(natsUrl)

  return [
    { name: "PostgreSQL", address: `${dbUrl.hostname}:${dbUrl.port || 5433}` },
    { name: "Redis", address: `${redisUrlParsed.hostname}:${redisUrlParsed.port || 6379}` },
    { name: "Typesense", address: `http://${typesenseHost}:${typesensePort}` },
    { name: "NATS", address: `${natsUrlParsed.hostname}:${natsUrlParsed.port || 4222}` },
  ]
}
