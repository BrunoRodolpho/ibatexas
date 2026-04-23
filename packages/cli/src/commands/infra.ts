import path from "node:path"
import fs from "node:fs"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { ROOT } from "../utils/root.js"

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_REGION = process.env.AWS_REGION ?? "us-east-1"
const STATE_BUCKET = "ibatexas-terraform-state"
const LOCK_TABLE = "ibatexas-terraform-locks"
const SECRET_PATH_PREFIX = "ibatexas"
const DEFAULT_DEPLOY_TIMEOUT = 15 * 60 * 1000

const VALID_SERVICES = ["api", "web", "admin", "nats", "typesense"] as const

const AUTO_POPULATED_SECRETS = ["REDIS_URL", "NATS_URL"]

const ALL_SECRETS = [
  "JWT_SECRET",
  "DATABASE_URL",
  "SENTRY_DSN",
  "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_VERIFY_SID",
  "NATS_URL",
  "REDIS_URL",
  "TYPESENSE_API_KEY",
  "CORS_ORIGIN",
  "MEDUSA_ADMIN_EMAIL",
  "MEDUSA_ADMIN_PASSWORD",
]

const MANUAL_SECRETS = ALL_SECRETS.filter(s => !AUTO_POPULATED_SECRETS.includes(s))

const GITHUB_SECRETS = [
  "AWS_DEPLOY_ROLE_ARN",
  "DIRECT_DATABASE_URL",
  "STAGING_DIRECT_DATABASE_URL",
  "SONAR_TOKEN",
]

// NEXT_PUBLIC_* values are inlined into the web client bundle at docker build
// time (see apps/web/Dockerfile ARGs + .github/workflows/deploy-staging.yml
// build-args). They must exist as GitHub secrets for the build to pick them up.
// Missing values produce a working build but disable the corresponding feature
// on the client (analytics, error reporting, payments UI).
const BUILD_ARG_SECRETS = [
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
] as const

const BUILD_ARG_VARIABLES: Record<string, string> = {
  NEXT_PUBLIC_POSTHOG_HOST: "https://us.posthog.com",
}

/** Secrets that should use password-style prompt (masked input) */
const SENSITIVE_SECRETS = new Set([
  "JWT_SECRET", "DATABASE_URL", "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "TWILIO_AUTH_TOKEN",
  "TYPESENSE_API_KEY", "MEDUSA_ADMIN_PASSWORD",
])

// ── Secret Validators ─────────────────────────────────────────────────────────

const SECRET_VALIDATORS: Record<string, (v: string) => string | true> = {
  DATABASE_URL:          v => {
    if (!v.startsWith("postgresql://")) return "Must start with postgresql://"
    if (v.includes("supabase.co:5432")) return "Use the pooler connection (port 6543), not direct (port 5432). The direct host is IPv6-only and unreachable from ECS Fargate."
    return true
  },
  CORS_ORIGIN:           v => v.startsWith("http") || "Must be a URL (https://...)",
  STRIPE_SECRET_KEY:     v => v.startsWith("sk_") || "Must start with sk_",
  STRIPE_WEBHOOK_SECRET: v => v.startsWith("whsec_") || "Must start with whsec_",
  ANTHROPIC_API_KEY:     v => v.length > 10 || "API key too short",
}

function validateSecret(name: string, value: string): string | true {
  if (!value.trim()) return "Value cannot be empty"
  const validator = SECRET_VALIDATORS[name]
  return validator ? validator(value) : true
}

/** Cross-secret validation — warn about inconsistencies */
function crossValidateSecrets(secrets: Record<string, string>, env: string): string[] {
  const warnings: string[] = []
  const dbUrl = secrets.DATABASE_URL
  if (secrets.CORS_ORIGIN?.includes("localhost") && env !== "dev") {
    warnings.push(`CORS_ORIGIN contains "localhost" in ${env} environment`)
  }
  if (dbUrl && !dbUrl.includes("supabase") && env !== "dev") {
    warnings.push(`DATABASE_URL doesn't reference Supabase in ${env} — is this intentional?`)
  }
  if (dbUrl?.includes("db.") && dbUrl.includes("supabase.co:5432")) {
    warnings.push(`DATABASE_URL uses direct Supabase host (IPv6-only) — ECS Fargate cannot reach it. Use the pooler URL (port 6543) instead.`)
  }
  return warnings
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getEnvironment(): string {
  return process.env.TF_VAR_environment ?? "dev"
}

function infraDir(env: string): string {
  return path.join(ROOT, `infra/terraform/environments/${env}`)
}

function envBanner(env: string) {
  console.log(chalk.gray(`  Environment: ${chalk.white.bold(env)}\n`))
}

function step(n: number, total: number, msg: string) {
  console.log(chalk.bold(`\n[${n}/${total}] ${msg}`))
}

async function retry<T>(fn: () => Promise<T>, opts?: { retries?: number; delayMs?: number }): Promise<T> {
  const retries = opts?.retries ?? 3
  const baseDelay = opts?.delayMs ?? 1000
  let lastError: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i < retries) await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)))
    }
  }
  throw lastError
}

async function awsCommand(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const { execa } = await import("execa")
  try {
    const result = await retry(() => execa("aws", args))
    return { stdout: result.stdout, exitCode: 0 }
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; exitCode?: number }
    return { stdout: error.stdout ?? "", exitCode: error.exitCode ?? 1 }
  }
}

