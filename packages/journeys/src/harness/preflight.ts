// harness/preflight.ts — T1a-10 environment handshake.
//
// The journeys harness REFUSES to drive any stack that does not prove it is
// the ephemeral test profile. Four checks run — ALL of them, every time, so
// the JSONL trace (`preflight.check` events via @ibatexas/tools) records the
// complete picture even when the first check already fails:
//
//   fingerprint  GET /health must expose `testFingerprint` and it must equal
//                the harness's own IBX_TEST_FINGERPRINT (D-010: only the test
//                profile sets the var; dev/prod never do).
//   hostnames    The resolved api/commerce/infra hosts (api + MEDUSA_URL +
//                infraEndpoints() from @ibatexas/tools — the same address
//                source as `ibx dev urls`) must ALL be local/ephemeral.
//                Obvious prod/dev hostnames are denylisted; anything
//                non-local is refused fail-closed.
//   model        ANTHROPIC_MODEL must equal the certification target
//                (claude-sonnet-4-6, D-010). The explicit `nonCertifying`
//                escape (option or IBX_JOURNEY_NON_CERTIFYING=1 — DR-1's dev
//                profile) marks the run non-certifying instead of failing.
//   api-key      ANTHROPIC_API_KEY must be present. Its VALUE is never
//                logged, traced, or embedded in any error message.
//
// Any failed check ⇒ `PreflightRefusalError` (named error — the run never
// starts). The runner (src/runner/run-journey.ts) executes this as its
// mandatory first step.

import { emitPreflightCheck, infraEndpoints } from "@ibatexas/tools"

// ── Contract pins (D-010) ────────────────────────────────────────────────────

/** Certifying runs require ANTHROPIC_MODEL to equal exactly this (DR-1/D-010). */
export const CERTIFICATION_MODEL = "claude-sonnet-4-6"

/** Only the test profile sets this; /health exposes it as `testFingerprint`. */
export const TEST_FINGERPRINT_ENV = "IBX_TEST_FINGERPRINT"

/** Env escape hatch for DR-1's dev profile (equivalent to `nonCertifying: true`). */
export const NON_CERTIFYING_ENV = "IBX_JOURNEY_NON_CERTIFYING"

// ── Types ────────────────────────────────────────────────────────────────────

export type PreflightCheckName = "fingerprint" | "hostnames" | "model" | "api-key"

export const PREFLIGHT_CHECKS: readonly PreflightCheckName[] = [
  "fingerprint",
  "hostnames",
  "model",
  "api-key",
]

export interface PreflightCheckRecord {
  name: PreflightCheckName
  ok: boolean
  /** Human-readable outcome. NEVER contains secret values. */
  detail: string
}

export interface PreflightResult {
  ok: true
  /**
   * true only when ANTHROPIC_MODEL === CERTIFICATION_MODEL and the
   * nonCertifying escape was NOT used. Non-certifying runs still execute —
   * they are recorded as such (sim_runs, T1b-5).
   */
  certifying: boolean
  checks: PreflightCheckRecord[]
}

/** Named refusal: one or more pre-flight checks failed — the run never starts. */
export class PreflightRefusalError extends Error {
  readonly checks: PreflightCheckRecord[]

  constructor(checks: PreflightCheckRecord[]) {
    const failures = checks.filter((c) => !c.ok)
    const summary = failures.map((f) => `[${f.name}] ${f.detail}`).join("; ")
    super(`preflight_refused: ${summary}`)
    this.name = "PreflightRefusalError"
    this.checks = checks
  }
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface PreflightOptions {
  /** Env source (default `process.env`) — injectable for tests. */
  env?: Record<string, string | undefined>
  /** Fetch implementation (default `globalThis.fetch`) — injectable for tests. */
  fetchImpl?: FetchLike
  /** SUT api base URL (default env.NEXT_PUBLIC_API_URL ?? http://localhost:3001). */
  apiBaseUrl?: string
  /** Commerce base URL (default env.MEDUSA_URL ?? env.MEDUSA_BACKEND_URL ?? :9000). */
  commerceBaseUrl?: string
  /**
   * Explicit non-certifying escape (DR-1 dev profile): a model other than the
   * certification target is tolerated and the run is MARKED non-certifying
   * instead of refused. Defaults from IBX_JOURNEY_NON_CERTIFYING ("1"/"true").
   */
  nonCertifying?: boolean
  /** Stamped onto the preflight.check trace events when known. */
  journeyId?: string
  runId?: string
  /** GET /health timeout (ms). */
  timeoutMs?: number
}

// ── Hostname denylist / local-host classification ───────────────────────────

/** Hosts considered local/ephemeral. Everything else is refused fail-closed. */
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
])

