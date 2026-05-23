// `ibx kernel` — operator surface for the adjudicate kernel.
//
// Three subcommands:
//
//   - `ibx kernel status`      — print the kernel's runtime state: env
//                                 flags (shadow/enforce), known intent kinds,
//                                 kill-switch, audit sink topology.
//
//   - `ibx kernel replay`      — re-feed audit records from Postgres through
//                                 adjudicate() and report drift. Requires
//                                 `IBX_AUDIT_POSTGRES_ENABLED=true` + a valid
//                                 `DATABASE_URL`. Gracefully no-ops with a
//                                 structured TODO when audit-postgres is off.
//
//   - `ibx kernel divergence`  — print shadow-divergence summary per intent
//                                 kind (BASIS_ONLY / DECISION_KIND /
//                                 PAYLOAD_REWRITE). Pulls from PostHog or
//                                 from the Postgres audit table (whichever
//                                 the operator has wired). Gracefully
//                                 no-ops with a structured TODO when no
//                                 telemetry sink is wired.
//
// All user-facing strings are pt-BR per CLAUDE.md rule #4.
//
// References:
//   - docs/adjudicate-migration/governance/01-intent-taxonomy.md
//   - packages/llm-provider/src/intent-kinds.ts (KNOWN_INTENT_KINDS)
//   - @adjudicate/core/kernel (isShadowed, isEnforced, getKillSwitchState)
//   - @adjudicate/audit-postgres (readAuditWindow)

import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"

// ── Helpers ───────────────────────────────────────────────────────────────

interface ParsedEnvList {
  raw: string
  wildcard: boolean
  kinds: readonly string[]
}

function parseEnvList(raw: string | undefined): ParsedEnvList {
  if (!raw) return { raw: "", wildcard: false, kinds: [] }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.includes("*")) {
    return {
      raw,
      wildcard: true,
      kinds: parts.filter((p) => p !== "*"),
    }
  }
  return { raw, wildcard: false, kinds: parts }
}

function parseDuration(input: string): number {
  // Parses "24h", "2h30m", "10m", "1d". Returns milliseconds. Throws on
  // invalid input.
  const regex = /^(\d+)([dhms])$/
  const m = regex.exec(input.trim())
  if (!m) {
    throw new Error(
      `Duração inválida: "${input}". Use formato '24h', '30m', '7d', '60s'.`,
    )
  }
  const n = Number.parseInt(m[1]!, 10)
  const unit = m[2]!
  const multiplier =
    unit === "d"
      ? 86_400_000
      : unit === "h"
        ? 3_600_000
        : unit === "m"
          ? 60_000
          : 1_000
  return n * multiplier
}

// ── ibx kernel status ─────────────────────────────────────────────────────

