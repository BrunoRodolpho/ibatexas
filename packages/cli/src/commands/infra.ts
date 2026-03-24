import path from "node:path"
import fs from "node:fs"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { ROOT } from "../utils/root.js"

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_REGION = process.env.AWS_REGION ?? "sa-east-1"
const STATE_BUCKET = "ibatexas-terraform-state"
const LOCK_TABLE = "ibatexas-terraform-locks"
const SECRET_PATH_PREFIX = "ibatexas"
const DEFAULT_DEPLOY_TIMEOUT = 15 * 60 * 1000

const VALID_SERVICES = ["api", "web", "admin", "nats", "typesense"] as const

const AUTO_POPULATED_SECRETS = ["REDIS_URL", "NATS_URL"]

const ALL_SECRETS = [
  "JWT_SECRET",
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "SENTRY_DSN",
  "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_VERIFY_SID",
  "NATS_URL",
  "REDIS_URL",
  "MEDUSA_ADMIN_API_KEY",
  "MEDUSA_API_KEY",
  "MEDUSA_PUBLISHABLE_KEY",
  "TYPESENSE_API_KEY",
  "OPENAI_API_KEY",
  "COOKIE_SECRET",
  "CORS_ORIGIN",
]

const MANUAL_SECRETS = ALL_SECRETS.filter(s => !AUTO_POPULATED_SECRETS.includes(s))

const GITHUB_SECRETS = [
  "AWS_DEPLOY_ROLE_ARN",
  "DIRECT_DATABASE_URL",
  "STAGING_DIRECT_DATABASE_URL",
  "SONAR_TOKEN",
]

/** Secrets that should use password-style prompt (masked input) */
const SENSITIVE_SECRETS = new Set([
  "JWT_SECRET", "DATABASE_URL", "DIRECT_DATABASE_URL", "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "TWILIO_AUTH_TOKEN",
  "OPENAI_API_KEY", "COOKIE_SECRET", "MEDUSA_ADMIN_API_KEY", "MEDUSA_API_KEY",
  "TYPESENSE_API_KEY",
])

// ── Secret Validators ─────────────────────────────────────────────────────────