/**
 * Obvious prod/dev hostname fragments — matched case-insensitively against
 * the full hostname for a sharper refusal message. NOT the safety boundary
 * (any non-local host is refused regardless); this only names the offense.
 */
const DENYLIST_FRAGMENTS = [
  "ibatexas.com",
  "ibatexas.app",
  "prod",
  "production",
  "staging",
  "dev.",
  "amazonaws.com",
  "rds.",
  "supabase.",
  "neon.tech",
  "upstash.",
  "railway.app",
  "fly.dev",
  "render.com",
  "herokuapp.com",
  "vercel.app",
]

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (LOCAL_HOSTNAMES.has(h)) return true
  // 127.0.0.0/8 loopback range
  return /^127(\.\d{1,3}){3}$/.test(h)
}

function denylistedFragment(hostname: string): string | undefined {
  const h = hostname.toLowerCase()
  return DENYLIST_FRAGMENTS.find((frag) => h.includes(frag))
}

interface NamedHost {
  name: string
  hostname: string
}

/** Parse a hostname out of an address that may be a URL, host:port, or host. */
function hostnameOf(address: string): string {
  try {
    const url = address.includes("://") ? new URL(address) : new URL(`tcp://${address}`)
    return url.hostname
  } catch {
    return address
  }
}

// ── Individual checks ────────────────────────────────────────────────────────

async function checkFingerprint(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  timeoutMs: number,
): Promise<PreflightCheckRecord> {
  const own = env[TEST_FINGERPRINT_ENV]
  if (!own) {
    return {
      name: "fingerprint",
      ok: false,
      detail: `harness env does not set ${TEST_FINGERPRINT_ENV} — only the test profile (.env.test) carries it`,
    }
  }

  const healthUrl = `${apiBaseUrl.replace(/\/$/, "")}/health`
  let body: unknown
  try {
    const res = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(timeoutMs) })
    // Identity check, not a health check: a 503 (degraded boot) still carries
    // testFingerprint — stack HEALTH is asserted elsewhere (post-run /health).
    body = await res.json()
  } catch (err) {
    return {
      name: "fingerprint",
      ok: false,
      detail: `GET ${healthUrl} failed (${(err as Error).message}) — cannot verify the SUT is the test profile`,
    }
  }

  const reported =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["testFingerprint"]
      : undefined

  if (typeof reported !== "string" || reported === "") {
    return {
      name: "fingerprint",
      ok: false,
      detail: `${healthUrl} exposes no testFingerprint — the SUT was not booted with ${TEST_FINGERPRINT_ENV} (refusing to drive a non-test stack)`,
    }
  }
  if (reported !== own) {
    return {
      name: "fingerprint",
      ok: false,
      detail: `testFingerprint mismatch — the SUT belongs to a different test run (got "${reported}", expected "${own}")`,
    }
  }
  return { name: "fingerprint", ok: true, detail: `testFingerprint matches ("${own}")` }
}

function checkHostnames(
  env: Record<string, string | undefined>,
  apiBaseUrl: string,
  commerceBaseUrl: string,
): PreflightCheckRecord {
  const hosts: NamedHost[] = [
    { name: "api", hostname: hostnameOf(apiBaseUrl) },
    { name: "commerce", hostname: hostnameOf(commerceBaseUrl) },
    // Same address source as `ibx dev urls` (moved cli→tools by T1a-10 so
    // journeys can reach it without importing the cli).
    ...infraEndpoints(env).map((ep) => ({ name: ep.name, hostname: hostnameOf(ep.address) })),
  ]

  const offenders = hosts
    .filter((h) => !isLocalHost(h.hostname))
    .map((h) => {
      const frag = denylistedFragment(h.hostname)
      return frag
        ? `${h.name}=${h.hostname} (denylisted: "${frag}" — prod/dev hostname)`
        : `${h.name}=${h.hostname} (not a local/ephemeral host)`
    })

  if (offenders.length > 0) {
    return {
      name: "hostnames",
      ok: false,
      detail: `non-local endpoint(s) refused: ${offenders.join(", ")}`,
    }
  }
  const summary = hosts.map((h) => `${h.name}=${h.hostname}`).join(", ")
  return {
    name: "hostnames",
    ok: true,
    detail: `all endpoints local/ephemeral: ${summary}`,
  }
}

