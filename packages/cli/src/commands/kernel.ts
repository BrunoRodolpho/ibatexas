// `ibx kernel` — operator surface for the adjudicate kernel.
//
// Subcommands:
//
//   - `ibx kernel status`        — print the kernel's runtime state.
//
//   - `ibx kernel kill-switch`   — W3 D1 — operator-flippable Redis flag
//                                   (`ibatexas:kill-switch:global`) +
//                                   pub/sub channel for cross-replica
//                                   propagation. Sub-subcommands:
//                                   enable, disable, status [--json].
//
//   - (kept) `ibx kernel status`      — print the kernel's runtime state: env
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
import { parseBoolEnv } from "@ibatexas/llm-provider"

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
  // NEW-P1-ENV: was `=== "true"` for all four. parseBoolEnv accepts the
  // canonical truthy lexicon (true/1/yes/on, any case) and defaults to
  // false for unset/typo inputs. The CLI now agrees with the runtime
  // sites that read these same env vars (kernel-bootstrap, intent-
  // audit-wiring, intent-ledger) — fixing the "CLI shows enabled but
  // runtime reads disabled" drift that a `=TRUE` typo would produce.
  const ledgerEnabled = parseBoolEnv(process.env.IBX_LEDGER_ENABLED, false)
  const ledgerEnforce = parseBoolEnv(process.env.IBX_LEDGER_ENFORCE, false)
  const ledgerFailOpen = parseBoolEnv(process.env.IBX_LEDGER_FAIL_OPEN, false)
  const postgresEnabled = parseBoolEnv(
    process.env.IBX_AUDIT_POSTGRES_ENABLED,
    false,
  )

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
  // NEW-P1-ENV: see runStatus() above for rationale.
  const postgresEnabled = parseBoolEnv(
    process.env.IBX_AUDIT_POSTGRES_ENABLED,
    false,
  )

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

      // W3 D3 — real re-adjudication path. For each audit record we:
      //   1. Reconstruct the envelope (already done by readAuditWindow).
      //   2. Look up the appropriate first-party Pack for the intent kind.
      //   3. Re-call adjudicate(envelope, defaultState, pack.policy).
      //   4. Compare the new Decision against the historical one and
      //      classify the drift (DECISION_KIND / BASIS_DRIFT /
      //      REWRITE-payload).
      //
      // State rehydration is deliberately minimal — we cannot reconstruct
      // the order/customer projections at the historical moment without
      // a point-in-time DB read. Instead we adjudicate against the empty
      // default state and accept that "no-state-context" drift will
      // appear on a subset of guards. Operators interpret the divergence
      // summary against the runbook's threshold list, not as an absolute.
      // AuditRecord is a structural type with no string index signature;
      // we cast to the loose shape the helper consumes. The helper itself
      // narrows fields by name (envelope.kind, decision, basis) so the
      // runtime contract is preserved.
      const report = await reAdjudicateRecords(
        records as unknown as readonly Record<string, unknown>[],
      )
      printReplayReport(report)
    } finally {
      await client.end()
    }
  } catch (err) {
    spinner.fail(chalk.red(`Falhou: ${(err as Error).message}`))
    process.exitCode = 1
  }
}

// ── replay implementation helpers ─────────────────────────────────────────

interface ReplayReport {
  total: number
  matched: number
  driftedByDecisionKind: number
  driftedByBasis: number
  driftedByPayload: number
  errors: number
  byKind: Record<string, { total: number; drifted: number }>
}

