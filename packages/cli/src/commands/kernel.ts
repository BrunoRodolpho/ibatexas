// `ibx kernel` — operator surface for the adjudicate kernel.
//
// Subcommands:
//
//   - `ibx kernel status`     — print the kernel's runtime state: installed
//                               packs, known intent kinds, audit sink
//                               topology, ledger health.
//
//   - `ibx kernel replay`     — re-feed audit records from Postgres through
//                               adjudicate() and report drift. Requires a
//                               valid `DATABASE_URL`. Use after upgrading
//                               a Pack to detect policy drift on real
//                               historical traffic.
//
//   - `ibx kernel migrate`    — apply the @adjudicate/audit-postgres SQL
//                               migrations against `$DATABASE_URL`.
//                               Idempotent. Called by `ibx bootstrap` on
//                               first-time setup.
//
//   - `ibx kernel defer resume` — operator recovery for stuck-deferred
//                               sessions. Reads `defer:pending:{sessionId}`
//                               from Redis, verifies the parked-envelope
//                               hash via `verifyParkedEnvelopeHash`
//                               (framework primitive — fail-closed on
//                               tamper), and publishes a synthesised
//                               `payment.status_changed` NATS event so the
//                               live `defer-resolver` subscriber resumes
//                               the parked envelope.
//
// All user-facing strings are pt-BR per CLAUDE.md rule #4.