async function terraformOutput(env: string): Promise<Record<string, { value: unknown }> | null> {
  const { execa } = await import("execa")
  try {
    const result = await execa("terraform", ["output", "-json"], { cwd: infraDir(env) })
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

function secretPath(env: string, name: string): string {
  return `${SECRET_PATH_PREFIX}/${env}/${name}`
}

function ssmParamPath(env: string, name: string): string {
  return `/${SECRET_PATH_PREFIX}/${env}/${name}`
}

// ── Secrets backend ───────────────────────────────────────────────────────────
// Dev runs on a single EC2 + Docker Compose, reading secrets from SSM Parameter
// Store (free). Production uses the heavier Fargate stack with Secrets Manager
// (ECS has first-class Secrets Manager integration). CLI commands respect per-
// env defaults here; user can override via SECRETS_BACKEND env var.

type SecretsBackend = "ssm" | "secretsmanager"

const DEFAULT_SECRETS_BACKEND: Record<string, SecretsBackend> = {
  dev: "ssm",
  staging: "secretsmanager",
  production: "secretsmanager",
}

function secretsBackend(env: string): SecretsBackend {
  const override = process.env.SECRETS_BACKEND as SecretsBackend | undefined
  if (override === "ssm" || override === "secretsmanager") return override
  return DEFAULT_SECRETS_BACKEND[env] ?? "secretsmanager"
}

/** Read a secret's current value, trying both stores (SSM first for dev). */
async function readSecret(env: string, name: string): Promise<string | null> {
  const backend = secretsBackend(env)
  const order: SecretsBackend[] = backend === "ssm"
    ? ["ssm", "secretsmanager"]
    : ["secretsmanager", "ssm"]

  for (const b of order) {
    if (b === "ssm") {
      const res = await awsCommand([
        "ssm", "get-parameter",
        "--name", ssmParamPath(env, name),
        "--with-decryption",
        "--region", DEFAULT_REGION,
        "--output", "json",
      ])
      if (res.exitCode === 0) {
        try {
          const data = JSON.parse(res.stdout)
          const value = data.Parameter?.Value as string | undefined
          if (value && value !== "__placeholder__") return value
        } catch { /* fall through */ }
      }
    } else {
      const res = await awsCommand([
        "secretsmanager", "get-secret-value",
        "--secret-id", secretPath(env, name),
        "--region", DEFAULT_REGION,
        "--output", "json",
      ])
      if (res.exitCode === 0) {
        try {
          const data = JSON.parse(res.stdout)
          if (data.SecretString?.trim()) return data.SecretString as string
        } catch { /* fall through */ }
      }
    }
  }
  return null
}

/** Write a secret to the env's configured backend. */
async function writeSecret(env: string, name: string, value: string): Promise<boolean> {
  const backend = secretsBackend(env)

  if (backend === "ssm") {
    const res = await awsCommand([
      "ssm", "put-parameter",
      "--name", ssmParamPath(env, name),
      "--value", value,
      "--type", "SecureString",
      "--overwrite",
      "--region", DEFAULT_REGION,
    ])
    return res.exitCode === 0
  }

  const res = await awsCommand([
    "secretsmanager", "put-secret-value",
    "--secret-id", secretPath(env, name),
    "--secret-string", value,
    "--region", DEFAULT_REGION,
  ])
  return res.exitCode === 0
}

// ── EC2 host helpers ──────────────────────────────────────────────────────────
// The new dev env is a single EC2 instance tagged Role=ibatexas-<env>-host.
// SSM Run Command is the deploy channel; SSM Session Manager is the shell.

async function findHostInstance(env: string): Promise<{ id: string; state: string } | null> {
  const res = await awsCommand([
    "ec2", "describe-instances",
    "--filters",
    `Name=tag:Role,Values=ibatexas-${env}-host`,
    "Name=instance-state-name,Values=pending,running,stopping,stopped",
    "--region", DEFAULT_REGION,
    "--query", "Reservations[0].Instances[0].[InstanceId,State.Name]",
    "--output", "text",
  ])
  if (res.exitCode !== 0 || !res.stdout.trim() || res.stdout.trim() === "None") return null
  const [id, state] = res.stdout.trim().split(/\s+/)
  if (!id || id === "None") return null
  return { id, state }
}

async function setInstancePower(env: string, action: "start" | "stop"): Promise<{ ok: boolean; detail: string }> {
  const instance = await findHostInstance(env)
  if (!instance) return { ok: false, detail: "no instance found (terraform apply first)" }

  const cmd = action === "start" ? "start-instances" : "stop-instances"
  const res = await awsCommand([
    "ec2", cmd,
    "--instance-ids", instance.id,
    "--region", DEFAULT_REGION,
    "--output", "json",
  ])
  if (res.exitCode !== 0) return { ok: false, detail: `${cmd} failed` }
  return { ok: true, detail: `${instance.id} ${action === "start" ? "starting" : "stopping"}` }
}

/** Run a shell command on the dev instance via SSM Run Command. Returns stdout. */
async function runOnInstance(env: string, commandText: string, timeoutSec = 600): Promise<{ ok: boolean; output: string }> {
  const instance = await findHostInstance(env)
  if (!instance) return { ok: false, output: "no instance found" }
  if (instance.state !== "running") return { ok: false, output: `instance state: ${instance.state}` }

  const send = await awsCommand([
    "ssm", "send-command",
    "--instance-ids", instance.id,
    "--document-name", "AWS-RunShellScript",
    "--parameters", JSON.stringify({ commands: [commandText] }),
    "--timeout-seconds", String(timeoutSec),
    "--region", DEFAULT_REGION,
    "--query", "Command.CommandId",
    "--output", "text",
  ])
  if (send.exitCode !== 0) return { ok: false, output: "send-command failed" }
  const commandId = send.stdout.trim()

  // Poll for completion.
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    const invoke = await awsCommand([
      "ssm", "get-command-invocation",
      "--command-id", commandId,
      "--instance-id", instance.id,
      "--region", DEFAULT_REGION,
      "--output", "json",
    ])
    if (invoke.exitCode !== 0) continue
    try {
      const data = JSON.parse(invoke.stdout)
      const status = data.Status as string
      if (status === "Success") {
        return { ok: true, output: (data.StandardOutputContent as string) ?? "" }
      }
      if (["Failed", "Cancelled", "TimedOut"].includes(status)) {
        const stdout = (data.StandardOutputContent as string) ?? ""
        const stderr = (data.StandardErrorContent as string) ?? ""
        return { ok: false, output: `[${status}]\n${stdout}\n${stderr}` }
      }
    } catch { /* keep polling */ }
  }
  return { ok: false, output: "ssm command timed out waiting for result" }
}

async function httpProbe(url: string): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const { execa } = await import("execa")
  try {
    const res = await execa("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", url])
    const code = Number.parseInt(res.stdout.trim(), 10)
    if (!Number.isFinite(code)) return { ok: false, status: null, detail: "curl returned non-numeric status" }
    const ok = code >= 200 && code < 400
    return { ok, status: code, detail: `HTTP ${code}` }
  } catch (err) {
    return { ok: false, status: null, detail: `curl failed: ${String(err).slice(0, 80)}` }
  }
}

// ── Check System ──────────────────────────────────────────────────────────────

type CheckSeverity = "blocking" | "degraded" | "informational"
type CheckStatus = "ok" | "warn" | "error" | "skip"

interface CheckResult {
  status: CheckStatus
  detail: string
}

interface InfraCheckDef {
  id: string
  group: "aws" | "terraform" | "host" | "secrets" | "github"
  label: string
  severity: CheckSeverity
  run: (env: string) => Promise<CheckResult>
}

interface InfraCheckResult extends InfraCheckDef {
  result: CheckResult
}

const CHECKS: InfraCheckDef[] = [
  // ── AWS ───────────────────────────────────────────────────────
  {
    id: "aws.credentials",
    group: "aws",
    label: "AWS Credentials",
    severity: "blocking",
    run: async () => {
      const res = await awsCommand(["sts", "get-caller-identity", "--output", "json"])
      if (res.exitCode !== 0) return { status: "error", detail: "not configured or expired" }
      try {
        const identity = JSON.parse(res.stdout)
        return { status: "ok", detail: `account ${identity.Account} (${identity.Arn.split("/").pop()})` }
      } catch {
        return { status: "error", detail: "unexpected response" }
      }
    },
  },
  {
    id: "aws.region",
    group: "aws",
    label: "AWS Region",
    severity: "degraded",
    run: async () => {
      const res = await awsCommand(["configure", "get", "region"])
      const cliRegion = res.stdout.trim()
      if (!cliRegion) return { status: "warn", detail: `not set in CLI (project uses ${DEFAULT_REGION})` }
      if (cliRegion !== DEFAULT_REGION) return { status: "warn", detail: `CLI: ${cliRegion} ≠ project: ${DEFAULT_REGION}` }
      return { status: "ok", detail: cliRegion }
    },
  },
  {
    id: "aws.s3_bucket",
    group: "aws",
    label: "S3 State Bucket",
    severity: "blocking",
    run: async () => {
      const res = await awsCommand(["s3api", "head-bucket", "--bucket", STATE_BUCKET, "--region", DEFAULT_REGION])
      return res.exitCode === 0
        ? { status: "ok", detail: STATE_BUCKET }
        : { status: "error", detail: `${STATE_BUCKET} not found` }
    },
  },
  {
    id: "aws.dynamodb_lock",
    group: "aws",
    label: "DynamoDB Lock Table",
    severity: "blocking",
    run: async () => {
      const res = await awsCommand(["dynamodb", "describe-table", "--table-name", LOCK_TABLE, "--region", DEFAULT_REGION, "--output", "json"])
      return res.exitCode === 0
        ? { status: "ok", detail: LOCK_TABLE }
        : { status: "error", detail: `${LOCK_TABLE} not found` }
    },
  },
  // ── Terraform ─────────────────────────────────────────────────
  {
    id: "terraform.initialized",
    group: "terraform",
    label: "Terraform Initialized",
    severity: "blocking",
    run: async (env) => {
      const tfDir = path.join(infraDir(env), ".terraform")
      return fs.existsSync(tfDir)
        ? { status: "ok", detail: ".terraform/ present" }
        : { status: "error", detail: "run terraform init first" }
    },
  },
  // ── Host (EC2) ────────────────────────────────────────────────
  {
    id: "host.instance",
    group: "host",
    label: "EC2 Host Instance",
    severity: "blocking",
    run: async (env) => {
      const instance = await findHostInstance(env)
      if (!instance) return { status: "error", detail: "no instance with tag Role=ibatexas-<env>-host found" }
      if (instance.state === "running") return { status: "ok", detail: `${instance.id} running` }
      if (instance.state === "stopped") return { status: "warn", detail: `${instance.id} stopped — run 'ibx infra resume'` }
      return { status: "warn", detail: `${instance.id} ${instance.state}` }
    },
  },
  {
    id: "host.ssm",
    group: "host",
    label: "SSM Agent Reachable",
    severity: "degraded",
    run: async (env) => {
      const instance = await findHostInstance(env)
      if (!instance || instance.state !== "running") return { status: "skip", detail: "instance not running" }
      const res = await awsCommand([
        "ssm", "describe-instance-information",
        "--filters", `Key=InstanceIds,Values=${instance.id}`,
        "--region", DEFAULT_REGION,
        "--query", "InstanceInformationList[0].PingStatus",
        "--output", "text",
      ])
      if (res.exitCode !== 0) return { status: "error", detail: "ssm describe-instance-information failed" }
      const status = res.stdout.trim()
      return status === "Online"
        ? { status: "ok", detail: "agent Online" }
        : { status: "error", detail: `agent ${status || "unknown"}` }
    },
  },
  {
    id: "host.https.web",
    group: "host",
    label: "HTTPS — web (ibatexas.com.br)",
    severity: "blocking",
    run: async (_env) => {
      const probe = await httpProbe("https://ibatexas.com.br/")
      return probe.ok ? { status: "ok", detail: probe.detail } : { status: "error", detail: probe.detail }
    },
  },
  {
    id: "host.https.api",
    group: "host",
    label: "HTTPS — api (api.ibatexas.com.br/health)",
    severity: "blocking",
    run: async (_env) => {
      const probe = await httpProbe("https://api.ibatexas.com.br/health")
      return probe.ok ? { status: "ok", detail: probe.detail } : { status: "error", detail: probe.detail }
    },
  },
  {
    id: "host.https.admin",
    group: "host",
    label: "HTTPS — admin (admin.ibatexas.com.br)",
    severity: "degraded",
    run: async (_env) => {
      const probe = await httpProbe("https://admin.ibatexas.com.br/")
      return probe.ok ? { status: "ok", detail: probe.detail } : { status: "error", detail: probe.detail }
    },
  },
  // ── Secrets ───────────────────────────────────────────────────
  {
    id: "secrets.populated",
    group: "secrets",
    label: "Secrets Populated",
    severity: "blocking",
    run: async (env) => {
      const backend = secretsBackend(env)
      const results = await Promise.all(
        ALL_SECRETS.map(async (name) => {
          const value = await readSecret(env, name)
          return { name, ok: value !== null }
        }),
      )
      const populated = results.filter(r => r.ok).length
      const missing = results.filter(r => !r.ok).map(r => r.name)
      if (missing.length === 0) return { status: "ok", detail: `${populated}/${ALL_SECRETS.length} populated (${backend})` }
      if (populated === 0) return { status: "error", detail: `0/${ALL_SECRETS.length} — none set (${backend})` }
      return { status: "warn", detail: `${populated}/${ALL_SECRETS.length} — missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` +${missing.length - 3} more` : ""} (${backend})` }
    },
  },
  // ── GitHub ────────────────────────────────────────────────────
  {
    id: "github.secrets",
    group: "github",
    label: "GitHub Secrets",
    severity: "blocking",
    run: async () => {
      const { execa } = await import("execa")
      try {
        const result = await execa("gh", ["secret", "list", "--json", "name"])
        const secrets = JSON.parse(result.stdout) as { name: string }[]
        const names = new Set(secrets.map(s => s.name))
        const set = GITHUB_SECRETS.filter(s => names.has(s))
        const missing = GITHUB_SECRETS.filter(s => !names.has(s))
        if (missing.length === 0) return { status: "ok", detail: `${set.length}/${GITHUB_SECRETS.length} set` }
        return { status: "warn", detail: `${set.length}/${GITHUB_SECRETS.length} — missing: ${missing.join(", ")}` }
      } catch {
        return { status: "skip", detail: "gh CLI not available or not authenticated" }
      }
    },
  },
]