async function reAdjudicateRecords(
  records: readonly Record<string, unknown>[],
): Promise<ReplayReport> {
  const report: ReplayReport = {
    total: records.length,
    matched: 0,
    driftedByDecisionKind: 0,
    driftedByBasis: 0,
    driftedByPayload: 0,
    errors: 0,
    byKind: {},
  }
  if (records.length === 0) return report

  // Lazy-load adjudicate + packs only when there's work to do.
  const { adjudicate } = await import("@adjudicate/core/kernel")
  const packIndex = await loadPackIndex()

  for (const record of records) {
    const envelope = (record as { envelope?: { kind?: string } }).envelope
    const historical = (record as { decision?: { kind?: string; basis?: unknown } })
      .decision
    if (!envelope || !envelope.kind || !historical) {
      report.errors += 1
      continue
    }
    const kind = envelope.kind
    report.byKind[kind] = report.byKind[kind] ?? { total: 0, drifted: 0 }
    report.byKind[kind]!.total += 1

    const pack = packIndex.get(kind)
    if (!pack) {
      // No installed Pack for this kind. Surface as an error bucket so
      // operators see the coverage gap.
      report.errors += 1
      continue
    }

    let current: { kind: string; basis?: unknown } | null = null
    try {
      // Run adjudicate against an empty default state. See the comment
      // in runReplay about state rehydration — the absence of state
      // primarily exercises the policy's guards that do NOT read state.
      current = (await adjudicate(
        envelope as never,
        {} as never,
        pack.policy as never,
      )) as { kind: string; basis?: unknown }
    } catch {
      report.errors += 1
      continue
    }

    // ── Classify drift ─────────────────────────────────────────────────
    if (current.kind !== historical.kind) {
      report.driftedByDecisionKind += 1
      report.byKind[kind]!.drifted += 1
      continue
    }

    // Same kind — check basis-drift.
    const histBasis = flattenBasis(
      (historical as { basis?: ReadonlyArray<{ category?: string; code?: string }> })
        .basis ?? [],
    )
    const currBasis = flattenBasis(
      (current as { basis?: ReadonlyArray<{ category?: string; code?: string }> })
        .basis ?? [],
    )
    if (
      histBasis.length !== currBasis.length ||
      histBasis.some((b, i) => b !== currBasis[i])
    ) {
      report.driftedByBasis += 1
      report.byKind[kind]!.drifted += 1
      continue
    }

    // For REWRITE decisions, check payload equality.
    if (current.kind === "REWRITE") {
      const histRewritten = JSON.stringify(
        (historical as { rewritten?: unknown }).rewritten ?? null,
      )
      const currRewritten = JSON.stringify(
        (current as { rewritten?: unknown }).rewritten ?? null,
      )
      if (histRewritten !== currRewritten) {
        report.driftedByPayload += 1
        report.byKind[kind]!.drifted += 1
        continue
      }
    }

    report.matched += 1
  }
  return report
}

function flattenBasis(
  basis: ReadonlyArray<{ category?: string; code?: string }>,
): string[] {
  return basis
    .map((b) => `${b.category ?? "_"}:${b.code ?? "_"}`)
    .sort()
}

interface InstalledPack {
  readonly id: string
  readonly intents: readonly string[]
  readonly policy: unknown
}

async function loadPackIndex(): Promise<Map<string, InstalledPack>> {
  // Lazy import — packs drag the full policy bundles, which is heavy
  // for a CLI that may not need them. We catch ESM resolution errors
  // so the CLI degrades gracefully when running outside the monorepo.
  const map = new Map<string, InstalledPack>()
  const packs: InstalledPack[] = []
  const safeImport = async (
    spec: string,
    namedExport: string,
  ): Promise<InstalledPack | null> => {
    try {
      const mod = (await import(spec as string)) as Record<
        string,
        InstalledPack | undefined
      >
      return mod[namedExport] ?? null
    } catch {
      return null
    }
  }
  for (const [spec, exp] of [
    ["@ibatexas/pack-orders", "ordersPack"],
    ["@ibatexas/pack-reservations", "reservationsPack"],
    ["@ibatexas/pack-whatsapp", "whatsappPack"],
    ["@ibatexas/pack-customer-onboarding", "customerOnboardingPack"],
    ["@ibatexas/pack-payments", "paymentsPack"],
    ["@adjudicate/pack-payments-pix", "pixChargeLifecyclePack"],
  ] as const) {
    const pack = await safeImport(spec, exp)
    if (pack) packs.push(pack)
  }
  for (const pack of packs) {
    for (const intent of pack.intents ?? []) {
      map.set(intent, pack)
    }
  }
  return map
}