const SECRET_VALIDATORS: Record<string, (v: string) => string | true> = {
  DATABASE_URL:          v => v.startsWith("postgresql://") || "Must start with postgresql://",
  DIRECT_DATABASE_URL:   v => v.startsWith("postgresql://") || "Must start with postgresql://",
  CORS_ORIGIN:           v => v.startsWith("http") || "Must be a URL (https://...)",
  SENTRY_DSN:            v => v.startsWith("https://") || "Must be a Sentry DSN URL",
  STRIPE_SECRET_KEY:     v => v.startsWith("sk_") || "Must start with sk_",
  STRIPE_WEBHOOK_SECRET: v => v.startsWith("whsec_") || "Must start with whsec_",
  ANTHROPIC_API_KEY:     v => v.length > 10 || "API key too short",
  OPENAI_API_KEY:        v => v.length > 10 || "API key too short",
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
  const directUrl = secrets.DIRECT_DATABASE_URL
  if (dbUrl && directUrl) {
    try {
      const dbHost = new URL(dbUrl).hostname
      const directHost = new URL(directUrl).hostname
      if (dbHost !== directHost) {
        warnings.push(`DATABASE_URL host (${dbHost}) differs from DIRECT_DATABASE_URL host (${directHost})`)
      }
    } catch { /* malformed URLs already caught by Layer 1 */ }
  }
  if (secrets.CORS_ORIGIN?.includes("localhost") && env !== "dev") {
    warnings.push(`CORS_ORIGIN contains "localhost" in ${env} environment`)
  }
  if (dbUrl && !dbUrl.includes("supabase") && env !== "dev") {
    warnings.push(`DATABASE_URL doesn't reference Supabase in ${env} — is this intentional?`)
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

// ── Check System ──────────────────────────────────────────────────────────────

type CheckSeverity = "blocking" | "degraded" | "informational"
type CheckStatus = "ok" | "warn" | "error" | "skip"

interface CheckResult {
  status: CheckStatus
  detail: string
}

interface InfraCheckDef {
  id: string
  group: "aws" | "terraform" | "ecs" | "secrets" | "github"
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
  {
    id: "terraform.acm",
    group: "terraform",
    label: "ACM Certificate",
    severity: "degraded",
    run: async () => {
      const res = await awsCommand(["acm", "list-certificates", "--region", DEFAULT_REGION, "--output", "json"])
      if (res.exitCode !== 0) return { status: "skip", detail: "could not query ACM" }
      try {
        const data = JSON.parse(res.stdout)
        const cert = data.CertificateSummaryList?.find((c: { DomainName: string }) => c.DomainName === "ibatexas.com.br" || c.DomainName === "*.ibatexas.com.br")
        if (!cert) return { status: "error", detail: "no certificate found for ibatexas.com.br" }
        return cert.Status === "ISSUED"
          ? { status: "ok", detail: `ISSUED (${cert.DomainName})` }
          : { status: "warn", detail: `${cert.Status} (${cert.DomainName})` }
      } catch {
        return { status: "skip", detail: "could not parse ACM response" }
      }
    },
  },
  // ── ECS ───────────────────────────────────────────────────────
  {
    id: "ecs.api",
    group: "ecs",
    label: "ECS — api",
    severity: "blocking",
    run: async (env) => checkEcsService(env, "api"),
  },
  {
    id: "ecs.web",
    group: "ecs",
    label: "ECS — web",
    severity: "blocking",
    run: async (env) => checkEcsService(env, "web"),
  },
  {
    id: "ecs.admin",
    group: "ecs",
    label: "ECS — admin",
    severity: "degraded",
    run: async (env) => checkEcsService(env, "admin"),
  },
  // ── Secrets ───────────────────────────────────────────────────
  {
    id: "secrets.populated",
    group: "secrets",
    label: "Secrets Populated",
    severity: "blocking",
    run: async (env) => {
      let populated = 0
      let empty = 0
      const missing: string[] = []
      for (const name of ALL_SECRETS) {
        const res = await awsCommand(["secretsmanager", "get-secret-value", "--secret-id", secretPath(env, name), "--region", DEFAULT_REGION, "--output", "json"])
        if (res.exitCode === 0) {
          try {
            const data = JSON.parse(res.stdout)
            if (data.SecretString && data.SecretString.trim()) { populated++; continue }
          } catch { /* fall through */ }
        }
        empty++
        missing.push(name)
      }
      if (empty === 0) return { status: "ok", detail: `${populated}/${ALL_SECRETS.length} populated` }
      if (populated === 0) return { status: "error", detail: `0/${ALL_SECRETS.length} — none set` }
      return { status: "warn", detail: `${populated}/${ALL_SECRETS.length} — missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` +${missing.length - 3} more` : ""}` }
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

async function checkEcsService(env: string, service: string): Promise<CheckResult> {
  const cluster = `ibatexas-${env}`
  const svcName = `ibatexas-${env}-${service}`
  const res = await awsCommand(["ecs", "describe-services", "--cluster", cluster, "--services", svcName, "--region", DEFAULT_REGION, "--output", "json"])
  if (res.exitCode !== 0) return { status: "error", detail: "cluster or service not found" }
  try {
    const data = JSON.parse(res.stdout)
    const svc = data.services?.[0]
    if (!svc) return { status: "error", detail: "service not found" }
    const desired = svc.desiredCount ?? 0
    const running = svc.runningCount ?? 0
    if (running >= desired && desired > 0) return { status: "ok", detail: `${running}/${desired} running` }
    return { status: "error", detail: `${running}/${desired} running` }
  } catch {
    return { status: "error", detail: "could not parse response" }
  }
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
  console.log(chalk.red("    ✗ Secrets not populated (17 required)"))
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

async function runSecrets(opts: { env?: string; force?: boolean; fromEnv?: boolean }) {
  const env = opts.env ?? getEnvironment()
  console.log(chalk.bold.blue("\n  🔐  Secrets Manager\n"))
  envBanner(env)

  let populated = 0
  let skipped = 0
  let alreadySet = 0
  let invalid = 0
  const populatedValues: Record<string, string> = {}

  for (const name of MANUAL_SECRETS) {
    const id = secretPath(env, name)

    // Check if already set
    if (!opts.force) {
      const check = await awsCommand(["secretsmanager", "get-secret-value", "--secret-id", id, "--region", DEFAULT_REGION, "--output", "json"])
      if (check.exitCode === 0) {
        try {
          const data = JSON.parse(check.stdout)
          if (data.SecretString?.trim()) {
            console.log(chalk.green(`  ✓ ${name.padEnd(28)} (already set)`))
            alreadySet++
            populatedValues[name] = data.SecretString
            continue
          }
        } catch { /* fall through to prompt */ }
      }
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
      const res = await awsCommand(["secretsmanager", "put-secret-value", "--secret-id", id, "--secret-string", envValue, "--region", DEFAULT_REGION])
      if (res.exitCode === 0) {
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

      const res = await awsCommand(["secretsmanager", "put-secret-value", "--secret-id", id, "--secret-string", value, "--region", DEFAULT_REGION])
      if (res.exitCode === 0) {
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
  const remaining = MANUAL_SECRETS.length - populated - alreadySet
  if (remaining > 0) {
    console.log(chalk.yellow(`  ⚠ ${remaining} secret(s) still empty — deploy may fail`))
  }
  console.log("")
}

// ── Subcommand: github ────────────────────────────────────────────────────────

async function runGithub() {
  const { execa } = await import("execa")
  const { confirm, password } = await import("@inquirer/prompts")
  const env = getEnvironment()
  console.log(chalk.bold.blue("\n  🐙  GitHub Secrets\n"))
  envBanner(env)

  const TOTAL = 3
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

  // [3] Set secrets
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
  const { execa } = await import("execa")
  const env = opts.env ?? getEnvironment()
  const svc = service ?? "api"

  if (!VALID_SERVICES.includes(svc as typeof VALID_SERVICES[number])) {
    console.error(chalk.red(`  Unknown service: ${svc}`))
    console.error(chalk.gray(`  Available: ${VALID_SERVICES.join(", ")}`))
    process.exit(1)
  }

  console.log(chalk.bold.blue(`\n  📜  Logs — ${svc}\n`))
  envBanner(env)

  const logGroup = `/ecs/ibatexas/${env}/${svc}`
  const lines = opts.lines ?? "50"

  try {
    await execa("aws", ["logs", "tail", logGroup, "--follow", "--since", "1h", "--format", "short", "--region", DEFAULT_REGION], { stdio: "inherit" })
  } catch (err) {
    const error = err as { exitCode?: number }
    if (error.exitCode === 255) {
      console.error(chalk.red(`  Log group not found: ${logGroup}`))
      console.error(chalk.gray("  Has the service been deployed at least once?"))
    }
    process.exit(error.exitCode ?? 1)
  }
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

  // [2] Wait for ECS stability
  step(++stepNum, TOTAL, "Waiting for ECS services to stabilize…")
  const start = Date.now()
  let stable = false
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 30_000))
    const elapsed = Math.round((Date.now() - start) / 1000)
    const spinner = ora({ text: `checking (${elapsed}s elapsed)…`, indent: 4 }).start()

    let allStable = true
    for (const svc of ["api", "web", "admin"]) {
      const result = await checkEcsService(env, svc)
      if (result.status !== "ok") { allStable = false; break }
    }

    if (allStable) {
      spinner.succeed(chalk.green("ECS services stable"))
      stable = true
      break
    }
    spinner.info(chalk.gray(`not yet stable (${elapsed}s)`))
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

  // 3. Check ECS services
  stepNum++
  let ecsOk = true
  for (const svc of ["api", "web", "admin"]) {
    const result = await checkEcsService(env, svc)
    if (result.status !== "ok") { ecsOk = false; break }
  }
  if (ecsOk) {
    findings.push({ step: stepNum, label: "ECS Services", ok: true, detail: "all services running" })
  } else {
    findings.push({ step: stepNum, label: "ECS Services", ok: false, detail: "service(s) not running" })
  }

  // 4. Check ECS events for crash reasons
  stepNum++
  const cluster = `ibatexas-${env}`
  const eventsRes = await awsCommand(["ecs", "describe-services", "--cluster", cluster, "--services", `ibatexas-${env}-api`, "--region", DEFAULT_REGION, "--output", "json"])
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

  // 5. Check secrets
  stepNum++
  let missingSecrets: string[] = []
  for (const name of MANUAL_SECRETS) {
    const res = await awsCommand(["secretsmanager", "get-secret-value", "--secret-id", secretPath(env, name), "--region", DEFAULT_REGION, "--output", "json"])
    if (res.exitCode !== 0) { missingSecrets.push(name); continue }
    try {
      const data = JSON.parse(res.stdout)
      if (!data.SecretString?.trim()) missingSecrets.push(name)
    } catch { missingSecrets.push(name) }
  }
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
    .description("Populate Secrets Manager entries (interactive, --from-env for CI)")
    .option("--env <name>", "Environment name", "dev")
    .option("--force", "Re-prompt for secrets that already have values")
    .option("--from-env", "Non-interactive: read values from environment variables")
    .action(runSecrets)

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
    .description("Tail ECS CloudWatch logs")
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
}