import { readFile, readdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { parseBoolEnv } from "@ibatexas/types"

// ── Helpers ───────────────────────────────────────────────────────────────

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
  // IBX-IGE v3.0 cutover (commit f3bea43): the kernel is always
  // authoritative. The legacy `IBX_KERNEL_SHADOW` / `IBX_KERNEL_ENFORCE`
  // env-var surface and the `getKillSwitchState()` operator handle were
  // removed — there is no shadow / enforce / kill-switch state to query.
  // NEW-P1-ENV: parseBoolEnv accepts the canonical truthy lexicon
  // (true/1/yes/on, any case) and defaults to false for unset/typo
  // inputs. The CLI agrees with the runtime sites that read these same
  // env vars (kernel-bootstrap, intent-audit-wiring, intent-ledger).
  const ledgerEnabled = parseBoolEnv(process.env.IBX_LEDGER_ENABLED, false)
  const ledgerEnforce = parseBoolEnv(process.env.IBX_LEDGER_ENFORCE, false)
  const ledgerFailOpen = parseBoolEnv(process.env.IBX_LEDGER_FAIL_OPEN, false)
  // audit-2026-05-25 (I13): the IBX_AUDIT_POSTGRES_ENABLED env var was
  // deleted in the H2 cutover (audit-postgres is unconditionally part
  // of the sink fan-out per CLAUDE.md rule #9). The CLI's pre-cutover
  // gating logic stayed in place and produced a no-op `ibx kernel
  // replay` + a misleading "TODO: enable IBX_AUDIT_POSTGRES_ENABLED"
  // message on healthy deployments. Removed.
  const postgresEnabled = true

  // Pull KNOWN_INTENT_KINDS lazily. The dependency is the tiny leaf
  // `@ibatexas/intent-kinds` package (type-only Pack imports + literal
  // arrays), so this no longer drags policy bundles into the CLI process.
  const { KNOWN_INTENT_KINDS } = await import("@ibatexas/intent-kinds")

  if (opts.json) {
    const out = {
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
    }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  console.log()
  console.log(chalk.bold("ibx kernel status"))
  console.log(chalk.dim("Estado de execução do kernel adjudicate."))
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
  // audit-2026-05-25 (I13): the IBX_AUDIT_POSTGRES_ENABLED env var was
  // deleted in the H2 cutover (audit-postgres is unconditionally part
  // of the sink fan-out per CLAUDE.md rule #9). The CLI's pre-cutover
  // gating logic stayed in place and produced a no-op `ibx kernel
  // replay` + a misleading "TODO: enable IBX_AUDIT_POSTGRES_ENABLED"
  // message on healthy deployments. Removed.
  const postgresEnabled = true

  console.log()
  console.log(chalk.bold("ibx kernel replay"))
  console.log(chalk.dim(`Janela: últimos ${sinceInput}; limite: ${limit}; kind: ${opts.intentKind ?? "todos"}`))
  console.log()

  if (!postgresEnabled) {
    // STUB: audit-postgres is off in this deployment (task 19 default).
    // Operators flip the flag after the staging soak; until then, we
    // surface a structured TODO so the runbook step is honest.
    //
    // W7-O2 fix — replace the phantom `pnpm migrate` step with the
    // actual operator command. @adjudicate/audit-postgres ships its
    // schema as raw SQL files; there is no migration runner script.
    // The earlier message ("Rodar pnpm migrate em @adjudicate/audit-
    // postgres") sent operators to a non-existent script.
    console.log(chalk.yellow("⚠  IBX_AUDIT_POSTGRES_ENABLED=false — replay não pode ser executado."))
    console.log()
    console.log(chalk.bold("TODO para o operador (quando audit-postgres for habilitado):"))
    console.log()
    console.log("  1. Habilitar IBX_AUDIT_POSTGRES_ENABLED=true no .env de produção.")
    console.log("  2. Aplicar as migrações de @adjudicate/audit-postgres (SQL puro — não há")
    console.log("     script `migrate`). Em ordem numérica, contra o $DATABASE_URL:")
    console.log()
    console.log(chalk.dim("       PKG_DIR=$(node -p \"require.resolve('@adjudicate/audit-postgres/package.json').replace('/package.json','')\")"))
    console.log(chalk.dim("       for f in \"$PKG_DIR\"/migrations/*.sql; do"))
    console.log(chalk.dim("         echo \"-- aplicando $f\" && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f \"$f\""))
    console.log(chalk.dim("       done"))
    console.log()
    console.log("     Pré-requisitos: psql instalado, $DATABASE_URL apontando para o cluster")
    console.log("     destino, pnpm install já executado (instala @adjudicate/audit-postgres do")
    console.log("     registry npm).")
    console.log("  3. Rodar `ibx kernel replay --since=24h` novamente.")
    console.log()
    console.log(chalk.dim("Migrações: node_modules/.pnpm/@adjudicate+audit-postgres@*/node_modules/@adjudicate/audit-postgres/migrations/{001..008}-*.sql"))
    console.log(chalk.dim("Doc: docs/adjudicate-migration/tasks/19-audit-postgres-pgnats-bridge.md"))
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

// ── ibx kernel migrate ────────────────────────────────────────────────────

/**
 * Resolve the `migrations/` directory inside the installed
 * `@adjudicate/audit-postgres` package via Node's module resolver. The
 * package doesn't export `./migrations` via `package.json#exports`, so we
 * resolve the package's main entry and walk up two levels (`dist/index.js`
 * → package root) before joining `migrations`.
 */
async function resolveAuditPostgresMigrationsDir(): Promise<string> {
  // `import.meta.resolve` was promoted to sync in newer Node but is still
  // typed as returning `string` in @types/node. Use as a string + URL.
  const indexUrl = await import.meta.resolve("@adjudicate/audit-postgres")
  const indexPath = fileURLToPath(indexUrl)
  return join(dirname(dirname(indexPath)), "migrations")
}

/**
 * Apply all `@adjudicate/audit-postgres` SQL migrations against
 * `$DATABASE_URL`. Idempotent — re-running is safe; the SQL files use
 * `IF NOT EXISTS` / `IF NOT EXISTS COLUMN` patterns, and we additionally
 * swallow "already exists" / "duplicate" errors per migration so an old
 * run that partially completed doesn't block recovery.
 *
 * Exported so `ibx bootstrap` can call it as part of first-time setup
 * (after Prisma migrations + seeds).
 */
export async function applyAuditPostgresMigrations(
  databaseUrl: string,
  log: { info: (msg: string) => void; warn: (msg: string) => void } = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
  },
): Promise<void> {
  const migrationsDir = await resolveAuditPostgresMigrationsDir()
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort()
  if (files.length === 0) {
    log.warn(`Nenhum .sql encontrado em ${migrationsDir}`)
    return
  }
  const { default: pg } = await import("pg")
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), "utf8")
      try {
        await client.query(sql)
        log.info(`  ✓ ${file}`)
      } catch (err) {
        const msg = (err as Error).message
        if (/already exists|duplicate/i.test(msg)) {
          log.info(`  ↺ ${file} — já aplicado`)
        } else {
          throw new Error(`migration ${file} failed: ${msg}`)
        }
      }
    }
  } finally {
    await client.end()
  }
}