function printReplayReport(report: ReplayReport): void {
  console.log()
  console.log(chalk.bold("Resumo de divergência (replay)"))
  console.log()
  console.log(`  Total                          : ${chalk.cyan(String(report.total))}`)
  console.log(`  Matched (igual)                : ${chalk.green(String(report.matched))}`)
  console.log(`  Drifted by DECISION_KIND       : ${chalk.yellow(String(report.driftedByDecisionKind))}`)
  console.log(`  Drifted by BASIS               : ${chalk.yellow(String(report.driftedByBasis))}`)
  console.log(`  Drifted by PAYLOAD (REWRITE)   : ${chalk.yellow(String(report.driftedByPayload))}`)
  if (report.errors > 0) {
    console.log(`  Erros (pack ausente / parse)   : ${chalk.red(String(report.errors))}`)
  }
  console.log()

  if (report.total === 0) {
    console.log(chalk.dim("0 registros na janela — nenhum replay executado."))
    console.log()
    return
  }

  // Per-kind breakdown for the top 10 drifters.
  const sorted = Object.entries(report.byKind)
    .filter(([, v]) => v.drifted > 0)
    .sort((a, b) => b[1].drifted - a[1].drifted)
    .slice(0, 10)
  if (sorted.length > 0) {
    console.log(chalk.bold("Top intent kinds com drift:"))
    console.log()
    for (const [kind, stats] of sorted) {
      const pct = stats.total > 0 ? ((stats.drifted / stats.total) * 100).toFixed(1) : "0.0"
      console.log(
        `  ${chalk.cyan(String(stats.drifted).padStart(5))} / ${String(stats.total).padStart(5)}  ${chalk.dim(`(${pct}%)`)}  ${kind}`,
      )
    }
    console.log()
  } else if (report.matched === report.total) {
    console.log(chalk.green("Todos os registros reproduziram exatamente o histórico — sem drift."))
    console.log()
  }
}

// ── ibx kernel divergence ─────────────────────────────────────────────────

interface DivergenceCounter {
  total: number
  byClass: Record<string, number>
  byKind: Record<string, number>
  byKindClass: Record<string, Record<string, number>>
}

/**
 * W5-8: implement enough of `ibx kernel divergence` to be useful in
 * shadow rollout. Pulls audit records from Postgres in the window,
 * groups by intent kind, counts kernel-vs-legacy divergence events,
 * and prints a summary table.
 *
 * Today's audit pipeline emits `kernel_shadow_divergence_total` metric
 * via the MetricsSink, but the raw events are persisted to Postgres
 * via the audit-postgres adopter when `IBX_AUDIT_POSTGRES_ENABLED=true`.
 * The audit-record `basis` carries a `kernel.shadow_divergence` flag
 * with the divergence class (BASIS_ONLY / DECISION_KIND / PAYLOAD_REWRITE)
 * in metadata. This CLI scans for those.
 *
 * When IBX_AUDIT_POSTGRES_ENABLED=false, gracefully output the runbook
 * step (no shadow data yet — operator enables postgres + waits 24h+).
 */
