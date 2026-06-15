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
  /** Display group: "app" = product surfaces, "ops" = operator/QA surfaces.
   *  Defaults to "app" when unset. Drives the Apps/Ops split in `ibx dev urls`. */
  group?: "app" | "ops"
  /** True for cross-repo services (../adjudicate) — preflight warns if that
   *  sibling repo's node_modules is missing. */
  crossRepo?: boolean
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
    group: "app",
  },

  // ── Operator / QA surfaces (group: "ops") ───────────────────────────────────

  "qa-viewer": {
    key: "qa-viewer",
    name: "QA Viewer",
    filter: "@ibatexas/qa-viewer",
    script: "dev",
    port: 3010,
    healthUrl: "http://localhost:3010",
    logColor: chalk.magenta,
    logPrefix: "qa-viewer",
    available: true,
    step: 5,
    urls: [{ label: "QA Viewer", url: "http://localhost:3010" }],
    group: "ops",
  },

  "adj-console": {
    key: "adj-console",
    name: "Adjudicate Console",
    filter: "@adjudicate/console",
    script: "dev",
    port: 5180,
    healthUrl: "http://localhost:5180",
    logColor: chalk.blueBright,
    logPrefix: "adj-console",
    available: true,
    step: 5,
    urls: [{ label: "Console", url: "http://localhost:5180" }],
    group: "ops",
    crossRepo: true,
  },

  adjutant: {
    key: "adjutant",
    name: "Adjutant Console",
    filter: "@adjudicate/adjutant-console",
    script: "dev",
    port: 5182,
    healthUrl: "http://localhost:5182",
    logColor: chalk.redBright,
    logPrefix: "adjutant",
    available: true,
    step: 5,
    urls: [{ label: "Adjutant", url: "http://localhost:5182" }],
    group: "ops",
    crossRepo: true,
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
// MOVED to @ibatexas/tools (src/infra/endpoints.ts) by T1a-10: the journeys
// harness pre-flight resolves addresses through the same source for its
// hostname denylist, and journeys may never import the cli (D-010 dependency
// direction: journeys→tools, cli→tools). Re-exported here so `ibx dev urls` /
// `ibx svc status` call sites are unchanged.
export { infraEndpoints, observabilityEndpoints } from "@ibatexas/tools"
export type { InfraEndpoint } from "@ibatexas/tools"