async function runIdle(opts: { env?: string; only?: string }): Promise<void> {
  const env = opts.env ?? "dev"
  console.log(chalk.bold.blue(`\n  💤  Idling dev host (EC2 stop) — ${env}\n`))

  if (opts.only) {
    console.log(chalk.yellow(`  ⚠  --only is a no-op on the single-VM setup — stopping all services together.\n`))
  }

  const spinner = ora("Stopping EC2 instance...").start()
  const result = await setInstancePower(env, "stop")
  if (result.ok) {
    spinner.succeed(chalk.green(result.detail))
    console.log("")
    console.log(chalk.green(`  ✅  Instance stopping.`))
    console.log(chalk.gray(`      EC2 compute billing pauses within ~1 min.`))
    console.log(chalk.gray(`      EBS volume + EIP continue billing (~$6/mo floor).`))
    console.log(chalk.gray(`      Resume with: ibx infra resume`))
  } else {
    spinner.fail(chalk.red(result.detail))
    process.exit(1)
  }
  console.log("")
}

async function runResume(opts: { env?: string; count?: string; only?: string }): Promise<void> {
  const env = opts.env ?? "dev"

  if (opts.count) {
    console.log(chalk.yellow(`  ⚠  --count is a no-op on the single-VM setup.\n`))
  }
  if (opts.only) {
    console.log(chalk.yellow(`  ⚠  --only is a no-op on the single-VM setup.\n`))
  }

  console.log(chalk.bold.blue(`\n  ▶️   Resuming dev host (EC2 start) — ${env}\n`))

  const spinner = ora("Starting EC2 instance...").start()
  const result = await setInstancePower(env, "start")
  if (!result.ok) {
    spinner.fail(chalk.red(result.detail))
    process.exit(1)
  }
  spinner.succeed(chalk.green(result.detail))

  console.log("")
  console.log(chalk.gray("  Cold boot takes ~3-5 min (instance start + Docker pull + container warm-up)."))
  console.log(chalk.gray("  Watch readiness with: ibx infra status"))
  console.log("")
}

async function runAllChecks(env: string): Promise<InfraCheckResult[]> {
  const results: InfraCheckResult[] = []
  for (const check of CHECKS) {
    const spinner = ora({ text: check.label, indent: 4 }).start()
    try {
      const result = await check.run(env)
      if (result.status === "ok") spinner.succeed(chalk.green(`${check.label}  ${chalk.gray(result.detail)}`))
      else if (result.status === "warn") spinner.warn(chalk.yellow(`${check.label}  ${chalk.gray(result.detail)}`))
      else if (result.status === "error") spinner.fail(chalk.red(`${check.label}  ${chalk.gray(result.detail)}`))
      else spinner.info(chalk.gray(`${check.label}  ${result.detail}`))
      results.push({ ...check, result })
    } catch (err) {
      spinner.fail(chalk.red(`${check.label}  ${String(err)}`))
      results.push({ ...check, result: { status: "error", detail: String(err) } })
    }
  }
  return results
}

function renderConfidenceSummary(results: InfraCheckResult[]) {
  const blocking = results.filter(r => r.severity === "blocking" && (r.result.status === "error" || r.result.status === "warn"))
  const degraded = results.filter(r => r.severity === "degraded" && (r.result.status === "error" || r.result.status === "warn"))

  if (blocking.length === 0 && degraded.length === 0) {
    console.log(chalk.green.bold("\n  Deployment health: ✅ HEALTHY\n"))
    return
  }

  if (blocking.length > 0) {
    console.log(chalk.red.bold("\n  Deployment health: ❌ NOT READY\n"))
    console.log(chalk.red("  Blocking:"))
    for (const b of blocking) console.log(chalk.red(`    ✗ ${b.label}: ${b.result.detail}`))
  } else {
    console.log(chalk.yellow.bold("\n  Deployment health: ⚠️  PARTIALLY HEALTHY\n"))
  }

  if (degraded.length > 0) {
    console.log(chalk.yellow("  Degraded:"))
    for (const d of degraded) console.log(chalk.yellow(`    ⚠ ${d.label}: ${d.result.detail}`))
  }
  console.log("")
}

function renderDashboard(results: InfraCheckResult[]) {
  renderConfidenceSummary(results)
  const groups = new Map<string, InfraCheckResult[]>()
  for (const r of results) {
    if (!groups.has(r.group)) groups.set(r.group, [])
    groups.get(r.group)!.push(r)
  }
  for (const [group, checks] of groups) {
    console.log(chalk.bold(`  ${group.toUpperCase()}`))
    for (const c of checks) {
      const icon = c.result.status === "ok" ? chalk.green("✓") : c.result.status === "warn" ? chalk.yellow("⚠") : c.result.status === "error" ? chalk.red("✗") : chalk.gray("○")
      console.log(`    ${icon} ${c.label.padEnd(24)} ${chalk.gray(c.result.detail)}`)
    }
    console.log("")
  }
}

function renderChecklist(results: InfraCheckResult[]) {
  renderConfidenceSummary(results)
  console.log(chalk.bold("  Deployment Checklist\n"))
  let i = 0
  for (const c of results) {
    i++
    const icon = c.result.status === "ok" ? chalk.green("✓") : c.result.status === "warn" ? chalk.yellow("⚠") : c.result.status === "error" ? chalk.red("✗") : chalk.gray("○")
    const num = String(i).padStart(2, " ")
    console.log(`  ${num}. ${icon}  ${c.label.padEnd(24)} ${chalk.gray(c.result.detail)}`)
  }
  console.log("")
}

// ── Subcommand: init ──────────────────────────────────────────────────────────