async function runDivergence(opts: {
  since?: string
  intentKind?: string
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

  console.log()
  console.log(chalk.bold("ibx kernel divergence"))
  console.log(
    chalk.dim(
      `Janela: últimos ${sinceInput}; kind: ${opts.intentKind ?? "todos"}`,
    ),
  )
  console.log()

  // NEW-P1-ENV: see runStatus() above for rationale.
  const postgresEnabled = parseBoolEnv(
    process.env.IBX_AUDIT_POSTGRES_ENABLED,
    false,
  )

  if (!postgresEnabled) {
    console.log(
      chalk.yellow(
        "⚠  IBX_AUDIT_POSTGRES_ENABLED=false — sem dados de shadow ainda.",
      ),
    )
    console.log()
    console.log(chalk.bold("TODO para o operador:"))
    console.log()
    console.log("    1. Habilitar IBX_AUDIT_POSTGRES_ENABLED=true em .env.")
    console.log("    2. Setar IBX_KERNEL_SHADOW=<kinds> para iniciar shadow.")
    console.log("    3. Aguardar uma janela de 24h+ com tráfego real.")
    console.log("    4. Rodar `ibx kernel divergence --since=24h` novamente.")
    console.log()
    console.log(
      chalk.dim(
        "Classes de divergência: BASIS_ONLY, DECISION_KIND, PAYLOAD_REWRITE.",
      ),
    )
    console.log(
      chalk.dim(
        "Veja docs/adjudicate-migration/governance/05-audit-replay-requirements.md.",
      ),
    )
    console.log()
    process.exitCode = 0
    return
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      chalk.red("DATABASE_URL não definido — divergence requer conexão Postgres."),
    )
    process.exitCode = 1
    return
  }

  const spinner = ora(`Lendo audit window dos últimos ${sinceInput}…`).start()
  try {
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

      // W3 D4 fix: thread `--intent-kind` through to the window
      // descriptor. The `queryFn.fetchRows` above already handles
      // `window.intentKind` correctly — the bug was that `runDivergence`
      // never passed it. Audit/08 documented the leak; the operator
      // asked for one kind and silently got everything.
      const records = await readAuditWindow(
        // @ts-expect-error — runtime shape matches AuditQueryFn
        queryFn,
        {
          fromIso,
          toIso,
          ...(opts.intentKind !== undefined
            ? { intentKind: opts.intentKind }
            : {}),
          limit: 10_000,
        },
      )

      spinner.succeed(`Lidos ${records.length} registros de audit.`)

      // Group divergence events. We look at the basis array on each
      // record for entries with category="kernel" and code containing
      // "shadow_divergence" — those carry the class in metadata.
      const counter: DivergenceCounter = {
        total: 0,
        byClass: {},
        byKind: {},
        byKindClass: {},
      }

      for (const record of records) {
        const basisList = ((record as { basis?: unknown }).basis ??
          []) as ReadonlyArray<{
          category?: string
          code?: string
          metadata?: Record<string, unknown>
        }>
        const divergence = basisList.find(
          (b) =>
            b.category === "kernel" &&
            typeof b.code === "string" &&
            b.code.includes("shadow_divergence"),
        )
        if (!divergence) continue

        const divClass =
          typeof divergence.metadata?.["class"] === "string"
            ? (divergence.metadata["class"] as string)
            : "UNKNOWN"
        const kind =
          (record as { envelope?: { kind?: string } }).envelope?.kind ??
          "unknown.kind"

        counter.total += 1
        counter.byClass[divClass] = (counter.byClass[divClass] ?? 0) + 1
        counter.byKind[kind] = (counter.byKind[kind] ?? 0) + 1
        if (!counter.byKindClass[kind]) counter.byKindClass[kind] = {}
        counter.byKindClass[kind]![divClass] =
          (counter.byKindClass[kind]![divClass] ?? 0) + 1
      }

      console.log()
      console.log(chalk.bold("Resumo por classe:"))
      console.log()
      console.log("  Classe              Eventos    Intent kinds afetados")
      console.log("  ─────────────────   ────────   ──────────────────────")
      for (const klass of ["BASIS_ONLY", "DECISION_KIND", "PAYLOAD_REWRITE"]) {
        const count = counter.byClass[klass] ?? 0
        const affectedKinds = Object.entries(counter.byKindClass)
          .filter(([, v]) => v[klass] !== undefined && v[klass]! > 0)
          .map(([k]) => k)
          .join(", ")
        console.log(
          `  ${klass.padEnd(17)}   ${String(count).padStart(8)}   ${
            affectedKinds || chalk.dim("—")
          }`,
        )
      }

      if (counter.total === 0) {
        console.log()
        console.log(
          chalk.green(
            "Nenhuma divergência detectada — pacote shadow está alinhado com legacy.",
          ),
        )
      } else {
        console.log()
        console.log(chalk.bold("Top intent kinds (eventos totais):"))
        console.log()
        const sorted = Object.entries(counter.byKind).sort(
          (a, b) => b[1] - a[1],
        )
        for (const [kind, count] of sorted.slice(0, 10)) {
          console.log(`  ${chalk.cyan(String(count).padStart(6))}  ${kind}`)
        }

        // Suggest unsafe intents: high divergence count = risky enforce flip.
        const unsafe = sorted
          .filter(([, count]) => count >= 5)
          .map(([k]) => k)
        if (unsafe.length > 0) {
          console.log()
          console.log(chalk.bold.yellow("⚠  Sugestão — NÃO habilitar enforce para:"))
          for (const kind of unsafe) {
            console.log(
              `  • ${kind} ${chalk.dim(`(${counter.byKind[kind]} divergências em ${sinceInput})`)}`,
            )
          }
          console.log()
          console.log(
            chalk.dim(
              "Esses kinds têm alto volume de divergência — revisar o policy bundle antes de incluir em IBX_KERNEL_ENFORCE.",
            ),
          )
        }
      }
      console.log()
    } finally {
      await client.end()
    }
  } catch (err) {
    spinner.fail(chalk.red(`Falhou: ${(err as Error).message}`))
    process.exitCode = 1
  }
}