async function runMigrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(chalk.red("DATABASE_URL não definido. Defina antes de rodar migrações."))
    process.exitCode = 1
    return
  }
  const migrationsDir = await resolveAuditPostgresMigrationsDir()
  console.log(chalk.bold("ibx kernel migrate"))
  console.log(chalk.dim(`Origem: ${migrationsDir}`))
  console.log(chalk.dim(`Destino: $DATABASE_URL`))
  console.log()
  const spinner = ora("Aplicando migrações…").start()
  try {
    await applyAuditPostgresMigrations(databaseUrl, {
      info: (msg) => spinner.info(msg),
      warn: (msg) => spinner.warn(msg),
    })
    spinner.succeed(chalk.green("Migrações concluídas."))
  } catch (err) {
    spinner.fail(chalk.red((err as Error).message))
    process.exitCode = 1
  }
}

// ── Shared CLI helpers (used by migrate + defer resume) ──────────────────

/** Best-effort operator identity from environment for audit-trail markers. */
function operatorIdentity(): string {
  return (
    process.env.IBX_OPERATOR_ID ??
    process.env.USER ??
    process.env.USERNAME ??
    "unknown"
  )
}

/** Close Redis cleanly so the CLI process exits without hanging connections. */
async function closeRedisQuietly(): Promise<void> {
  try {
    const { closeRedisClient } = await import("@ibatexas/tools")
    await closeRedisClient()
  } catch {
    // Connections might not exist (dry-run paths) — swallow.
  }
}

// ── ibx kernel defer resume <sessionId> (W7-O1) ───────────────────────────
//
// W6 operational drill verdict FAIL: "no CLI; only manual Redis SCAN + NATS
// publish". This subcommand closes that Tier-1 readiness gap by giving the
// operator a one-shot recovery path:
//
//   $ ibx kernel defer resume cust:cust_abc123
//
// Flow:
//   1. Read `defer:pending:{sessionId}` from Redis (the parked envelope blob
//      written by the responder at DEFER time; key is namespaced via rk()).
//   2. Parse + verify the parked-envelope hash via the framework's
//      `verifyParkedEnvelopeHash` (T-005 tamper detection). On `verified:
//      false` we DLQ-style refuse — never kick a tampered envelope back into
//      the resume pipeline.
//   3. Synthesise a `PaymentStatusChangedEvent` carrying the parked
//      envelope's `paymentId` / `orderId` (extracted from the payload's PIX
//      details), and publish it on `ibatexas.payment.status_changed`.
//   4. The live `defer-resolver` subscriber (apps/api/src/subscribers/
//      defer-resolver.ts) consumes the event, sweeps `defer:pending:*` for
//      matching signals, and runs the existing two-phase commit + cycle
//      cap + dispatch path. Other parked sessions with non-matching signals
//      no-op.
//
// Why publish a NATS event rather than calling resolveDeferredSession()
// directly:
//   - The CLI package does not depend on `@ibatexas/api`; importing the
//     resolver from apps would re-introduce a topology cycle.
//   - The live subscriber is the canonical entry point and already exercises
//     the full retry / DLQ / audit path. The CLI being a "kick the resolver"
//     surface keeps the recovery code in one place.
//   - Tests can substitute a fake nats-client (or a real testcontainer-NATS)
//     to assert the published event shape without duplicating the resolver.
//
// Operator output:
//   - On success: "Sinal de retomada publicado para a sessão <id>" + the
//     synthesised event so the operator can correlate with downstream logs.
//   - Tampered: "Parked envelope adulterado — recusando retomada" (with
//     stored vs derived hash so triage is one log line).
//   - Not found: "Nenhuma sessão parkada com este ID" (operator typo).

interface DeferResumeDeps {
  readonly getRedis: () => Promise<{
    get(key: string): Promise<string | null>
  }>
  readonly rk: (key: string) => string
}

async function loadDeferResumeDeps(): Promise<DeferResumeDeps> {
  const tools = await import("@ibatexas/tools")
  return {
    getRedis: () => tools.getRedisClient(),
    rk: tools.rk,
  }
}

