import chalk from "chalk"

// ── Service definition ────────────────────────────────────────────────────────

export interface ServiceUrl {
  label: string
  url: string
}

export interface ServiceDef {
  /** Short key used in CLI args: `ibx dev commerce` */
  key: string
  /** Human-readable name shown in output */
  name: string
  /** pnpm workspace filter, e.g. "@ibatexas/commerce" */
  filter: string
  /** npm script to run in dev mode */
  script: string
  /** Port the service listens on */
  port: number
  /** If set, poll this URL until it responds (with optional expected body) */
  healthUrl?: string
  /** Expected response body text. If omitted, any 2xx is considered healthy. */
  healthExpect?: string
  /** chalk function for colorising this service's log prefix */
  logColor: (s: string) => string
  /** Short prefix shown on each log line: [medusa], [api], etc. */
  logPrefix: string
  /** Whether this service is buildable in the current step */
  available: boolean
  /** Phase 1 step that implements this service (for helpful error messages) */
  step: number
  /** URLs to show in the post-start summary box */
  urls: ServiceUrl[]
  /** Extra info lines for the summary box (e.g. credentials) */
  notes?: string[]
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const SERVICES: Record<string, ServiceDef> = {
  commerce: {
    key: "commerce",
    name: "Medusa Commerce",
    filter: "@ibatexas/commerce",
    script: "dev",
    port: 9000,
    healthUrl: "http://localhost:9000/health",
    healthExpect: "OK",
    logColor: chalk.blue,
    logPrefix: "medusa",
    available: true,
    step: 1,
    urls: [
      { label: "Medusa API  ", url: "http://localhost:9000" },
      { label: "Admin UI   ", url: "http://localhost:9000/app" },
    ],
    notes: [
      `Login: ${process.env.MEDUSA_ADMIN_EMAIL ?? "(definir MEDUSA_ADMIN_EMAIL)"}  /  ${process.env.MEDUSA_ADMIN_PASSWORD ? "****" : "(definir MEDUSA_ADMIN_PASSWORD)"}`,
    ],
  },

  api: {
    key: "api",
    name: "Fastify API",
    filter: "@ibatexas/api",
    script: "dev",
    port: 3001,
    healthUrl: "http://localhost:3001/health",
    logColor: chalk.green,
    logPrefix: "api",
    available: true,
    step: 4,
    urls: [
      { label: "API       ", url: "http://localhost:3001" },
      { label: "Docs      ", url: "http://localhost:3001/docs" },
    ],
  },

  web: {
    key: "web",
    name: "Next.js Web",
    filter: "@ibatexas/web",
    script: "dev",
    port: 3000,
    healthUrl: "http://localhost:3000",
    logColor: chalk.cyan,
    logPrefix: "web",
    available: true,
    step: 5,
    urls: [{ label: "Storefront", url: "http://localhost:3000" }],
  },

  admin: {
    key: "admin",
    name: "Next.js Admin",
    filter: "@ibatexas/admin",
    script: "dev",
    port: 3002,
    healthUrl: "http://localhost:3002",
    logColor: chalk.yellow,
    logPrefix: "admin",
    available: true,
    step: 5,
    urls: [
      { label: "Admin Panel", url: "http://localhost:3002/admin" },
    ],
  },
}

/** Resolve a service key (or "all") into a list of ServiceDefs */
export function resolveServices(key: string | undefined): ServiceDef[] {
  if (!key || key === "default" || key === "all") {
    return Object.values(SERVICES).filter((s) => s.available)
  }

  const svc = SERVICES[key]
  if (!svc) {
    const valid = Object.keys(SERVICES).join(", ")
    throw new Error(`Unknown service "${key}". Valid options: ${valid}, all`)
  }

  if (!svc.available) {
    throw new Error(
      `Service "${key}" is not implemented yet — it is built in Step ${svc.step}. ` +
        `See docs/backlog/TODO-BACKLOG.md for the build order.`
    )
  }

  return [svc]
}

// ── Infrastructure endpoints ────────────────────────────────────────────────

export interface InfraEndpoint {
  name: string
  address: string
}

/** Resolve the docker-compose infra addresses from env (same vars + defaults as
 *  docker-compose.yml). Source-of-truth for infra ports shown by `ibx dev urls`
 *  and probed by `ibx svc status`. */
export function infraEndpoints(): InfraEndpoint[] {
  const databaseUrl = process.env.DATABASE_URL ?? ""
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"
  const typesenseHost = process.env.TYPESENSE_HOST ?? "localhost"
  const typesensePort = process.env.TYPESENSE_PORT ?? "8108"
  const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222"

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