// ── ibx kernel kill-switch (W3 D1) ────────────────────────────────────────
//
// Operator surface for engaging/disengaging the global kill switch.
// Backed by the `@ibatexas/tools.createKillSwitchStore` primitive which
// writes the metadata to `rk("kill-switch:global")` with a 24h TTL and
// publishes events on `rk("kill-switch:events")` for cross-replica
// propagation.
//
// Why a Redis flag instead of `setKillSwitch()` direct? The kernel
// module's `setKillSwitch()` is in-process — flipping it in the CLI
// would only affect the CLI's own process. The Redis flag is the
// distributed signal that API replicas pick up via the pub/sub channel
// + restart-safety polling (per `migration/05-kill-switch-strategy.md`
// §"Distributed propagation").

async function emitSentryBreadcrumb(input: {
  action: "enable" | "disable" | "status"
  reason?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  // CLI doesn't bundle @sentry/node by default. We try to load it
  // lazily; if missing or DSN unset, fall back to a structured stderr
  // breadcrumb so we still leave a trace. This pattern is consistent
  // with the rest of the CLI's "best-effort observability" stance.
  if (!process.env.SENTRY_DSN) return
  try {
    const sentry = (await import("@sentry/node" as string).catch(
      () => null,
    )) as { addBreadcrumb?: (b: unknown) => void } | null
    sentry?.addBreadcrumb?.({
      category: "kernel.kill_switch",
      level: input.action === "enable" ? "warning" : "info",
      message: `kill-switch.${input.action}`,
      data: {
        reason: input.reason ?? null,
        ...(input.metadata ?? {}),
      },
    })
  } catch {
    // Best-effort — log a structured marker.
    console.error(
      JSON.stringify({
        breadcrumb: "kernel.kill_switch",
        action: input.action,
        reason: input.reason,
      }),
    )
  }
}

// W7-O3 — Two-person bypass posture for the CLI surface.
//
// The CLI engages the kill switch by writing the Redis flag directly
// (`createKillSwitchStore.enable`); the admin HTTP endpoint at
// `apps/api/src/routes/admin/kernel.ts` enforces a two-person rule via the
// receipt-store + same-actor refusal. The two surfaces have different threat
// models and we own naming that explicitly:
//
//   - CLI    → solo on-call EMERGENCIES. The two-person rule is intentionally
//              bypassed because the failure mode the CLI exists to break out
//              of is "secondary operator unreachable at 3am". Compromised
//              credential trade-off accepted (see W7-DECISIONS-ops.md §O3).
//   - HTTP   → scheduled flips. Two distinct OWNER staff identities required.
//
// To make the bypass posture impossible to miss, we:
//   1. Print a red banner naming the bypass before mutating Redis.
//   2. Require an explicit `--yes-i-am-solo-on-call` flag OR an interactive
//      TTY confirmation prompt. Non-TTY callers without the flag REFUSE so
//      a `yes | ibx kernel kill-switch enable ...` pipeline cannot
//      single-handedly engage by accident.
//   3. Stamp `bypass: "two_person_rule"`, `surface: "cli"` on the Sentry
//      breadcrumb metadata so an incident review can correlate.

async function confirmSoloOperatorBypass(opts: {
  yesIAmSoloOnCall: boolean
}): Promise<boolean> {
  // The flag is the non-interactive escape hatch. CI / pager-script callers
  // pass it explicitly; the docstring + commit log are the audit trail.
  if (opts.yesIAmSoloOnCall) {
    console.log()
    console.log(
      chalk.red.bold(
        "ATENÇÃO — bypass da regra de dois operadores via --yes-i-am-solo-on-call",
      ),
    )
    console.log(
      chalk.dim(
        "Esta invocação ignora a regra de dois operadores aplicada pelo endpoint admin.",
      ),
    )
    console.log()
    return true
  }
  // No flag — require an interactive TTY so a script pipeline cannot bypass.
  if (!process.stdin.isTTY) {
    console.error()
    console.error(
      chalk.red.bold(
        "Recusado — bypass da regra de dois operadores requer TTY ou --yes-i-am-solo-on-call.",
      ),
    )
    console.error(
      chalk.dim(
        "Pipeline detectado (stdin não é TTY). Para emergências de plantão solo, passe --yes-i-am-solo-on-call.",
      ),
    )
    console.error()
    return false
  }
  // Interactive prompt — operator must type the literal pt-BR confirmation
  // phrase. Constant-string compare (not constant-time — this is a user-
  // typed value, not a secret).
  const expected = "engajar agora"
  console.log()
  console.log(
    chalk.red.bold(
      "ATENÇÃO — engajar kill switch via CLI ignora a regra de dois operadores.",
    ),
  )
  console.log(
    chalk.dim(
      "Esta superfície existe para emergências de plantão solo. Operações agendadas devem usar POST /api/admin/kernel/kill-switch.",
    ),
  )
  console.log()
  process.stdout.write(
    `Digite "${expected}" para confirmar o bypass: `,
  )
  const answer = await readSingleLineFromStdin()
  if (answer.trim() !== expected) {
    console.log()
    console.log(chalk.dim("Cancelado — kill switch NÃO engajado."))
    console.log()
    return false
  }
  return true
}

async function readSingleLineFromStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = ""
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      buf += text
      if (buf.includes("\n")) {
        process.stdin.removeListener("data", onData)
        process.stdin.pause()
        resolve(buf.replace(/\n.*$/s, ""))
      }
    }
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}