async function runStatus(opts: { json?: boolean }): Promise<void> {
  const shadow = parseEnvList(process.env.IBX_KERNEL_SHADOW)
  const enforce = parseEnvList(process.env.IBX_KERNEL_ENFORCE)
  const ledgerEnabled = process.env.IBX_LEDGER_ENABLED === "true"
  const ledgerEnforce = process.env.IBX_LEDGER_ENFORCE === "true"
  const ledgerFailOpen = process.env.IBX_LEDGER_FAIL_OPEN === "true"
  const postgresEnabled = process.env.IBX_AUDIT_POSTGRES_ENABLED === "true"

  // Pull KNOWN_INTENT_KINDS + kill switch lazily; the imports drag the
  // policy bundles into the CLI process which is fine but slow on cold
  // start.
  const { KNOWN_INTENT_KINDS } = await import("@ibatexas/llm-provider")
  const { getKillSwitchState } = await import("@adjudicate/core/kernel")
  const kill = getKillSwitchState()

  if (opts.json) {
    const out = {
      shadow: { ...shadow },
      enforce: { ...enforce },
      knownIntentKinds: {
        count: KNOWN_INTENT_KINDS.size,
        kinds: [...KNOWN_INTENT_KINDS].sort(),
      },
      ledger: {
        enabled: ledgerEnabled,
        enforce: ledgerEnforce,
        failOpen: ledgerFailOpen,
      },
      audit: {
        postgresEnabled,
      },
      killSwitch: kill,
    }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  console.log()
  console.log(chalk.bold("ibx kernel status"))
  console.log(chalk.dim("Estado de execução do kernel adjudicate."))
  console.log()

  console.log(chalk.bold("── Modo shadow (IBX_KERNEL_SHADOW) ─────────────"))
  if (shadow.wildcard) {
    console.log(`  ${chalk.cyan("wildcard")}  ${chalk.dim("(todos os intent kinds)")}`)
  } else if (shadow.kinds.length === 0) {
    console.log(`  ${chalk.dim("(nenhum kind em shadow)")}`)
  } else {
    for (const k of shadow.kinds) console.log(`  • ${k}`)
  }
  console.log()

  console.log(chalk.bold("── Modo enforce (IBX_KERNEL_ENFORCE) ────────────"))
  if (enforce.wildcard) {
    console.log(`  ${chalk.cyan("wildcard")}  ${chalk.dim("(todos os intent kinds)")}`)
  } else if (enforce.kinds.length === 0) {
    console.log(`  ${chalk.dim("(nenhum kind em enforce)")}`)
  } else {
    for (const k of enforce.kinds) console.log(`  • ${k}`)
  }
  console.log()

  console.log(chalk.bold("── Intent kinds conhecidos ──────────────────────"))
  console.log(`  ${chalk.cyan(String(KNOWN_INTENT_KINDS.size))} kinds em ${chalk.cyan("5")} packs`)
  // Group by domain for readability.
  const groups: Record<string, string[]> = {}
  for (const k of [...KNOWN_INTENT_KINDS].sort()) {
    const domain = k.split(".")[0] ?? "outros"
    if (!groups[domain]) groups[domain] = []
    groups[domain].push(k)
  }
  for (const [domain, kinds] of Object.entries(groups)) {
    console.log(`  ${chalk.dim(`${domain} (${kinds.length})`)} ${kinds.join(", ")}`)
  }
  console.log()

  console.log(chalk.bold("── Execution Ledger ─────────────────────────────"))
  console.log(`  enabled    : ${ledgerEnabled ? chalk.green("sim") : chalk.dim("não")}`)
  console.log(`  enforce    : ${ledgerEnforce ? chalk.green("sim") : chalk.dim("não")}`)
  console.log(`  fail-open  : ${ledgerFailOpen ? chalk.yellow("sim") : chalk.dim("não")}`)
  console.log()

  console.log(chalk.bold("── Audit sink ───────────────────────────────────"))
  console.log(`  postgres  : ${postgresEnabled ? chalk.green("ativo") : chalk.dim("desativado")}`)
  console.log(`  console   : ${chalk.green("sempre ativo")}`)
  console.log(`  nats      : ${chalk.green("sempre ativo")}  ${chalk.dim("(audit.intent.decision.v1)")}`)
  console.log()

  console.log(chalk.bold("── Kill switch ──────────────────────────────────"))
  if (kill.active) {
    console.log(`  ${chalk.red.bold("ATIVO")}`)
    console.log(`  motivo     : ${kill.reason}`)
    console.log(`  desde      : ${kill.toggledAt}`)
  } else {
    console.log(`  ${chalk.dim("inativo")}`)
  }
  console.log()
}

// ── ibx kernel replay ─────────────────────────────────────────────────────

async function runReplay(opts: {
  since?: string
  intentKind?: string
  limit?: string
  dryRun?: boolean
}): Promise<void> {
  const sinceInput = opts.since ?? "24h"
  let sinceMs: number
  try {
    sinceMs = parseDuration(sinceInput)
  } catch (err) {
    console.error(chalk.red((err as Error).message))
    process.exitCode = 1
    return
  }
  const limit = Number.parseInt(opts.limit ?? "1000", 10)
  const postgresEnabled = process.env.IBX_AUDIT_POSTGRES_ENABLED === "true"

  console.log()
  console.log(chalk.bold("ibx kernel replay"))
  console.log(chalk.dim(`Janela: últimos ${sinceInput}; limite: ${limit}; kind: ${opts.intentKind ?? "todos"}`))
  console.log()

  if (!postgresEnabled) {
    // STUB: audit-postgres is off in this deployment (task 19 default).
    // Operators flip the flag after the staging soak; until then, we
    // surface a structured TODO so the runbook step is honest.
    console.log(chalk.yellow("⚠  IBX_AUDIT_POSTGRES_ENABLED=false — replay não pode ser executado."))
    console.log()
    console.log(chalk.bold("TODO para o operador (quando audit-postgres for habilitado):"))
    console.log()
    console.log("  1. Habilitar IBX_AUDIT_POSTGRES_ENABLED=true no .env de produção.")
    console.log("  2. Rodar pnpm migrate em @adjudicate/audit-postgres para criar a tabela intent_audit.")
    console.log("  3. Rodar `ibx kernel replay --since=24h` novamente.")
    console.log()
    console.log(chalk.dim("Veja docs/adjudicate-migration/tasks/19-audit-postgres-pgnats-bridge.md"))
    console.log()
    process.exitCode = 0
    return
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(chalk.red("DATABASE_URL não definido. Replay requer conexão Postgres válida."))
    process.exitCode = 1
    return
  }

  const spinner = ora(`Lendo audit window dos últimos ${sinceInput}…`).start()
  try {
    // Lazy imports — audit-postgres + audit drag heavy deps.
    const { readAuditWindow } = await import("@adjudicate/audit-postgres")
    const { default: pg } = await import("pg" as string).catch(() => {
      throw new Error("módulo pg não encontrado — instale com `pnpm install`")
    })

    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const toIso = new Date().toISOString()
      const fromIso = new Date(Date.now() - sinceMs).toISOString()

      const queryFn = {
        async fetchRows(window: {
          fromIso: string
          toIso: string
          intentKind?: string
          limit?: number
        }): Promise<readonly Record<string, unknown>[]> {
          const params: unknown[] = [window.fromIso, window.toIso]
          let sql =
            "SELECT * FROM intent_audit WHERE recorded_at >= $1 AND recorded_at < $2"
          if (window.intentKind) {
            params.push(window.intentKind)
            sql += ` AND intent_kind = $${params.length}`
          }
          if (window.limit !== undefined) {
            params.push(window.limit)
            sql += ` ORDER BY recorded_at DESC LIMIT $${params.length}`
          }
          const result = (await client.query(sql, params)) as {
            rows: Array<Record<string, unknown>>
          }
          return result.rows
        },
      }

      const records = await readAuditWindow(
        // @ts-expect-error — the runtime cast matches AuditQueryFn shape.
        queryFn,
        {
          fromIso,
          toIso,
          ...(opts.intentKind !== undefined ? { intentKind: opts.intentKind } : {}),
          limit,
        },
      )

      spinner.succeed(`Lidos ${records.length} registros de audit.`)

      if (opts.dryRun) {
        console.log(chalk.yellow("\nModo --dry-run: nenhuma re-adjudicação executada."))
        for (const r of records.slice(0, 10)) {
          console.log(
            `  ${chalk.dim(r.envelope.createdAt)}  ${chalk.cyan(r.envelope.kind)}  ${chalk.dim(r.intentHash.slice(0, 12))}`,
          )
        }
        if (records.length > 10) {
          console.log(chalk.dim(`  ... e mais ${records.length - 10}`))
        }
        return
      }

      // TODO(audit-replay): re-feed records through adjudicate() with the
      // matching policy bundle, then call replayWithIntegrity +
      // explainReplayReport. Today the CLI prints a summary; the full
      // re-adjudication harness requires composing the right PolicyBundle
      // per intent kind (orders/reservations/whatsapp/customer/pix) which
      // we defer until the rollout playbook needs it. See
      // docs/adjudicate-migration/tasks/20-test-coverage-baseline.md
      // §"ibx kernel replay CLI" for the full surface.
      console.log()
      console.log(chalk.bold("Resumo por intent kind:"))
      const counts: Record<string, number> = {}
      for (const r of records) {
        const k = r.envelope.kind
        counts[k] = (counts[k] ?? 0) + 1
      }
      for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${chalk.cyan(String(n).padStart(5))}  ${k}`)
      }
      console.log()
      console.log(chalk.dim("Drift completo (replayWithIntegrity) será adicionado quando o postgres adopter shipping completar — veja TODO inline."))
    } finally {
      await client.end()
    }
  } catch (err) {
    spinner.fail(chalk.red(`Falhou: ${(err as Error).message}`))
    process.exitCode = 1
  }
}

// ── ibx kernel divergence ─────────────────────────────────────────────────

async function runDivergence(opts: { since?: string }): Promise<void> {
  const sinceInput = opts.since ?? "24h"
  console.log()
  console.log(chalk.bold("ibx kernel divergence"))
  console.log(chalk.dim(`Janela: últimos ${sinceInput}`))
  console.log()

  const postgresEnabled = process.env.IBX_AUDIT_POSTGRES_ENABLED === "true"
  const postHogKey = process.env.POSTHOG_API_KEY

  if (!postgresEnabled && !postHogKey) {
    console.log(
      chalk.yellow(
        "⚠  Nem IBX_AUDIT_POSTGRES_ENABLED nem POSTHOG_API_KEY estão configurados.",
      ),
    )
    console.log()
    console.log(chalk.bold("TODO para o operador:"))
    console.log()
    console.log("  Opção A — Postgres (recomendado em produção):")
    console.log("    1. Habilitar IBX_AUDIT_POSTGRES_ENABLED=true.")
    console.log("    2. Aguardar uma janela de shadow (24h+) com IBX_KERNEL_SHADOW definido.")
    console.log("    3. Rodar `ibx kernel divergence --since=24h`.")
    console.log()
    console.log("  Opção B — PostHog (recomendado em dev):")
    console.log("    1. Setar POSTHOG_API_KEY no .env.")
    console.log("    2. Confirmar que setMetricsSink() está conectado ao PostHog em runtime.")
    console.log("    3. Rodar `ibx kernel divergence --since=24h`.")
    console.log()
    console.log(
      chalk.dim(
        "Os 3 classes de divergência são: BASIS_ONLY, DECISION_KIND, PAYLOAD_REWRITE.",
      ),
    )
    console.log(
      chalk.dim(
        "Veja docs/adjudicate-migration/governance/05-audit-replay-requirements.md.",
      ),
    )
    console.log()
    return
  }

  // STUB: when telemetry IS wired, query and aggregate. Today this prints
  // a placeholder so the runbook step has a known surface.
  console.log(
    chalk.yellow(
      "⚠  Implementação de divergence ainda no formato stub — operadores devem usar dashboards PostHog (ver docs/ops/analytics-dashboards.md) até o shipping completo.",
    ),
  )
  console.log()
  console.log(chalk.bold("Resumo (placeholder):"))
  console.log()
  console.log("  Classe              Eventos    Intent kinds afetados")
  console.log("  ─────────────────   ────────   ──────────────────────")
  console.log("  BASIS_ONLY               —     —")
  console.log("  DECISION_KIND            —     —")
  console.log("  PAYLOAD_REWRITE          —     —")
  console.log()
  console.log(
    chalk.dim(
      "TODO(divergence-cli): implementar agregação real quando o pipeline PostHog/Postgres de shadow-events estabilizar — task 21+.",
    ),
  )
  console.log()
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerKernelCommands(group: Command): void {
  group.description("Kernel — estado, replay e divergência do adjudicate kernel")

  group
    .command("status")
    .description("Mostra o estado do kernel: shadow/enforce, intent kinds, ledger, audit sinks")
    .option("--json", "Emite saída JSON")
    .action(async (opts: { json?: boolean }) => {
      await runStatus(opts)
    })

  group
    .command("replay")
    .description(
      "Re-feeda registros de audit por adjudicate() e relata drift (--since=24h, --intent-kind=X, --limit=1000)",
    )
    .option("--since <duration>", "Janela de tempo (ex: 24h, 7d, 30m)", "24h")
    .option("--intent-kind <kind>", "Filtra por intent kind (ex: order.checkout.create)")
    .option("--limit <n>", "Limite de registros (default 1000)", "1000")
    .option("--dry-run", "Apenas lista os registros sem re-adjudicar")
    .action(
      async (opts: {
        since?: string
        intentKind?: string
        limit?: string
        dryRun?: boolean
      }) => {
        await runReplay(opts)
      },
    )

  group
    .command("divergence")
    .description("Resumo de divergências shadow-mode por classe (BASIS_ONLY, DECISION_KIND, PAYLOAD_REWRITE)")
    .option("--since <duration>", "Janela de tempo (ex: 24h, 7d)", "24h")
    .action(async (opts: { since?: string }) => {
      await runDivergence(opts)
    })
}
