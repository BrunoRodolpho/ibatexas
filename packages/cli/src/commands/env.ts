import type { Command } from "commander"
import chalk from "chalk"
import crypto from "node:crypto"

// ── Env var catalogue ─────────────────────────────────────────────────────────

interface EnvVar {
  key: string
  desc: string
  /** Phase this var is first needed */
  phase: 1 | 2
  /** Step within Phase 1 (undefined = needed from step 1) */
  step?: number
  /** Whether the value is a secret (mask in show output) */
  secret: boolean
  /** Minimum length validation (for secrets) */
  minLength?: number
  /** Example value shown in help */
  example?: string
}

const ENV_VARS: EnvVar[] = [
  // ── Infrastructure ──────────────────────────────────────────────────────────
  {
    key: "DATABASE_URL",
    desc: "PostgreSQL connection string",
    phase: 1,
    secret: false,
    example: "postgresql://ibatexas:ibatexas@localhost:5433/ibatexas",
  },
  {
    key: "REDIS_URL",
    desc: "Redis connection string",
    phase: 1,
    secret: false,
    example: "redis://localhost:6379",
  },
  {
    key: "NATS_URL",
    desc: "NATS JetStream connection string",
    phase: 1,
    secret: false,
    example: "nats://localhost:4222",
  },
  {
    key: "TYPESENSE_HOST",
    desc: "Typesense host",
    phase: 1,
    secret: false,
    example: "localhost",
  },
  {
    key: "TYPESENSE_PORT",
    desc: "Typesense port",
    phase: 1,
    secret: false,
    example: "8108",
  },
  {
    key: "TYPESENSE_API_KEY",
    desc: "Typesense API key",
    phase: 1,
    secret: true,
    example: "your-typesense-key",
  },

  // ── Medusa secrets ──────────────────────────────────────────────────────────
  {
    key: "JWT_SECRET",
    desc: "Medusa JWT signing secret (min 32 chars)",
    phase: 1,
    secret: true,
    minLength: 32,
    example: "$(openssl rand -base64 32)",
  },
  {
    key: "COOKIE_SECRET",
    desc: "Medusa cookie signing secret (min 32 chars)",
    phase: 1,
    secret: true,
    minLength: 32,
    example: "$(openssl rand -base64 32)",
  },

  // ── App URLs ────────────────────────────────────────────────────────────────
  {
    key: "MEDUSA_BACKEND_URL",
    desc: "Medusa backend URL (used by API + CLI)",
    phase: 1,
    secret: false,
    example: "http://localhost:9000",
  },

  // ── AI ──────────────────────────────────────────────────────────────────────
  {
    key: "ANTHROPIC_API_KEY",
    desc: "Anthropic Claude API key (Step 2 — agent)",
    phase: 1,
    step: 2,
    secret: true,
    example: "sk-ant-...",
  },
  {
    key: "OPENAI_API_KEY",
    desc: "OpenAI API key (Step 2 — embeddings)",
    phase: 1,
    step: 2,
    secret: true,
    example: "sk-...",
  },

  // ── Medusa store ─────────────────────────────────────────────────────────
  {
    key: "MEDUSA_PUBLISHABLE_KEY",
    desc: "Medusa store publishable API key (Step 4 — catalog routes)",
    phase: 1,
    step: 4,
    secret: false,
    example: "pk_...",
  },

  // ── Auth ────────────────────────────────────────────────────────────────────
  {
    key: "TWILIO_ACCOUNT_SID",
    desc: "Twilio account SID (Step 11 — WhatsApp OTP auth)",
    phase: 1,
    step: 11,
    secret: false,
    example: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    key: "TWILIO_AUTH_TOKEN",
    desc: "Twilio auth token (Step 11)",
    phase: 1,
    step: 11,
    secret: true,
    example: "your-twilio-auth-token",
  },
  {
    key: "TWILIO_VERIFY_SID",
    desc: "Twilio Verify service SID (Step 11)",
    phase: 1,
    step: 11,
    secret: false,
    example: "VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskSecret(value: string): string {
  if (value.length <= 8) return "•".repeat(value.length)
  return value.slice(0, 4) + "•".repeat(Math.min(value.length - 8, 20)) + value.slice(-4)
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerEnvCommands(program: Command) {
  const env = program
    .command("env")
    .description("Manage and validate environment variables")

  // ── ibx env check ──────────────────────────────────────────────────────────
  env
    .command("check")
    .description("Verify all required environment variables are set")
    .option("--step <n>", "Only check vars needed up to this step", "1")
    .action((opts: { step: string }) => {
      const maxStep = parseInt(opts.step, 10)
      const toCheck = ENV_VARS.filter(
        (v) => v.phase === 1 && (v.step === undefined || v.step <= maxStep)
      )

      console.log(chalk.bold(`\n  ibx env check  ${chalk.gray(`(step ≤ ${maxStep})`)}\n`))

      let missing = 0
      let warnings = 0

      for (const v of toCheck) {
        const val = process.env[v.key]
        const isSet = val !== undefined && val.trim() !== ""

        if (!isSet) {
          console.log(
            `  ${chalk.red("✗")}  ${chalk.red(v.key.padEnd(24))}  ${chalk.gray(v.desc)}`
          )
          if (v.example) {
            console.log(chalk.gray(`       example: ${v.example}`))
          }
          missing++
          continue
        }

        // Length validation for secrets
        if (v.minLength && val.length < v.minLength) {
          console.log(
            `  ${chalk.yellow("!")}  ${chalk.yellow(v.key.padEnd(24))}  ${chalk.gray(`${v.desc} — too short (${val.length} < ${v.minLength} chars)`)}`
          )
          warnings++
          continue
        }

        console.log(
          `  ${chalk.green("✓")}  ${chalk.white(v.key.padEnd(24))}  ${chalk.gray(v.desc)}`
        )
      }

      console.log()

      if (missing > 0) {
        console.log(
          chalk.red(
            `  ${missing} missing var(s). Copy .env.example → .env and fill them in.\n`
          )
        )
        process.exit(1)
      } else if (warnings > 0) {
        console.log(chalk.yellow(`  ${warnings} warning(s) — review the values above.\n`))
      } else {
        console.log(chalk.green(`  All ${toCheck.length} vars are set ✓\n`))
      }
    })

  // ── ibx env show ───────────────────────────────────────────────────────────
  env
    .command("show")
    .description("Show current environment variable values (secrets masked)")
    .option("--reveal", "Show full values — careful with secrets!")
    .action((opts: { reveal?: boolean }) => {
      console.log(chalk.bold(`\n  ibx env show\n`))

      for (const v of ENV_VARS) {
        const val = process.env[v.key]
        const isSet = val !== undefined && val.trim() !== ""

        let displayVal: string
        if (!isSet) {
          displayVal = chalk.gray("(not set)")
        } else if (v.secret && !opts.reveal) {
          displayVal = chalk.yellow(maskSecret(val))
        } else {
          displayVal = chalk.white(val)
        }

        const stepTag = v.step ? chalk.gray(` [step ${v.step}]`) : ""
        console.log(`  ${v.key.padEnd(24)}  ${displayVal}${stepTag}`)
      }

      if (!opts.reveal) {
        console.log(chalk.gray("\n  Secrets are masked. Use --reveal to show full values.\n"))
      } else {
        console.log()
      }
    })

  // ── ibx env gen ────────────────────────────────────────────────────────────
  const genAction = (length: string) => {
    const bytes = parseInt(length, 10)
    if (isNaN(bytes) || bytes < 16) {
      console.error(chalk.red("Length must be at least 16"))
      process.exit(1)
    }
    const secret = crypto.randomBytes(bytes).toString("base64")
    console.log(chalk.green(secret))
  }

  env
    .command("gen")
    .description("Generate a cryptographically secure random secret")
    .argument("[length]", "Number of bytes (default 32)", "32")
    .action(genAction)

  // backward-compat alias kept for scripts that reference `env generate`
  env
    .command("generate", { hidden: true })
    .argument("[length]", "Number of bytes (default 32)", "32")
    .action(genAction)
}