interface KillSwitchCliDeps {
  readonly getRedis: () => Promise<unknown>
  readonly rk: (key: string) => string
}

async function loadKillSwitchDeps(): Promise<KillSwitchCliDeps> {
  // Lazy import keeps the CLI cold-start fast — kill-switch is a rare
  // operator action, no need to pay the redis-connect cost for every
  // `ibx kernel status` call.
  const tools = await import("@ibatexas/tools")
  return {
    getRedis: () => tools.getRedisClient(),
    rk: tools.rk,
  }
}

function operatorIdentity(): string {
  // Best-effort operator identity for the audit record:
  //   1. $IBX_OPERATOR if explicitly set (CI / bastion env).
  //   2. user@host otherwise.
  // The admin endpoint replaces this with the staffId derived from the
  // JWT — see `apps/api/src/routes/admin/kernel.ts`.
  const explicit = process.env.IBX_OPERATOR
  if (explicit && explicit.length > 0) return `cli:${explicit}`
  const user = process.env.USER ?? process.env.USERNAME ?? "unknown"
  const host = process.env.HOST ?? process.env.HOSTNAME ?? "unknown"
  return `cli:${user}@${host}`
}

async function closeRedisQuietly(): Promise<void> {
  try {
    const { closeRedisClient } = await import("@ibatexas/tools")
    await closeRedisClient()
  } catch {
    // Best-effort — CLI may exit even if the close fails.
  }
}

