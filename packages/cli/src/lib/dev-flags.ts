import fs from "node:fs"
import path from "node:path"
import { ROOT } from "../utils/root.js"

/**
 * Behavior-impacting dev flags — the env vars whose presence/value changes how
 * the running stack behaves (auth, embeddings, audit, destructive jobs). Shared
 * by `ibx dev` (startup banner) and `ibx env flags` / `ibx env toggle`.
 *
 * This is intentionally a *small curated* list, NOT the full .env.example —
 * `ibx env check` already validates the required infra/secret vars. These are
 * the knobs a developer actually flips during local work.
 */

export const ENV_PATH = path.join(ROOT, ".env")

export type FlagKind = "bool" | "value" | "secret"

export interface DevFlag {
  key: string
  /** What the flag controls. */
  desc: string
  kind: FlagKind
  /** Effective behaviour when the var is unset (shown as the default). */
  fallback: string
  /** Recommended local-dev value — used by `toggle` (bare form) and highlighted in the banner. */
  devValue?: string
  /** One-line behavioural note. */
  impact: string
  /** Given the effective value, return a warning string when it's a risky/surprising state, else null. */
  alert?: (effective: string | undefined) => string | null
}

const isOn = (v: string | undefined) => v === "true" || v === "1"
const isBlank = (v: string | undefined) => v === undefined || v.trim() === ""

export const DEV_FLAGS: DevFlag[] = [
  {
    key: "IBX_DEV_OTP_BYPASS",
    desc: "Skip Twilio OTP; accept IBX_DEV_OTP_CODE at login",
    kind: "bool",
    fallback: "false",
    devValue: "true",
    impact: "ON → log in locally without Twilio · OFF → real WhatsApp OTP required",
    alert: (v) => (isOn(v) ? "OTP bypass ACTIVE — dev only, never enable in prod" : null),
  },
  {
    key: "IBX_DEV_OTP_CODE",
    desc: "Fixed OTP code accepted under the bypass",
    kind: "value",
    fallback: "(none)",
    devValue: "424242",
    impact: "the code you type at the login screen when bypass is on",
    alert: (v) => (isBlank(v) ? "no code set — bypass login won't work until this is set" : null),
  },
  {
    key: "OPENAI_API_KEY",
    desc: "OpenAI key for embeddings (semantic search / RAG)",
    kind: "secret",
    fallback: "(none) → deterministic-hash fallback",
    impact: "unset → semantic search & product discovery return garbage, silently",
    alert: (v) => (isBlank(v) ? "MISSING — embeddings are fake; semantic search is broken" : null),
  },
  {
    key: "IBX_AUDIT_POSTGRES_ENABLED",
    desc: "Persist the kernel audit trail to Postgres",
    kind: "bool",
    fallback: "false",
    impact: "OFF → no durable audit & `ibx kernel replay` has nothing to read",
  },
  {
    key: "IBX_QA_CONTROL_ENABLED",
    desc: "Expose the /internal/qa/* test-harness routes",
    kind: "bool",
    fallback: "false",
    impact: "OFF → qa-viewer cannot drive journeys/scenarios/agent runs",
  },
  {
    key: "ENABLE_SWAGGER",
    desc: "Serve the Swagger API docs UI",
    kind: "bool",
    fallback: "on (non-prod)",
    impact: "controls /docs availability",
  },
  {
    key: "RETENTION_DRY_RUN",
    desc: "Data-retention cleaner dry-run guard",
    kind: "bool",
    fallback: "false",
    devValue: "true",
    impact: "false → the retention job DELETES old records for real",
    alert: (v) => (isOn(v) ? null : "destructive: retention cleaner deletes for real"),
  },
  {
    key: "STALE_ORDER_DRY_RUN",
    desc: "Stale-order canceller dry-run guard",
    kind: "bool",
    fallback: "false",
    devValue: "true",
    impact: "false → unpaid pending orders are auto-cancelled for real",
    alert: (v) => (isOn(v) ? null : "destructive: stale-order job cancels for real"),
  },
]

export function findFlag(key: string): DevFlag | undefined {
  const want = key.trim().toUpperCase()
  return DEV_FLAGS.find((f) => f.key === want)
}

/** Effective runtime value (process.env already has .env merged by index.ts). */
export function effectiveValue(key: string): string | undefined {
  return process.env[key]
}

/** Raw value as written in the .env *file* (before shell override), or undefined. */
export function envFileValue(key: string, envPath = ENV_PATH): string | undefined {
  if (!fs.existsSync(envPath)) return undefined
  const line = fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`))
  if (line === undefined) return undefined
  // strip inline comment (" #...") then surrounding quotes
  let v = line.slice(line.indexOf("=") + 1).replace(/\s+#.*$/, "").trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  return v
}

/**
 * Upsert `KEY=value` in the .env file in place, preserving every other line and
 * the trailing newline. Quotes the value only when it contains shell-unsafe
 * characters. Returns the previous file value (or undefined if newly added).
 */
export function setEnvFileValue(key: string, value: string, envPath = ENV_PATH): string | undefined {
  if (!fs.existsSync(envPath)) {
    throw new Error(`${envPath} not found — copy .env.example to .env first`)
  }
  const previous = envFileValue(key, envPath)
  const safe = value === "" || /^[A-Za-z0-9_./:+=@,-]+$/.test(value)
  const rendered = safe ? value : `'${value.replace(/'/g, "'\\''")}'`
  const lines = fs.readFileSync(envPath, "utf8").split("\n")
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
  if (idx >= 0) {
    // preserve any inline comment on the existing line
    const comment = lines[idx].match(/\s#.*$/)?.[0] ?? ""
    lines[idx] = `${key}=${rendered}${comment}`
  } else if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.splice(lines.length - 1, 0, `${key}=${rendered}`)
  } else {
    lines.push(`${key}=${rendered}`)
  }
  fs.writeFileSync(envPath, lines.join("\n"))
  return previous
}