interface ParkedEnvelopeShape {
  readonly envelope: {
    readonly intentHash: string
    readonly kind: string
    readonly actor: { readonly sessionId: string }
    readonly payload: unknown
    readonly version?: number
    readonly nonce?: string
    readonly taint?: string
    readonly actorPrincipal?: string
  }
  readonly signal: string
  readonly parkedAt: string
}

function extractPaymentDetailsFromParked(parked: ParkedEnvelopeShape): {
  paymentId: string
  orderId: string
} {
  // PIX-deferred envelopes (the only kind the responder parks today —
  // `order.tool.propose` with a `set_pix_details` payload) carry the
  // paymentId + orderId in the payload's `input`. We do a structural
  // walk because the payload is `unknown`.
  const p = parked.envelope.payload as
    | {
        input?: {
          paymentId?: string
          orderId?: string
          pixPaymentId?: string
        }
      }
    | undefined
  const paymentId =
    (typeof p?.input?.paymentId === "string" && p.input.paymentId) ||
    (typeof p?.input?.pixPaymentId === "string" && p.input.pixPaymentId) ||
    `cli-resume-${parked.envelope.actor.sessionId}-${Date.now()}`
  const orderId =
    (typeof p?.input?.orderId === "string" && p.input.orderId) ||
    `cli-resume-${parked.envelope.actor.sessionId}`
  return { paymentId, orderId }
}

async function runDeferResume(
  sessionId: string,
  opts: { signal?: string; jsonOnly?: boolean },
): Promise<void> {
  const targetSessionId = sessionId.trim()
  if (targetSessionId.length === 0) {
    console.error(chalk.red("sessionId obrigatório."))
    process.exitCode = 1
    return
  }

  const { getRedis, rk } = await loadDeferResumeDeps()
  const parkKey = rk(`defer:pending:${targetSessionId}`)
  const redis = await getRedis()
  const raw = await redis.get(parkKey).catch((err: unknown) => {
    console.error(
      chalk.red(
        `Falha ao ler ${parkKey}: ${(err as Error).message}`,
      ),
    )
    return null
  })
  if (raw === null) {
    console.error(
      chalk.yellow(
        `Nenhum envelope parkado encontrado para ${targetSessionId} (chave: ${parkKey}).`,
      ),
    )
    process.exitCode = 1
    return
  }

  let parked: ParkedEnvelopeShape
  try {
    parked = JSON.parse(raw) as ParkedEnvelopeShape
  } catch (err) {
    console.error(
      chalk.red(
        `Envelope malformado (JSON.parse falhou) em ${parkKey}: ${
          (err as Error).message
        }`,
      ),
    )
    process.exitCode = 1
    return
  }

  // Lazy-import the framework primitive so the CLI cold-start is cheap.
  const { verifyParkedEnvelopeHash } = (await import(
    "@adjudicate/runtime",
  )) as unknown as {
    verifyParkedEnvelopeHash(parked: ParkedEnvelopeShape): {
      verified: boolean | null
      reason?: string
      stored?: string
      derived?: string
    }
  }
  const verification = verifyParkedEnvelopeHash(parked)
  if (verification.verified === false) {
    console.error(chalk.red.bold("Parked envelope adulterado — recusando retomada."))
    console.error(
      chalk.dim(
        `stored=${verification.stored} derived=${verification.derived}`,
      ),
    )
    process.exitCode = 1
    return
  }
  // verified === null means a legacy v0.1 blob without hash-verification
  // fields. We warn but proceed — the runbook expects backward-compat for
  // sessions parked before the framework added hash fields.
  const verifyMode: "verified" | "legacy-no-hash" =
    verification.verified === true ? "verified" : "legacy-no-hash"

  // Build the synthesised wire event. The defer-resolver filters by
  // `SETTLED_WIRE_STATUSES = {"paid", "captured", "confirmed"}` so we use
  // "paid" — the same status the Stripe webhook emits on PIX confirmation.
  const { paymentId, orderId } =
    extractPaymentDetailsFromParked(parked)
  const event = {
    orderId,
    paymentId,
    previousStatus: "requires_payment_method",
    newStatus: "paid",
    method: "pix",
    version: 1,
    timestamp: new Date().toISOString(),
    // Marker for downstream logs so an audit reviewer can distinguish
    // operator-kicked resumes from real Stripe webhooks.
    cliInjectedBy: operatorIdentity(),
  }

  if (opts.jsonOnly === true) {
    // Dry-run for tests and audit transcripts — emit JSON describing what
    // WOULD be published, without touching NATS.
    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionId: targetSessionId,
          parkKey,
          verifyMode,
          parkedSignal: parked.signal,
          intentHash: parked.envelope.intentHash,
          intentKind: parked.envelope.kind,
          publishSubject: "ibatexas.payment.status_changed",
          synthEvent: event,
        },
        null,
        2,
      ),
    )
    return
  }

  // Publish the wire event. The live subscriber sweeps `defer:pending:*`
  // and resumes the matching session via the standard two-phase commit
  // pipeline. Other parked sessions with mismatched signals no-op.
  const { publishNatsEvent, closeNatsConnection } = await import(
    "@ibatexas/nats-client",
  )
  try {
    await publishNatsEvent("payment.status_changed", event)
  } finally {
    await closeNatsConnection().catch(() => {})
  }

  console.log()
  console.log(chalk.bold("ibx kernel defer resume"))
  console.log(
    chalk.dim(
      "Sinal de retomada publicado — o defer-resolver vai re-adjudicar a sessão.",
    ),
  )
  console.log()
  console.log(`  ${chalk.bold("sessionId")}    : ${targetSessionId}`)
  console.log(`  ${chalk.bold("parkKey")}      : ${parkKey}`)
  console.log(`  ${chalk.bold("verifyMode")}   : ${verifyMode}`)
  console.log(`  ${chalk.bold("parkedSignal")} : ${parked.signal}`)
  console.log(`  ${chalk.bold("intentHash")}   : ${parked.envelope.intentHash.slice(0, 12)}…`)
  console.log(`  ${chalk.bold("intentKind")}   : ${parked.envelope.kind}`)
  console.log(
    `  ${chalk.bold("subject")}      : ibatexas.payment.status_changed`,
  )
  console.log(`  ${chalk.bold("paymentId")}    : ${event.paymentId}`)
  console.log(`  ${chalk.bold("orderId")}      : ${event.orderId}`)
  console.log(`  ${chalk.bold("operator")}     : ${event.cliInjectedBy}`)
  console.log()
  console.log(
    chalk.dim(
      "Acompanhe o resumo no log da API: '[defer-resolver] re-adjudicated resumed intent'.",
    ),
  )
  console.log()
}