async function runInit(opts: { region: string }) {
  const { confirm } = await import("@inquirer/prompts")
  const env = getEnvironment()
  const region = opts.region
  console.log(chalk.bold.blue("\n  🏗️  Infrastructure Init\n"))
  envBanner(env)

  const TOTAL = 4
  let stepNum = 0

  // [1] Verify AWS credentials + account confirmation
  step(++stepNum, TOTAL, "Verifying AWS credentials…")
  const identityRes = await awsCommand(["sts", "get-caller-identity", "--output", "json"])
  if (identityRes.exitCode !== 0) {
    console.error(chalk.red("    AWS credentials not configured. Run: aws configure"))
    process.exit(1)
  }
  const identity = JSON.parse(identityRes.stdout)
  console.log(chalk.white(`    Account: ${chalk.bold(identity.Account)}`))
  console.log(chalk.white(`    Region:  ${chalk.bold(region)}`))

  // Region mismatch check
  const cliRegionRes = await awsCommand(["configure", "get", "region"])
  const cliRegion = cliRegionRes.stdout.trim()
  if (cliRegion && cliRegion !== region) {
    console.log(chalk.yellow(`    ⚠ AWS CLI region is ${cliRegion} but project uses ${region}`))
  }

  const proceed = await confirm({ message: "Continue?", default: true })
  if (!proceed) { console.log(chalk.gray("    Cancelled")); return }

  // [2] S3 state bucket
  step(++stepNum, TOTAL, "Creating S3 state bucket…")
  const bucketSpinner = ora({ text: STATE_BUCKET, indent: 4 }).start()
  const bucketCheck = await awsCommand(["s3api", "head-bucket", "--bucket", STATE_BUCKET, "--region", region])
  if (bucketCheck.exitCode === 0) {
    bucketSpinner.succeed(chalk.green(`${STATE_BUCKET} (already exists)`))
  } else {
    const createArgs = ["s3api", "create-bucket", "--bucket", STATE_BUCKET, "--region", region]
    if (region !== "us-east-1") {
      createArgs.push("--create-bucket-configuration", `LocationConstraint=${region}`)
    }
    const createRes = await awsCommand(createArgs)
    if (createRes.exitCode !== 0) {
      bucketSpinner.fail(chalk.red(`Failed to create ${STATE_BUCKET}`))
      process.exit(1)
    }
    // Enable versioning
    await awsCommand(["s3api", "put-bucket-versioning", "--bucket", STATE_BUCKET, "--versioning-configuration", "Status=Enabled", "--region", region])
    // Enable encryption
    await awsCommand(["s3api", "put-bucket-encryption", "--bucket", STATE_BUCKET, "--server-side-encryption-configuration", '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}', "--region", region])
    bucketSpinner.succeed(chalk.green(`${STATE_BUCKET} (created with versioning + encryption)`))
  }

  // [3] DynamoDB lock table
  step(++stepNum, TOTAL, "Creating DynamoDB lock table…")
  const tableSpinner = ora({ text: LOCK_TABLE, indent: 4 }).start()
  const tableCheck = await awsCommand(["dynamodb", "describe-table", "--table-name", LOCK_TABLE, "--region", region, "--output", "json"])
  if (tableCheck.exitCode === 0) {
    tableSpinner.succeed(chalk.green(`${LOCK_TABLE} (already exists)`))
  } else {
    const createRes = await awsCommand([
      "dynamodb", "create-table",
      "--table-name", LOCK_TABLE,
      "--attribute-definitions", "AttributeName=LockID,AttributeType=S",
      "--key-schema", "AttributeName=LockID,KeyType=HASH",
      "--billing-mode", "PAY_PER_REQUEST",
      "--region", region,
    ])
    if (createRes.exitCode !== 0) {
      tableSpinner.fail(chalk.red(`Failed to create ${LOCK_TABLE}`))
      process.exit(1)
    }
    tableSpinner.succeed(chalk.green(`${LOCK_TABLE} (created)`))
  }

  // [4] Next steps
  step(++stepNum, TOTAL, "Done!")
  console.log("")
  console.log(chalk.green.bold("  ✅  Init complete!"))
  console.log("")
  console.log(chalk.white("  Next steps:"))
  console.log(chalk.cyan("    1. Uncomment the S3 backend block in infra/terraform/environments/dev/main.tf"))
  console.log(chalk.cyan("    2. Run: terraform init -migrate-state -chdir=infra/terraform/environments/dev"))
  console.log(chalk.cyan("    3. Run: ibx infra apply"))
  console.log("")
}

// ── Subcommand: plan ──────────────────────────────────────────────────────────

async function runPlan(opts: { out?: string; env?: string }) {
  const { execa } = await import("execa")
  const env = opts.env ?? getEnvironment()
  const dir = infraDir(env)
  console.log(chalk.bold.blue("\n  📋  Terraform Plan\n"))
  envBanner(env)

  // Check terraform is initialized
  if (!fs.existsSync(path.join(dir, ".terraform"))) {
    console.error(chalk.red("  Terraform not initialized. Run: terraform init -chdir=" + dir))
    process.exit(1)
  }

  // State safety check
  try {
    const stateResult = await execa("terraform", ["state", "list"], { cwd: dir })
    if (!stateResult.stdout.trim()) {
      // State is empty — check if AWS resources exist
      const clusterCheck = await awsCommand(["ecs", "describe-clusters", "--clusters", `ibatexas-${env}`, "--region", DEFAULT_REGION, "--output", "json"])
      if (clusterCheck.exitCode === 0) {
        try {
          const data = JSON.parse(clusterCheck.stdout)
          if (data.clusters?.length > 0 && data.clusters[0].status === "ACTIVE") {
            console.log(chalk.yellow.bold("  ⚠️  No Terraform state found but AWS resources exist."))
            console.log(chalk.yellow("     You may be about to recreate infrastructure.\n"))
          }
        } catch { /* ignore parse errors */ }
      }
    }
  } catch { /* state list failed — likely no state, which is fine for first run */ }

  const args = ["plan"]
  if (opts.out) args.push("-out", opts.out)

  try {
    await execa("terraform", args, { cwd: dir, stdio: "inherit" })
  } catch (err) {
    const error = err as { exitCode?: number }
    process.exit(error.exitCode ?? 1)
  }
}

// ── Subcommand: apply ─────────────────────────────────────────────────────────

async function runApply(opts: { plan?: string; env?: string }) {
  const { execa } = await import("execa")
  const env = opts.env ?? getEnvironment()
  const dir = infraDir(env)
  console.log(chalk.bold.blue("\n  🚀  Terraform Apply\n"))
  envBanner(env)

  const args = ["apply", "-auto-approve"]
  if (opts.plan) args.push(opts.plan)

  try {
    await execa("terraform", args, { cwd: dir, stdio: "inherit" })
  } catch (err) {
    const error = err as { exitCode?: number }
    console.error(chalk.red("\n  Terraform apply failed"))
    process.exit(error.exitCode ?? 1)
  }

  // Print outputs
  const outputs = await terraformOutput(env)
  if (outputs) {
    console.log(chalk.bold("\n  Key Outputs:\n"))
    if (outputs.route53_nameservers) {
      console.log(chalk.white("  Route53 NS records (set at domain registrar):"))
      const ns = outputs.route53_nameservers.value as string[]
      for (const n of ns) console.log(chalk.cyan(`    ${n}`))
    }
    if (outputs.github_deploy_role_arn) {
      console.log(chalk.white(`\n  GitHub Deploy Role ARN:`))
      console.log(chalk.cyan(`    ${outputs.github_deploy_role_arn.value}`))
    }
    if (outputs.redis_endpoint) console.log(chalk.gray(`  Redis:     ${outputs.redis_endpoint.value}`))
    if (outputs.nats_endpoint) console.log(chalk.gray(`  NATS:      ${outputs.nats_endpoint.value}`))
    if (outputs.typesense_endpoint) console.log(chalk.gray(`  Typesense: ${outputs.typesense_endpoint.value}`))
  } else {
    console.log(chalk.yellow("\n  ⚠ Terraform outputs unavailable — infrastructure may be incomplete"))
  }

  // Explicit blocking status
  console.log("")
  console.log(chalk.yellow.bold("  ❗ Infrastructure provisioned — deployment is NOT ready yet"))
  console.log("")
  console.log(chalk.white("  Missing steps:"))
  console.log(chalk.red(`    ✗ Secrets not populated (${ALL_SECRETS.length} required)`))
  console.log(chalk.red("    ✗ GitHub secrets not configured"))
  console.log(chalk.red("    ✗ No images in ECR (first deploy hasn't run)"))
  console.log("")
  console.log(chalk.white("  Next:"))
  console.log(chalk.cyan("    ibx infra secrets      # populate AWS Secrets Manager"))
  console.log(chalk.cyan("    ibx infra github       # set GitHub repo secrets"))
  console.log(chalk.cyan("    git push origin dev    # trigger first staging deploy"))
  console.log("")
}

// ── Subcommand: secrets ───────────────────────────────────────────────────────