async function runKillSwitchEnable(opts: {
  reason: string
  yesIAmSoloOnCall?: boolean
}): Promise<void> {
  // W7-O3 — confirm or refuse the two-person-rule bypass BEFORE touching Redis.
  const confirmed = await confirmSoloOperatorBypass({
    yesIAmSoloOnCall: opts.yesIAmSoloOnCall === true,
  })
  if (!confirmed) {
    process.exitCode = 1
    return
  }
  const { getRedis, rk } = await loadKillSwitchDeps()
  const { createKillSwitchStore } = await import("@ibatexas/tools")
  const redis = (await getRedis()) as Parameters<
    typeof createKillSwitchStore
  >[0]["redis"]
  const store = createKillSwitchStore({ redis, rk })
  const enabledBy = operatorIdentity()
  const md = await store.enable({
    enabledBy,
    reason: opts.reason,
  })
  await emitSentryBreadcrumb({
    action: "enable",
    reason: opts.reason,
    metadata: {
      enabledBy,
      // W7-O3 — explicit posture tag so incident review can correlate
      // CLI-engaged switches with the bypass policy.
      bypass: "two_person_rule",
      surface: "cli",
      bypassMode: opts.yesIAmSoloOnCall ? "flag" : "tty_prompt",
    },
  })
  console.log()
  console.log(chalk.red.bold("ibx kernel kill-switch enable"))
  console.log(
    chalk.dim(
      "Sinal global enviado — todas as réplicas refusam mutações.",
    ),
  )
  console.log()
  console.log(`  ${chalk.bold("motivo")}    : ${md.reason}`)
  console.log(`  ${chalk.bold("operador")}  : ${md.enabledBy}`)
  console.log(`  ${chalk.bold("desde")}     : ${md.enabledAt}`)
  console.log(`  ${chalk.bold("TTL")}        : 24h (auto-disengage)`)
  console.log(`  ${chalk.bold("bypass")}     : two_person_rule (surface=cli)`)
  console.log()
  console.log(
    chalk.dim(
      "Para liberar:  ibx kernel kill-switch disable --reason \"<motivo>\"",
    ),
  )
  console.log()
}

async function runKillSwitchDisable(opts: { reason: string }): Promise<void> {
  const { getRedis, rk } = await loadKillSwitchDeps()
  const { createKillSwitchStore } = await import("@ibatexas/tools")
  const redis = (await getRedis()) as Parameters<
    typeof createKillSwitchStore
  >[0]["redis"]
  const store = createKillSwitchStore({ redis, rk })
  const enabledBy = operatorIdentity()
  const prior = await store.disable({
    enabledBy,
    reason: opts.reason,
  })
  await emitSentryBreadcrumb({
    action: "disable",
    reason: opts.reason,
    metadata: { enabledBy, priorEnabledBy: prior?.enabledBy ?? null },
  })
  console.log()
  console.log(chalk.green.bold("ibx kernel kill-switch disable"))
  if (prior) {
    console.log(
      chalk.dim(
        "Kill switch liberado — propagando para todas as réplicas.",
      ),
    )
    console.log()
    console.log(`  ${chalk.bold("motivo (release)")} : ${opts.reason}`)
    console.log(`  ${chalk.bold("operador")}         : ${enabledBy}`)
    console.log(
      `  ${chalk.bold("estava ativo por")} : ${prior.enabledBy} (${prior.reason})`,
    )
  } else {
    console.log(chalk.dim("Nenhum kill switch ativo — comando idempotente."))
  }
  console.log()
}