// ── Registration ──────────────────────────────────────────────────────────

export function registerKernelCommands(group: Command): void {
  group.description("Kernel — estado, replay e migrações do adjudicate kernel")

  group
    .command("status")
    .description("Mostra o estado do kernel: packs, intent kinds, ledger, audit sinks")
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
    .command("migrate")
    .description(
      "Aplica as migrações SQL de @adjudicate/audit-postgres contra $DATABASE_URL (idempotente)",
    )
    .action(async () => {
      try {
        await runMigrate()
      } finally {
        await closeRedisQuietly()
      }
    })

  // ── defer ────────────────────────────────────────────────────────────────
  // W7-O1 — operator recovery for stuck-deferred sessions. The sweep-side
  // resolver in apps/api handles real wire events; this CLI surface lets a
  // 3am responder kick the resolver for ONE session via a synthesised
  // `payment.status_changed` NATS event, without manually constructing the
  // event in psql + nats-cli.
  const defer = group
    .command("defer")
    .description(
      "Operações sobre envelopes em DEFER (parking + retomada manual)",
    )

  defer
    .command("resume <sessionId>")
    .description(
      "Retomada manual de uma sessão parkada — verifica o envelope e publica payment.status_changed",
    )
    .option(
      "--signal <signal>",
      "Filtra a retomada pelo signal parkado (default: pix.confirmed; o resolver casa por signal)",
      "pix.confirmed",
    )
    .option(
      "--json",
      "Não publica NATS — imprime o evento sintetizado em JSON (dry-run para testes / auditoria)",
      false,
    )
    .action(
      async (
        sessionId: string,
        opts: { signal?: string; json?: boolean },
      ) => {
        try {
          await runDeferResume(sessionId, {
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
            jsonOnly: opts.json === true,
          })
        } finally {
          await closeRedisQuietly()
        }
      },
    )
}