async function runSecrets(opts: { env?: string; force?: boolean; fromEnv?: boolean; only?: string }) {
  const env = opts.env ?? getEnvironment()
  console.log(chalk.bold.blue("\n  🔐  Secrets Manager\n"))
  envBanner(env)

  const targetSecrets = opts.only
    ? opts.only.split(",").map(s => s.trim()).filter(s => MANUAL_SECRETS.includes(s))
    : MANUAL_SECRETS

  if (opts.only && targetSecrets.length === 0) {
    console.log(chalk.red(`  ✗ None of the specified secrets are valid. Available: ${MANUAL_SECRETS.join(", ")}`))
    return
  }

  let populated = 0
  let skipped = 0
  let alreadySet = 0
  let invalid = 0
  const populatedValues: Record<string, string> = {}

  const backend = secretsBackend(env)
  console.log(chalk.gray(`  Backend: ${backend} (override with SECRETS_BACKEND env var)\n`))

  // Pre-fetch all secrets in parallel (tries both stores, SSM first for dev).
  const existingSecrets = new Map<string, string>()
  if (!opts.force) {
    const spinner = ora("  Checking existing secrets…").start()
    const checks = await Promise.all(
      targetSecrets.map(async (name) => {
        const value = await readSecret(env, name)
        return { name, value }
      }),
    )
    for (const { name, value } of checks) {
      if (value) existingSecrets.set(name, value)
    }
    spinner.succeed(`  ${existingSecrets.size}/${targetSecrets.length} secrets already set`)
  }

  for (const name of targetSecrets) {
    // Check if already set (from parallel pre-fetch)
    if (!opts.force && existingSecrets.has(name)) {
      console.log(chalk.green(`  ✓ ${name.padEnd(28)} (already set)`))
      alreadySet++
      populatedValues[name] = existingSecrets.get(name)!
      continue
    }

    if (opts.fromEnv) {
      // Non-interactive: read from process.env
      const envValue = process.env[name]
      if (!envValue) {
        console.log(chalk.gray(`  ○ ${name.padEnd(28)} (not in env — skipped)`))
        skipped++
        continue
      }
      const validation = validateSecret(name, envValue)
      if (validation !== true) {
        console.log(chalk.red(`  ✗ ${name.padEnd(28)} (invalid — ${validation})`))
        invalid++
        continue
      }
      const ok = await writeSecret(env, name, envValue)
      if (ok) {
        console.log(chalk.green(`  ✓ ${name.padEnd(28)} (populated from env)`))
        populated++
        populatedValues[name] = envValue
      } else {
        console.log(chalk.red(`  ✗ ${name.padEnd(28)} (write failed)`))
        invalid++
      }
    } else {
      // Interactive: prompt for value
      const { password, input } = await import("@inquirer/prompts")
      const promptFn = SENSITIVE_SECRETS.has(name) ? password : input
      let value: string
      try {
        value = await promptFn({
          message: `${name}:`,
          validate: (v: string) => {
            if (!v.trim()) return true  // allow empty = skip
            return validateSecret(name, v)
          },
        })
      } catch {
        // User cancelled (Ctrl+C)
        break
      }

      if (!value.trim()) {
        console.log(chalk.gray(`  ○ ${name.padEnd(28)} (skipped)`))
        skipped++
        continue
      }

      const ok = await writeSecret(env, name, value)
      if (ok) {
        console.log(chalk.green(`  ✓ ${name.padEnd(28)} (populated)`))
        populated++
        populatedValues[name] = value
      } else {
        console.log(chalk.red(`  ✗ ${name.padEnd(28)} (write failed)`))
        invalid++
      }
    }
  }

  // Cross-secret validation
  const warnings = crossValidateSecrets(populatedValues, env)
  if (warnings.length > 0) {
    console.log(chalk.yellow("\n  Cross-validation warnings:"))
    for (const w of warnings) console.log(chalk.yellow(`    ⚠ ${w}`))
  }

  // Summary
  console.log(chalk.bold(`\n  Summary: ${chalk.green(`${populated} populated`)}, ${chalk.gray(`${alreadySet} already set`)}, ${chalk.yellow(`${skipped} skipped`)}, ${chalk.red(`${invalid} invalid`)}`))
  const remaining = targetSecrets.length - populated - alreadySet
  if (remaining > 0) {
    console.log(chalk.yellow(`  ⚠ ${remaining} secret(s) still empty — deploy may fail`))
  }
  console.log("")
}

// ── Subcommand: secrets:export ────────────────────────────────────────────────