async function runKillSwitchStatus(opts: { json?: boolean }): Promise<void> {
  const { getRedis, rk } = await loadKillSwitchDeps()
  const { createKillSwitchStore } = await import("@ibatexas/tools")
  const redis = (await getRedis()) as Parameters<
    typeof createKillSwitchStore
  >[0]["redis"]
  const store = createKillSwitchStore({ redis, rk })
  const md = await store.status()

  if (opts.json) {
    if (md === null) {
      console.log(JSON.stringify({ active: false }, null, 2))
    } else {
      console.log(
        JSON.stringify(
          {
            active: true,
            enabledBy: md.enabledBy,
            enabledAt: md.enabledAt,
            reason: md.reason,
          },
          null,
          2,
        ),
      )
    }
    return
  }

  console.log()
  console.log(chalk.bold("ibx kernel kill-switch status"))
  console.log(chalk.dim("Estado distribuído do kill switch global (Redis)."))
  console.log()
  if (md === null) {
    console.log(`  ${chalk.dim("inativo")}`)
    console.log()
    console.log(
      chalk.dim(
        "Para engajar:  ibx kernel kill-switch enable --reason \"<motivo>\"",
      ),
    )
  } else {
    console.log(`  ${chalk.red.bold("ATIVO")}`)
    console.log(`  ${chalk.bold("motivo")}    : ${md.reason}`)
    console.log(`  ${chalk.bold("operador")}  : ${md.enabledBy}`)
    console.log(`  ${chalk.bold("desde")}     : ${md.enabledAt}`)
    console.log()
    console.log(
      chalk.dim(
        "Para liberar:  ibx kernel kill-switch disable --reason \"<motivo>\"",
      ),
    )
  }
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
    .option(
      "--intent-kind <kind>",
      "Filtra por intent kind (ex: order.checkout.create) — W3 D4 fix",
    )
    .action(async (opts: { since?: string; intentKind?: string }) => {
      await runDivergence(opts)
    })

  // ── kill-switch ──────────────────────────────────────────────────────────
  // W3 D1: real implementation of the runbook-documented surface. The
  // three subcommands write to / read from a Redis flag with 24h TTL +
  // publish pub/sub events for cross-replica propagation.
  const killSwitch = group
    .command("kill-switch")
    .description(
      "Engaja/libera o kill switch global do kernel (Redis-backed, propagação por pub/sub)",
    )

  killSwitch
    .command("enable")
    .description(
      "Engaja o kill switch global (EMERGÊNCIA DE PLANTÃO SOLO — bypassa a regra de dois operadores; use POST /api/admin/kernel/kill-switch para fluxo agendado)",
    )
    .requiredOption(
      "--reason <text>",
      "Motivo humano-legível (obrigatório — auditado e enviado para Sentry)",
    )
    // W7-O3 — opt-in escape hatch for CI / pager scripts. Without this
    // flag AND without a TTY, the command refuses (see
    // confirmSoloOperatorBypass).
    .option(
      "--yes-i-am-solo-on-call",
      "Confirma o bypass da regra de dois operadores sem prompt (uso em scripts de plantão)",
      false,
    )
    .action(
      async (opts: { reason: string; yesIAmSoloOnCall?: boolean }) => {
        try {
          await runKillSwitchEnable(opts)
        } finally {
          // Close Redis so the CLI process exits cleanly. The test
          // harness (vi.mock @ibatexas/tools) returns a closeRedisClient
          // stub which is a no-op in unit tests.
          await closeRedisQuietly()
        }
      },
    )

  killSwitch
    .command("disable")
    .description(
      "Libera o kill switch global — propagação automática para todas as réplicas",
    )
    .requiredOption(
      "--reason <text>",
      "Motivo humano-legível (obrigatório — auditado)",
    )
    .action(async (opts: { reason: string }) => {
      try {
        await runKillSwitchDisable(opts)
      } finally {
        await closeRedisQuietly()
      }
    })

  killSwitch
    .command("status")
    .description("Mostra o estado do kill switch (ATIVO / inativo)")
    .option("--json", "Emite saída JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        await runKillSwitchStatus(opts)
      } finally {
        await closeRedisQuietly()
      }
    })
}