function checkModel(
  env: Record<string, string | undefined>,
  nonCertifying: boolean,
): { record: PreflightCheckRecord; certifying: boolean } {
  const model = env["ANTHROPIC_MODEL"]
  if (!model) {
    return {
      record: {
        name: "model",
        ok: false,
        detail:
          "ANTHROPIC_MODEL is not set — required even for non-certifying runs (the api fail-fasts at boot without it)",
      },
      certifying: false,
    }
  }
  if (model === CERTIFICATION_MODEL) {
    return nonCertifying
      ? {
          record: {
            name: "model",
            ok: true,
            detail: `model=${model} but the nonCertifying escape is set — run marked NON-certifying`,
          },
          certifying: false,
        }
      : {
          record: {
            name: "model",
            ok: true,
            detail: `model=${model} == certification target — run is certifying`,
          },
          certifying: true,
        }
  }
  if (nonCertifying) {
    return {
      record: {
        name: "model",
        ok: true,
        detail: `model=${model} != certification target ${CERTIFICATION_MODEL} — nonCertifying escape set, run marked NON-certifying (DR-1 dev profile)`,
      },
      certifying: false,
    }
  }
  return {
    record: {
      name: "model",
      ok: false,
      detail: `ANTHROPIC_MODEL=${model} != certification target ${CERTIFICATION_MODEL} — set the nonCertifying escape (${NON_CERTIFYING_ENV}=1) to run anyway as non-certifying`,
    },
    certifying: false,
  }
}

function checkApiKey(env: Record<string, string | undefined>): PreflightCheckRecord {
  const key = env["ANTHROPIC_API_KEY"]
  // Presence only — the value must never appear in details, traces, or errors.
  if (typeof key !== "string" || key.length === 0) {
    return { name: "api-key", ok: false, detail: "ANTHROPIC_API_KEY is missing or empty" }
  }
  return { name: "api-key", ok: true, detail: "ANTHROPIC_API_KEY present (value not logged)" }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Run the four-part environment handshake. EVERY check is executed and
 * recorded into the JSONL trace as a `preflight.check` event; if any check
 * failed, throws `PreflightRefusalError` naming all failures. On success
 * returns the records plus the certifying flag.
 */
export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const apiBaseUrl =
    options.apiBaseUrl ?? env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001"
  const commerceBaseUrl =
    options.commerceBaseUrl ??
    env["MEDUSA_URL"] ??
    env["MEDUSA_BACKEND_URL"] ??
    "http://localhost:9000"
  const nonCertifying =
    options.nonCertifying ?? ["1", "true"].includes(env[NON_CERTIFYING_ENV] ?? "")
  const timeoutMs = options.timeoutMs ?? 5_000

  const fingerprint = await checkFingerprint(env, fetchImpl, apiBaseUrl, timeoutMs)
  const hostnames = checkHostnames(env, apiBaseUrl, commerceBaseUrl)
  const model = checkModel(env, nonCertifying)
  const apiKey = checkApiKey(env)

  const checks: PreflightCheckRecord[] = [fingerprint, hostnames, model.record, apiKey]

  for (const check of checks) {
    emitPreflightCheck({
      check: check.name,
      outcome: check.ok ? "pass" : "fail",
      detail: check.detail,
      ...(options.journeyId === undefined ? {} : { journey: options.journeyId }),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    })
  }

  if (checks.some((c) => !c.ok)) {
    throw new PreflightRefusalError(checks)
  }

  return { ok: true, certifying: model.certifying, checks }
}