const SECRET_CATEGORIES: { label: string; keys: string[] }[] = [
  { label: "Auth", keys: ["JWT_SECRET"] },
  { label: "Database (Supabase)", keys: ["DATABASE_URL"] },
  { label: "Observability", keys: ["SENTRY_DSN"] },
  { label: "AI", keys: ["ANTHROPIC_API_KEY"] },
  { label: "Payments", keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
  { label: "WhatsApp (Twilio)", keys: ["TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID", "TWILIO_VERIFY_SID"] },
  { label: "Medusa Commerce", keys: ["MEDUSA_ADMIN_EMAIL", "MEDUSA_ADMIN_PASSWORD"] },
  { label: "Search", keys: ["TYPESENSE_API_KEY"] },
  { label: "Web", keys: ["CORS_ORIGIN"] },
]

async function runSecretsExport(opts: { file?: string }) {
  const dotenv = await import("dotenv")
  const sourcePath = path.resolve(ROOT, opts.file ?? ".env")

  console.log(chalk.bold.blue("\n  📦  Secrets Export\n"))

  if (!fs.existsSync(sourcePath)) {
    console.log(chalk.red(`  ✗ File not found: ${sourcePath}`))
    return
  }

  const parsed = dotenv.parse(fs.readFileSync(sourcePath, "utf-8"))
  const lines: string[] = [
    "# ── IbateXas Secrets ──────────────────────────────────────────────────────────",
    `# Generated from ${opts.file ?? ".env"} — do NOT commit this file`,
    `# Usage: ibx infra secrets:push`,
    "# ──────────────────────────────────────────────────────────────────────────────",
    "",
  ]

  let exported = 0
  const missing: string[] = []

  for (const category of SECRET_CATEGORIES) {
    const catLines: string[] = []
    for (const key of category.keys) {
      if (!MANUAL_SECRETS.includes(key)) continue
      const value = parsed[key]
      if (value) {
        catLines.push(`export ${key}="${value}"`)
        exported++
      } else {
        catLines.push(`# export ${key}=""`)
        missing.push(key)
      }
    }
    if (catLines.length > 0) {
      lines.push(`# ${category.label}`)
      lines.push(...catLines)
      lines.push("")
    }
  }

  const outPath = path.resolve(ROOT, "infra/secrets.env")
  fs.writeFileSync(outPath, lines.join("\n"), "utf-8")

  console.log(chalk.green(`  ✓ Written to infra/secrets.env`))
  console.log(chalk.bold(`\n  Summary: ${chalk.green(`${exported} exported`)}, ${chalk.yellow(`${missing.length} missing`)}`))
  if (missing.length > 0) {
    console.log(chalk.yellow(`  ⚠ Missing: ${missing.join(", ")}`))
    console.log(chalk.gray(`    Fill them in infra/secrets.env before running: ibx infra secrets:push`))
  }
  console.log("")
}

// ── Subcommand: secrets:push ─────────────────────────────────────────────────

async function runSecretsPush(opts: { file?: string; env?: string; force?: boolean; only?: string }) {
  const sourcePath = path.resolve(ROOT, opts.file ?? "infra/secrets.env")

  console.log(chalk.bold.blue("\n  🚀  Secrets Push\n"))

  if (!fs.existsSync(sourcePath)) {
    console.log(chalk.red(`  ✗ File not found: ${sourcePath}`))
    console.log(chalk.gray(`    Run: ibx infra secrets:export`))
    return
  }

  const content = fs.readFileSync(sourcePath, "utf-8")
  let loaded = 0

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    // Match: export KEY="value", export KEY=value, KEY="value", KEY=value
    const match = trimmed.match(/^(?:export\s+)?([A-Z_]+)=["']?(.+?)["']?$/)
    if (match) {
      const [, key, value] = match
      if (MANUAL_SECRETS.includes(key)) {
        process.env[key] = value
        loaded++
      }
    }
  }

  console.log(chalk.gray(`  Loaded ${loaded} secrets from ${opts.file ?? "infra/secrets.env"}\n`))

  await runSecrets({ fromEnv: true, force: opts.force, only: opts.only, env: opts.env })
}

// ── Subcommand: github ────────────────────────────────────────────────────────

async function runGithub() {
  const { execa } = await import("execa")
  const { confirm, password } = await import("@inquirer/prompts")
  const env = getEnvironment()
  console.log(chalk.bold.blue("\n  🐙  GitHub Secrets\n"))
  envBanner(env)

  const TOTAL = 4
  let stepNum = 0

  // [1] Verify gh CLI
  step(++stepNum, TOTAL, "Verifying GitHub CLI…")
  try {
    await execa("gh", ["auth", "status"])
  } catch {
    console.error(chalk.red("    gh CLI not installed or not authenticated. Run: gh auth login"))
    process.exit(1)
  }

  // Detect repo
  const repoResult = await execa("gh", ["repo", "view", "--json", "nameWithOwner"])
  const repo = JSON.parse(repoResult.stdout).nameWithOwner
  const proceed = await confirm({ message: `Setting secrets for: ${chalk.bold(repo)} — Continue?`, default: true })
  if (!proceed) { console.log(chalk.gray("    Cancelled")); return }

  // [2] Get deploy role ARN from terraform output
  step(++stepNum, TOTAL, "Reading Terraform outputs…")
  const outputs = await terraformOutput(env)
  const roleArn = outputs?.github_deploy_role_arn?.value as string | undefined

  // [3] Set core secrets (deploy role + database URLs + optional sonar)
  step(++stepNum, TOTAL, "Setting GitHub secrets…")

  if (roleArn) {
    const spinner = ora({ text: "AWS_DEPLOY_ROLE_ARN", indent: 4 }).start()
    try {
      await execa("gh", ["secret", "set", "AWS_DEPLOY_ROLE_ARN", "--body", roleArn])
      spinner.succeed(chalk.green("AWS_DEPLOY_ROLE_ARN (from terraform output)"))
    } catch {
      spinner.fail(chalk.red("AWS_DEPLOY_ROLE_ARN — failed to set"))
    }
  } else {
    console.log(chalk.yellow("    ⚠ AWS_DEPLOY_ROLE_ARN unavailable — terraform outputs not found"))
    console.log(chalk.gray("      Set manually: gh secret set AWS_DEPLOY_ROLE_ARN"))
  }

  for (const name of ["DIRECT_DATABASE_URL", "STAGING_DIRECT_DATABASE_URL", "SONAR_TOKEN"]) {
    const isOptional = name === "SONAR_TOKEN"
    let value: string
    try {
      value = await password({
        message: `${name}${isOptional ? " (optional, press Enter to skip)" : ""}:`,
      })
    } catch {
      break
    }

    if (!value.trim()) {
      if (isOptional) {
        console.log(chalk.gray(`    ○ ${name} (skipped)`))
      } else {
        console.log(chalk.yellow(`    ⚠ ${name} (skipped — deploy may fail without this)`))
      }
      continue
    }

    const spinner = ora({ text: name, indent: 4 }).start()
    try {
      await execa("gh", ["secret", "set", name, "--body", value])
      spinner.succeed(chalk.green(name))
    } catch {
      spinner.fail(chalk.red(`${name} — failed to set`))
    }
  }

  // [4] Set NEXT_PUBLIC_* build-arg secrets + variables, preferring .env values
  step(++stepNum, TOTAL, "Setting build-arg secrets and variables…")

  const envPath = path.resolve(ROOT, ".env")
  const localEnv: Record<string, string> = fs.existsSync(envPath)
    ? (await import("dotenv")).parse(fs.readFileSync(envPath, "utf-8"))
    : {}
  if (!fs.existsSync(envPath)) {
    console.log(chalk.gray("    .env not found — will prompt for each value"))
  }

  for (const name of BUILD_ARG_SECRETS) {
    const fromEnv = localEnv[name]?.trim()
    let value = fromEnv
    if (!value) {
      try {
        value = (await password({
          message: `${name} (not in .env, press Enter to skip — feature disabled in build):`,
        })).trim()
      } catch {
        break
      }
    }
    if (!value) {
      console.log(chalk.gray(`    ○ ${name} (skipped)`))
      continue
    }
    const spinner = ora({ text: name, indent: 4 }).start()
    try {
      await execa("gh", ["secret", "set", name, "--body", value])
      spinner.succeed(chalk.green(fromEnv ? `${name} (from .env)` : name))
    } catch {
      spinner.fail(chalk.red(`${name} — failed to set`))
    }
  }

  for (const [name, defaultValue] of Object.entries(BUILD_ARG_VARIABLES)) {
    const fromEnv = localEnv[name]?.trim()
    const value = fromEnv || defaultValue
    const spinner = ora({ text: name, indent: 4 }).start()
    try {
      await execa("gh", ["variable", "set", name, "--body", value])
      spinner.succeed(chalk.green(`${name} (${fromEnv ? "from .env" : "default"})`))
    } catch {
      spinner.fail(chalk.red(`${name} — failed to set`))
    }
  }

  console.log(chalk.green.bold("\n  ✅  GitHub secrets configured!\n"))
}

// ── Subcommand: status ────────────────────────────────────────────────────────

async function runStatus(opts: { json?: boolean; env?: string }) {
  const env = opts.env ?? getEnvironment()
  if (!opts.json) {
    console.log(chalk.bold.blue("\n  📊  Infrastructure Status\n"))
    envBanner(env)
  }

  const results = await runAllChecks(env)

  if (opts.json) {
    const output = results.map(r => ({ id: r.id, group: r.group, label: r.label, severity: r.severity, status: r.result.status, detail: r.result.detail }))
    console.log(JSON.stringify(output, null, 2))
  } else {
    renderDashboard(results)
  }
}

// ── Subcommand: checklist ─────────────────────────────────────────────────────

async function runChecklist() {
  const env = getEnvironment()
  console.log(chalk.bold.blue("\n  📋  Deployment Checklist\n"))
  envBanner(env)

  const results = await runAllChecks(env)
  renderChecklist(results)
}

// ── Subcommand: destroy ───────────────────────────────────────────────────────

async function runDestroy(opts: { env?: string }) {
  const { execa } = await import("execa")
  const { input: inputPrompt } = await import("@inquirer/prompts")
  const env = opts.env ?? getEnvironment()
  const dir = infraDir(env)
  console.log(chalk.red.bold("\n  ⚠️  DESTROY Infrastructure\n"))
  envBanner(env)

  // Show account info
  const identityRes = await awsCommand(["sts", "get-caller-identity", "--output", "json"])
  if (identityRes.exitCode === 0) {
    const identity = JSON.parse(identityRes.stdout)
    console.log(chalk.white(`  Account: ${chalk.bold(identity.Account)}`))
    console.log(chalk.white(`  Region:  ${chalk.bold(DEFAULT_REGION)}`))
  }

  console.log(chalk.red(`\n  This will DESTROY all AWS infrastructure for environment: ${env}`))
  console.log(chalk.red("  ECS services, ALB, ElastiCache, ECR repos, Route53 zone...\n"))

  const confirmText = env === "production" || env === "prod" ? `destroy ${env}` : env
  const answer = await inputPrompt({ message: `Type "${confirmText}" to confirm:` })

  if (answer !== confirmText) {
    console.log(chalk.gray("  Cancelled — no resources destroyed"))
    return
  }

  try {
    await execa("terraform", ["destroy", "-auto-approve"], { cwd: dir, stdio: "inherit" })
    console.log(chalk.green.bold("\n  ✅  Infrastructure destroyed\n"))
  } catch (err) {
    const error = err as { exitCode?: number }
    process.exit(error.exitCode ?? 1)
  }
}

// ── Subcommand: logs ──────────────────────────────────────────────────────────

async function runLogs(service: string | undefined, opts: { lines?: string; env?: string }) {
  const env = opts.env ?? getEnvironment()
  const svc = service ?? "api"

  if (!VALID_SERVICES.includes(svc as typeof VALID_SERVICES[number])) {
    console.error(chalk.red(`  Unknown service: ${svc}`))
    console.error(chalk.gray(`  Available: ${VALID_SERVICES.join(", ")}`))
    process.exit(1)
  }

  console.log(chalk.bold.blue(`\n  📜  Logs — ${svc}\n`))
  envBanner(env)

  const lines = opts.lines ?? "200"
  const spinner = ora(`Fetching last ${lines} lines from ibatexas-${svc} via SSM...`).start()

  const cmd = `docker logs --tail ${Number.parseInt(lines, 10) || 200} ibatexas-${svc} 2>&1 || echo '[container ibatexas-${svc} not found — is it running?]'`
  const result = await runOnInstance(env, cmd, 60)

  if (!result.ok) {
    spinner.fail(chalk.red("SSM command failed"))
    console.error(chalk.gray(result.output))
    console.error("")
    console.error(chalk.yellow("  Troubleshooting:"))
    console.error(chalk.gray("   • `ibx infra status` — is the instance running?"))
    console.error(chalk.gray("   • `aws ssm start-session --target <id>` — shell in and check `docker compose ps`"))
    process.exit(1)
  }

  spinner.stop()
  console.log(result.output)
  console.log("")
  console.log(chalk.gray(`  Tip: for live tail, SSH via SSM: aws ssm start-session --target <instance-id> --region ${DEFAULT_REGION}`))
}

// ── Subcommand: deploy ────────────────────────────────────────────────────────

async function runDeploy(opts: { target?: string; watch?: boolean; timeout?: string }) {
  const { execa } = await import("execa")
  const env = getEnvironment()
  const target = opts.target ?? "dev"
  const timeout = opts.timeout ? parseDuration(opts.timeout) : DEFAULT_DEPLOY_TIMEOUT
  console.log(chalk.bold.blue("\n  🚢  Deploy\n"))
  envBanner(env)
  console.log(chalk.white(`  Target branch: ${chalk.bold(target)}`))

  const TOTAL = opts.watch ? 3 : 1
  let stepNum = 0

  // [1] Push
  step(++stepNum, TOTAL, `Pushing to ${target}…`)
  try {
    const result = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"])
    const currentBranch = result.stdout.trim()
    await execa("git", ["push", "origin", `${currentBranch}:${target}`], { stdio: "inherit" })
  } catch (err) {
    console.error(chalk.red("    Git push failed"))
    const error = err as { exitCode?: number }
    process.exit(error.exitCode ?? 1)
  }

  if (!opts.watch) {
    console.log(chalk.green.bold("\n  ✅  Pushed! Monitor deploy in GitHub Actions\n"))
    return
  }

  // [2] Poll HTTPS health endpoints until all three are 2xx/3xx
  step(++stepNum, TOTAL, "Waiting for HTTPS health endpoints…")
  const start = Date.now()
  let stable = false
  const healthUrls = [
    "https://ibatexas.com.br/",
    "https://api.ibatexas.com.br/health",
    "https://admin.ibatexas.com.br/",
  ]
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 30_000))
    const elapsed = Math.round((Date.now() - start) / 1000)
    const spinner = ora({ text: `checking (${elapsed}s elapsed)…`, indent: 4 }).start()

    const probes = await Promise.all(healthUrls.map(u => httpProbe(u)))
    const allOk = probes.every(p => p.ok)

    if (allOk) {
      spinner.succeed(chalk.green("all HTTPS endpoints returning 2xx/3xx"))
      stable = true
      break
    }
    const fail = probes.map((p, i) => `${healthUrls[i]}: ${p.detail}`).filter((_, i) => !probes[i].ok).join(", ")
    spinner.info(chalk.gray(`not yet ready (${elapsed}s) — ${fail}`))
  }

  if (!stable) {
    console.error(chalk.red(`\n  ❌ ECS services did not stabilize within ${Math.round(timeout / 60000)}m`))
    process.exit(1)
  }

  // [3] Health check
  step(++stepNum, TOTAL, "Checking application health…")
  const healthSpinner = ora({ text: "fetching /health", indent: 4 }).start()
  try {
    const domain = "ibatexas.com.br" // TODO: derive from terraform outputs
    const response = await fetch(`https://api.${domain}/health`)
    if (response.ok) {
      healthSpinner.succeed(chalk.green(`API health: ${response.status}`))
      console.log(chalk.green.bold("\n  ✅  Deployment successful!\n"))
    } else {
      healthSpinner.fail(chalk.red(`API health: ${response.status}`))
      console.log(chalk.red.bold("\n  ❌  Deployment FAILED — app is unhealthy\n"))
      process.exit(1)
    }
  } catch (err) {
    healthSpinner.fail(chalk.red(`API health: unreachable (${String(err)})`))
    console.log(chalk.red.bold("\n  ❌  Deployment FAILED — app is unreachable\n"))
    process.exit(1)
  }
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(m|s|ms)?$/)
  if (!match) return DEFAULT_DEPLOY_TIMEOUT
  const value = parseInt(match[1], 10)
  const unit = match[2] ?? "m"
  if (unit === "ms") return value
  if (unit === "s") return value * 1000
  return value * 60 * 1000
}

// ── Subcommand: doctor ────────────────────────────────────────────────────────

async function runDoctor() {
  const env = getEnvironment()
  console.log(chalk.bold.blue("\n  🩺  Infrastructure Doctor\n"))
  envBanner(env)

  // Run all standard checks first
  const results = await runAllChecks(env)
  renderDashboard(results)

  // Additional deep checks
  console.log(chalk.bold("  Deep Diagnostics\n"))

  // Check ECR repos have images
  for (const svc of ["api", "web", "admin"]) {
    const spinner = ora({ text: `ECR ibatexas-${svc}`, indent: 4 }).start()
    const res = await awsCommand(["ecr", "describe-images", "--repository-name", `ibatexas-${svc}`, "--region", DEFAULT_REGION, "--output", "json", "--max-items", "1"])
    if (res.exitCode === 0) {
      try {
        const data = JSON.parse(res.stdout)
        const count = data.imageDetails?.length ?? 0
        spinner.succeed(chalk.green(`ibatexas-${svc}: ${count > 0 ? "has images" : "empty"}`))
      } catch {
        spinner.warn(chalk.yellow(`ibatexas-${svc}: could not parse`))
      }
    } else {
      spinner.fail(chalk.red(`ibatexas-${svc}: repo not found`))
    }
  }

  // Check CloudWatch log groups
  for (const svc of [...VALID_SERVICES]) {
    const logGroup = `/ecs/ibatexas/${env}/${svc}`
    const spinner = ora({ text: `Log group: ${logGroup}`, indent: 4 }).start()
    const res = await awsCommand(["logs", "describe-log-groups", "--log-group-name-prefix", logGroup, "--region", DEFAULT_REGION, "--output", "json"])
    if (res.exitCode === 0) {
      try {
        const data = JSON.parse(res.stdout)
        if (data.logGroups?.length > 0) {
          spinner.succeed(chalk.green(`${logGroup} exists`))
        } else {
          spinner.warn(chalk.yellow(`${logGroup} not found`))
        }
      } catch {
        spinner.warn(chalk.yellow(`${logGroup}: could not parse`))
      }
    } else {
      spinner.fail(chalk.red(`${logGroup}: query failed`))
    }
  }

  // Check Cloud Map service discovery
  const spinner = ora({ text: "Cloud Map services", indent: 4 }).start()
  const nsRes = await awsCommand(["servicediscovery", "list-namespaces", "--region", DEFAULT_REGION, "--output", "json"])
  if (nsRes.exitCode === 0) {
    try {
      const data = JSON.parse(nsRes.stdout)
      const ns = data.Namespaces?.find((n: { Name: string }) => n.Name === "ibatexas.local")
      if (ns) {
        spinner.succeed(chalk.green("ibatexas.local namespace registered"))
        console.log(chalk.gray("      Note: DNS resolution only works inside VPC"))
      } else {
        spinner.warn(chalk.yellow("ibatexas.local namespace not found"))
      }
    } catch {
      spinner.warn(chalk.yellow("Could not parse Cloud Map response"))
    }
  } else {
    spinner.fail(chalk.red("Cloud Map query failed"))
  }

  console.log("")
}

// ── Subcommand: explain ───────────────────────────────────────────────────────

async function runExplain() {
  const { execa } = await import("execa")
  const env = getEnvironment()
  console.log(chalk.bold.blue("\n  🔍  Explain — Why is the deploy failing?\n"))
  envBanner(env)

  const findings: { step: number; label: string; ok: boolean; detail: string; cause?: string }[] = []
  let stepNum = 0

  // 1. Check GitHub Actions last run
  stepNum++
  try {
    const result = await execa("gh", ["run", "list", "--limit", "1", "--json", "status,conclusion,name,headBranch", "--branch", env === "dev" ? "dev" : "main"])
    const runs = JSON.parse(result.stdout)
    if (runs.length > 0) {
      const run = runs[0]
      if (run.conclusion === "success") {
        findings.push({ step: stepNum, label: "GitHub Actions", ok: true, detail: `${run.name}: success` })
      } else {
        findings.push({ step: stepNum, label: "GitHub Actions", ok: false, detail: `${run.name}: ${run.conclusion ?? run.status}`, cause: "Workflow failed — check GitHub Actions logs" })
      }
    } else {
      findings.push({ step: stepNum, label: "GitHub Actions", ok: false, detail: "no recent runs found", cause: "No deploy has been triggered yet" })
    }
  } catch {
    findings.push({ step: stepNum, label: "GitHub Actions", ok: false, detail: "gh CLI unavailable", cause: "Install gh CLI to check workflow status" })
  }

  // 2. Check ECR has images
  stepNum++
  let hasImages = true
  for (const svc of ["api", "web", "admin"]) {
    const res = await awsCommand(["ecr", "describe-images", "--repository-name", `ibatexas-${svc}`, "--region", DEFAULT_REGION, "--output", "json", "--max-items", "1"])
    if (res.exitCode !== 0) { hasImages = false; break }
    try {
      const data = JSON.parse(res.stdout)
      if (!data.imageDetails?.length) { hasImages = false; break }
    } catch { hasImages = false; break }
  }
  if (hasImages) {
    findings.push({ step: stepNum, label: "ECR Images", ok: true, detail: "images present for all services" })
  } else {
    findings.push({ step: stepNum, label: "ECR Images", ok: false, detail: "missing images", cause: "Build step may have failed — check GitHub Actions" })
  }

  // 3. Check EC2 host instance
  stepNum++
  const instance = await findHostInstance(env)
  if (instance && instance.state === "running") {
    findings.push({ step: stepNum, label: "EC2 Host", ok: true, detail: `${instance.id} running` })
  } else if (instance) {
    findings.push({ step: stepNum, label: "EC2 Host", ok: false, detail: `${instance.id} ${instance.state}`, cause: instance.state === "stopped" ? "run 'ibx infra resume'" : "instance not ready" })
  } else {
    findings.push({ step: stepNum, label: "EC2 Host", ok: false, detail: "no instance with Role tag found", cause: "run 'terraform apply' first" })
  }

  // 4. HTTPS health probes
  stepNum++
  const healthProbes = await Promise.all([
    httpProbe("https://ibatexas.com.br/"),
    httpProbe("https://api.ibatexas.com.br/health"),
    httpProbe("https://admin.ibatexas.com.br/"),
  ])
  const labels = ["web", "api", "admin"]
  const allHealthy = healthProbes.every(p => p.ok)
  if (allHealthy) {
    findings.push({ step: stepNum, label: "HTTPS Endpoints", ok: true, detail: "all 3 hosts reachable" })
  } else {
    const failing = healthProbes.map((p, i) => p.ok ? null : `${labels[i]}: ${p.detail}`).filter(Boolean).join(", ")
    findings.push({ step: stepNum, label: "HTTPS Endpoints", ok: false, detail: failing || "unreachable", cause: "check docker compose logs via `ibx infra logs <svc>`" })
  }

  // 5. Legacy placeholder to keep variable scoping — removed event check path
  stepNum++
  const eventsRes = { exitCode: 1, stdout: "" }
  if (eventsRes.exitCode === 0) {
    try {
      const data = JSON.parse(eventsRes.stdout)
      const events = data.services?.[0]?.events?.slice(0, 3) ?? []
      const hasStoppedEvents = events.some((e: { message: string }) => e.message.includes("stopped") || e.message.includes("STOPPED"))
      if (hasStoppedEvents) {
        findings.push({ step: stepNum, label: "Application Startup", ok: false, detail: "tasks are crashing", cause: "Check: ibx infra logs api" })
      } else {
        findings.push({ step: stepNum, label: "Application Startup", ok: true, detail: "no crash events" })
      }
    } catch {
      findings.push({ step: stepNum, label: "Application Startup", ok: false, detail: "could not check events" })
    }
  }

  // 6. Check secrets (tries both backends per env)
  stepNum++
  const secretResults = await Promise.all(
    MANUAL_SECRETS.map(async (name) => {
      const value = await readSecret(env, name)
      return value === null ? name : null
    }),
  )
  const missingSecrets = secretResults.filter((n): n is string => n !== null)
  if (missingSecrets.length === 0) {
    findings.push({ step: stepNum, label: "Secrets", ok: true, detail: "all populated" })
  } else {
    findings.push({ step: stepNum, label: "Secrets", ok: false, detail: `${missingSecrets.length} missing`, cause: `Missing: ${missingSecrets.slice(0, 3).join(", ")}${missingSecrets.length > 3 ? ` +${missingSecrets.length - 3} more` : ""}` })
  }

  // Print findings
  console.log("")
  for (const f of findings) {
    const icon = f.ok ? chalk.green("✓") : chalk.red("✗")
    console.log(`  ${f.step}. ${icon} ${f.label}: ${chalk.gray(f.detail)}`)
    if (f.cause) {
      console.log(chalk.red(`     → Cause: ${f.cause}`))
    }
  }

  // Find first failure and suggest fix
  const firstFailure = findings.find(f => !f.ok)
  if (firstFailure) {
    console.log("")
    console.log(chalk.yellow.bold("  Fix:"))
    if (firstFailure.label === "GitHub Actions") console.log(chalk.cyan("    Check: gh run view --web"))
    else if (firstFailure.label === "ECR Images") console.log(chalk.cyan("    Trigger a deploy: git push origin dev"))
    else if (firstFailure.label === "Secrets") console.log(chalk.cyan("    Run: ibx infra secrets"))
    else if (firstFailure.label === "Application Startup") console.log(chalk.cyan("    Run: ibx infra logs api"))
    else console.log(chalk.cyan("    Run: ibx infra status"))
  } else {
    console.log(chalk.green.bold("\n  ✅  No issues found — deployment chain looks healthy"))
  }
  console.log("")
}

// ── Command Registration ──────────────────────────────────────────────────────

export function registerInfraCommands(infra: Command) {
  infra
    .command("init")
    .description("Create S3 state bucket + DynamoDB lock table (idempotent)")
    .option("--region <region>", "AWS region", DEFAULT_REGION)
    .action(runInit)

  infra
    .command("plan")
    .description("Run terraform plan (with state safety check)")
    .option("--out <file>", "Save plan to file")
    .option("--env <name>", "Environment name")
    .action(runPlan)

  infra
    .command("apply")
    .description("Run terraform apply and display key outputs")
    .option("--plan <file>", "Apply a saved plan file")
    .option("--env <name>", "Environment name")
    .action(runApply)

  infra
    .command("secrets")
    .description("Populate Secrets Manager entries (interactive, --from-env for CI, --only to filter)")
    .option("--env <name>", "Environment name", "dev")
    .option("--force", "Re-prompt for secrets that already have values")
    .option("--from-env", "Non-interactive: read values from environment variables")
    .option("--only <names>", "Comma-separated list of secret names to process")
    .action(runSecrets)

  infra
    .command("secrets:export")
    .description("Export MANUAL_SECRETS from .env to infra/secrets.env")
    .option("--file <path>", "Source .env file path", ".env")
    .action(runSecretsExport)

  infra
    .command("secrets:push")
    .description("Push infra/secrets.env to AWS Secrets Manager")
    .option("--file <path>", "Source secrets.env file path", "infra/secrets.env")
    .option("--env <name>", "Environment name", "dev")
    .option("--force", "Re-push secrets that already have values")
    .option("--only <names>", "Comma-separated list of secret names to process")
    .action(runSecretsPush)

  infra
    .command("github")
    .description("Set GitHub repo secrets for CI/CD (detects repo)")
    .action(runGithub)

  infra
    .command("status")
    .description("Deployment health dashboard")
    .option("--json", "Machine-readable JSON output")
    .option("--env <name>", "Environment name")
    .action(runStatus)

  infra
    .command("checklist")
    .description("Full deployment checklist with completion status")
    .action(runChecklist)

  infra
    .command("destroy")
    .description("⚠  Destroy all AWS infrastructure (requires confirmation)")
    .option("--env <name>", "Environment name")
    .action(runDestroy)

  infra
    .command("logs [service]")
    .description("Tail docker logs on the dev host via SSM Run Command")
    .option("--lines <n>", "Number of lines", "50")
    .option("--env <name>", "Environment name")
    .action(runLogs)

  infra
    .command("deploy")
    .description("Push to dev/main + health check (--watch)")
    .option("--target <branch>", "Target branch (dev or main)", "dev")
    .option("--watch", "Poll status and health check after push")
    .option("--timeout <duration>", "Deploy timeout (e.g. 15m, 300s)", "15m")
    .action(runDeploy)

  infra
    .command("doctor")
    .description("Deep infrastructure diagnostics")
    .action(runDoctor)

  infra
    .command("explain")
    .description("Diagnose why a deploy is failing (follows dependency chain)")
    .action(runExplain)

  infra
    .command("idle")
    .description("Stop the dev EC2 host (pauses compute billing; EBS + EIP still charged)")
    .option("--env <name>", "Environment name", "dev")
    .option("--only <services>", "Comma-separated services (default: all)")
    .action(runIdle)

  infra
    .command("resume")
    .description("Start the dev EC2 host (~3-5 min to become healthy)")
    .option("--env <name>", "Environment name", "dev")
    .option("--count <n>", "Desired count per service", "1")
    .option("--only <services>", "Comma-separated services (default: all)")
    .action(runResume)
}
