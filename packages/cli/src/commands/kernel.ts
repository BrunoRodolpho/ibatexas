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
//                               historical traffic. T1b-3 made it a CI gate:
//                               exit 0 clean / 1 errors / 2 drift; `--json`
//                               structured output; `--ci` hard-fails on a
//                               disabled audit-postgres flag or an empty
//                               window (vacuous-gate protection); rows in
//                               the agent session namespace (`agent:`) are
//                               excluded from the scan set; `--seed-file`
//                               seeds the committed golden vectors so an
//                               ephemeral CI database has a real window;
//                               `--update-golden` re-materializes the
//                               golden decisions after an intended policy
//                               change.
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

import { readFile, readdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import { parseBoolEnv } from "@ibatexas/types"
// @ibatexas/tools is imported STATICALLY (not via a lazy `import()`) so that
// vitest's `vi.mock("@ibatexas/tools")` reliably intercepts getRedisClient in
// the defer-resume tests. A dynamic import is racy to mock on the CI runner
// and let those hermetic tests reach a real Redis client (REDIS_URL is set on
// the runner → `client.connect()` hangs → 5s test timeout). The cold-start
// cost is one extra module load for `ibx kernel`, which is acceptable.
import {
  closeRedisClient,
  getRedisClient,
  rk as toolsRk,
} from "@ibatexas/tools"

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

// The canonical Pack roster the CLI loads — `[npm spec, named export]` pairs.
// SINGLE source of truth shared by `loadPackIndex` (the kind→Pack map behind
// `replay`/`status`), `loadPacksForGovernance` (raw Packs for BOM/analyze), and
// the `status` pack count. These three once enumerated the roster independently
// and drifted: the PIX pack was indexed under a stale export name
// (`pixChargeLifecyclePack`) in `loadPackIndex` only, so `safeImport` silently
// dropped it and `pix.charge.*` audit records fell into the replay coverage-gap
// bucket. Keep this list in lockstep with `installFirstPartyPacks()` in
// apps/api/src/plugins/kernel-bootstrap.ts.
const FIRST_PARTY_PACK_SPECS = [
  ["@ibatexas/pack-orders", "ordersPack"],
  ["@ibatexas/pack-reservations", "reservationsPack"],
  ["@ibatexas/pack-whatsapp", "whatsappPack"],
  ["@ibatexas/pack-customer-onboarding", "customerOnboardingPack"],
  ["@ibatexas/pack-payments", "paymentsPack"],
  ["@adjudicate/pack-payments-pix", "paymentsPixPack"],
] as const

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
        kinds: [...KNOWN_INTENT_KINDS].sort((a, b) => a.localeCompare(b)),
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
  console.log(
    `  ${chalk.cyan(String(KNOWN_INTENT_KINDS.size))} kinds em ${chalk.cyan(String(FIRST_PARTY_PACK_SPECS.length))} packs`,
  )
  // Group by domain for readability.
  const groups: Record<string, string[]> = {}
  for (const k of [...KNOWN_INTENT_KINDS].sort((a, b) => a.localeCompare(b))) {
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

// T1b-3 — agent-namespace exclusion (forward-protection for Stage-0 shadow
// rows, plan-v2 §5 / T3-6). Audit rows written by managed agents carry a
// session_id with this UNHASHED prefix; every time-windowed production-signal
// consumer (this replay gate, T2-4's impact graph, the drift baseline)
// excludes them so shadow-agent traffic can never certify — or contaminate —
// a production policy gate. D-012 corollary: chat-act rows land with a HASHED
// session id (`"hashed:" + sha256(conversationId + secret).hex.slice(0, 8)`,
// written by the audit redactor), so they can never collide with this prefix.
// It ALSO means the Phase-3 agent composition MUST write agent session ids
// UNHASHED (redactor skip for the agent principal) or this exclusion is
// silently defeated. Pinned here as the cross-task convention.
export const AGENT_SESSION_ID_PREFIX = "agent:"

// Documented limitations of the replay gate — printed in both text and JSON
// output so an operator (or a CI log reader) never mistakes a green replay
// for a stronger statement than it makes. pt-BR per CLAUDE.md rule #4.
const REPLAY_LIMITATIONS: readonly string[] = [
  "Re-adjudicação contra estado VAZIO (sem rehidratação point-in-time) — guards que leem estado podem divergir legitimamente; interprete o resumo contra os thresholds do runbook.",
  "Janela vazia não certifica política nenhuma (gate vácuo): em modo --ci, 0 registros é falha dura (exit 1). Semeie golden vectors com --seed-file.",
  `Registros com session_id no namespace de agente ("${AGENT_SESSION_ID_PREFIX}") são excluídos do scan — shadow rows de agente (Stage 0) nunca certificam política de produção.`,
]

/**
 * Exit-code contract of the replay gate (T1b-3):
 *   0 — every scanned record reproduced its historical decision (clean)
 *   1 — the run itself is unreliable (record errors / pack coverage gaps /
 *       connection failures / --ci vacuous-gate refusals)
 *   2 — the run was sound and policy drift was detected
 * Errors take precedence over drift: a partially-errored scan cannot be
 * trusted to have found *all* the drift, so it must not exit 2.
 */
function replayExitCode(report: ReplayReport): 0 | 1 | 2 {
  if (report.errors > 0) return 1
  const drifted =
    report.driftedByDecisionKind + report.driftedByBasis + report.driftedByPayload
  return drifted > 0 ? 2 : 0
}

// node-postgres hands back JSONB columns as already-parsed objects and
// TIMESTAMPTZ as `Date`; the package's `rowToRecord` expects the WRITER shape
// (pre-serialized JSON text + ISO string) and does `JSON.parse(...)` on the
// jsonb fields — raw pg rows crash it on a live database. Mirror of the
// canonical normalization in apps/api/src/claustrum/audit-read-paths.ts
// (P0-2). The mocked-pg tests feed writer-shaped rows, which pass through
// unchanged (strings stay strings).
function pgJsonText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return typeof v === "string" ? v : JSON.stringify(v)
}

function pgIsoTimestamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  const parsed = new Date(String(v))
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`intent_audit.recorded_at não é um timestamp válido: ${String(v)}`)
  }
  return parsed.toISOString()
}

function normalizeAuditRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    recorded_at: pgIsoTimestamp(row.recorded_at),
    envelope_jsonb: pgJsonText(row.envelope_jsonb) ?? "null",
    decision_jsonb: pgJsonText(row.decision_jsonb) ?? "null",
    plan_jsonb: pgJsonText(row.plan_jsonb),
    supersedes_jsonb: pgJsonText(row.supersedes_jsonb),
    kernel_identity_jsonb: pgJsonText(row.kernel_identity_jsonb),
    signature_jsonb: pgJsonText(row.signature_jsonb),
    metadata_jsonb: pgJsonText(row.metadata_jsonb),
  }
}

/** Single JSON document on stdout — the `--json` idiom (mirrors pack-bom). */
function printReplayJson(out: Record<string, unknown>): void {
  console.log(
    JSON.stringify(
      {
        command: "kernel.replay",
        agentSessionPrefix: AGENT_SESSION_ID_PREFIX,
        limitations: REPLAY_LIMITATIONS,
        ...out,
      },
      null,
      2,
    ),
  )
}

async function runReplay(opts: {
  since?: string
  intentKind?: string
  limit?: string
  dryRun?: boolean
  json?: boolean
  ci?: boolean
  seedFile?: string
}): Promise<void> {
  const ci = opts.ci === true
  const json = opts.json === true
  const sinceInput = opts.since ?? "24h"
  let sinceMs: number
  try {
    sinceMs = parseDuration(sinceInput)
  } catch (err) {
    if (json) {
      printReplayJson({
        status: "invalid-args",
        ci,
        error: (err as Error).message,
        exitCode: 1,
      })
    } else {
      console.error(chalk.red((err as Error).message))
    }
    process.exitCode = 1
    return
  }
  const limit = Number.parseInt(opts.limit ?? "1000", 10)
  // `ibx kernel replay` re-feeds audit records FROM Postgres, so — unlike
  // runStatus() above, which merely describes the always-on sink config —
  // it requires a live audit-postgres connection. Gate on
  // IBX_AUDIT_POSTGRES_ENABLED: when it is not explicitly enabled we print
  // an honest operator TODO (the stub below) instead of attempting a
  // connection that cannot succeed. Operators flip the flag per the stub's
  // own instructions; healthy deployments that set it never see the stub.
  const postgresEnabled = parseBoolEnv(
    process.env.IBX_AUDIT_POSTGRES_ENABLED,
    false,
  )

  if (!json) {
    console.log()
    console.log(chalk.bold("ibx kernel replay"))
    console.log(
      chalk.dim(
        `Janela: últimos ${sinceInput}; limite: ${limit}; kind: ${opts.intentKind ?? "todos"}${ci ? "; modo: --ci (fail-closed)" : ""}`,
      ),
    )
    console.log()
  }

  if (!postgresEnabled) {
    // T1b-3 (plan risk #7): in --ci mode a disabled audit-postgres flag is a
    // HARD failure, never a silent green. A replay that cannot read the audit
    // store certifies nothing — exiting 0 here would be a vacuous gate.
    if (ci) {
      if (json) {
        printReplayJson({
          status: "audit-postgres-disabled",
          ci,
          exitCode: 1,
          error:
            "IBX_AUDIT_POSTGRES_ENABLED não habilitado — em modo --ci isso é falha dura (gate vácuo recusado).",
        })
      } else {
        console.error(
          chalk.red.bold(
            "✗ IBX_AUDIT_POSTGRES_ENABLED não habilitado — em modo --ci isso é falha dura (exit 1).",
          ),
        )
        console.error(
          chalk.dim(
            "  Um replay que não consegue ler o audit-postgres não certifica política nenhuma (gate vácuo).",
          ),
        )
      }
      process.exitCode = 1
      return
    }
    if (json) {
      printReplayJson({
        status: "audit-postgres-disabled",
        ci,
        exitCode: 0,
        note: "Replay não executado — habilite IBX_AUDIT_POSTGRES_ENABLED (modo operador; use --ci para falhar duro).",
      })
      return
    }
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
    if (json) {
      printReplayJson({
        status: "failed",
        ci,
        exitCode: 1,
        error: "DATABASE_URL não definido. Replay requer conexão Postgres válida.",
      })
    } else {
      console.error(chalk.red("DATABASE_URL não definido. Replay requer conexão Postgres válida."))
    }
    process.exitCode = 1
    return
  }

  // ora writes to stderr, but in --json mode we keep stdout/stderr both
  // machine-friendly: no spinner at all.
  const spinner = json ? null : ora(`Lendo audit window dos últimos ${sinceInput}…`).start()
  try {
    // Lazy imports — audit-postgres + audit drag heavy deps.
    const { readAuditWindow } = await import("@adjudicate/audit-postgres")
    const { default: pg } = await import("pg" as string).catch(() => {
      throw new Error("módulo pg não encontrado — instale com `pnpm install`")
    })

    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      // CI-gate seeding (T1b-3): insert the committed golden vectors with
      // recorded_at = now, BEFORE computing the window, so an ephemeral CI
      // database has a real, non-vacuous window to replay.
      let seededVectors: number | null = null
      if (opts.seedFile !== undefined) {
        seededVectors = await seedGoldenVectors(client, opts.seedFile)
        if (spinner) {
          spinner.text = `Semeados ${seededVectors} golden vectors; lendo audit window…`
        }
      }

      const toIso = new Date().toISOString()
      const fromIso = new Date(Date.now() - sinceMs).toISOString()

      // Agent-namespace exclusion happens in BOTH layers:
      //   1. SQL (`NOT LIKE 'agent:%'`) — so agent rows never crowd real rows
      //      out of the LIMIT on a live database;
      //   2. JS post-filter — counts exclusions for the report and protects
      //      paths where the SQL predicate is absent (defense in depth).
      let excludedAgentRows = 0
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
          params.push(`${AGENT_SESSION_ID_PREFIX}%`)
          sql += ` AND session_id NOT LIKE $${params.length}`
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
            .filter((row) => {
              const sid = row.session_id
              if (typeof sid === "string" && sid.startsWith(AGENT_SESSION_ID_PREFIX)) {
                excludedAgentRows += 1
                return false
              }
              return true
            })
            .map(normalizeAuditRow)
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

      spinner?.succeed(
        `Lidos ${records.length} registros de audit` +
          (excludedAgentRows > 0
            ? ` (${excludedAgentRows} no namespace de agente excluídos)`
            : "") +
          ".",
      )

      // T1b-3 (plan risk #7): an empty window in --ci mode is a HARD failure.
      // Zero records reproduce zero decisions — a green exit here would
      // certify nothing (the vacuous-gate risk this task closes).
      if (ci && records.length === 0) {
        if (json) {
          printReplayJson({
            status: "vacuous-empty-window",
            ci,
            window: { since: sinceInput, fromIso, toIso },
            intentKind: opts.intentKind ?? null,
            limit,
            seededVectors,
            scanned: 0,
            excludedAgentRows,
            exitCode: 1,
            error:
              "Janela de replay vazia em modo --ci — 0 registros não certificam política nenhuma (gate vácuo recusado).",
          })
        } else {
          console.error(
            chalk.red.bold(
              "✗ Janela de replay vazia em modo --ci — falha dura (exit 1).",
            ),
          )
          console.error(
            chalk.dim(
              "  0 registros não certificam política nenhuma (gate vácuo). Semeie golden vectors com --seed-file.",
            ),
          )
        }
        process.exitCode = 1
        return
      }

      if (opts.dryRun) {
        if (json) {
          printReplayJson({
            status: "dry-run",
            ci,
            window: { since: sinceInput, fromIso, toIso },
            intentKind: opts.intentKind ?? null,
            limit,
            seededVectors,
            scanned: records.length,
            excludedAgentRows,
            exitCode: 0,
            records: records.slice(0, 10).map((r) => ({
              createdAt: r.envelope.createdAt,
              kind: r.envelope.kind,
              intentHash: r.intentHash,
            })),
          })
          return
        }
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
      const exitCode = replayExitCode(report)
      if (json) {
        printReplayJson({
          status: exitCode === 0 ? "clean" : exitCode === 2 ? "drift" : "errors",
          ci,
          window: { since: sinceInput, fromIso, toIso },
          intentKind: opts.intentKind ?? null,
          limit,
          seededVectors,
          scanned: records.length,
          excludedAgentRows,
          report,
          exitCode,
        })
      } else {
        printReplayReport(report)
        printReplayStatusText(exitCode, excludedAgentRows)
      }
      if (exitCode !== 0) process.exitCode = exitCode
    } finally {
      await client.end()
    }
  } catch (err) {
    spinner?.fail(chalk.red(`Falhou: ${(err as Error).message}`))
    if (json) {
      printReplayJson({
        status: "failed",
        ci,
        exitCode: 1,
        error: (err as Error).message,
      })
    }
    process.exitCode = 1
  }
}

/** Text-mode status + limitations footer for the replay gate. */
function printReplayStatusText(exitCode: 0 | 1 | 2, excludedAgentRows: number): void {
  const status =
    exitCode === 0
      ? chalk.green("limpo (exit 0)")
      : exitCode === 2
        ? chalk.yellow("drift detectado (exit 2)")
        : chalk.red("erros (exit 1)")
  console.log(`Status: ${status}`)
  if (excludedAgentRows > 0) {
    console.log(
      chalk.dim(
        `Excluídos do scan: ${excludedAgentRows} registros no namespace de agente ("${AGENT_SESSION_ID_PREFIX}").`,
      ),
    )
  }
  console.log()
  console.log(chalk.dim("Limitações:"))
  for (const l of REPLAY_LIMITATIONS) {
    console.log(chalk.dim(`  • ${l}`))
  }
  console.log()
}

// ── golden replay vectors (CI-gate fixtures, T1b-3) ───────────────────────
//
// The committed file `packages/cli/governance/replay-golden-vectors.json`
// holds canonical (envelope, decision) pairs: real v2 IntentEnvelopes (built
// via @adjudicate/core's buildEnvelope, so intentHash satisfies the DB CHECK)
// and the Decision each one produced against the CURRENT policy packs on the
// empty replay state. The PR gate seeds them into an ephemeral audit
// database (`--seed-file`) and replays the window: a policy/guard change that
// alters any decision surfaces as drift → exit 2. After an INTENDED policy
// change, regenerate with `ibx kernel replay --update-golden <file>` and
// commit the diff — the review of that diff IS the policy-change review.

interface GoldenReplayVector {
  readonly note?: string
  readonly envelope: {
    readonly version: number
    readonly kind: string
    readonly payload: unknown
    readonly createdAt: string
    readonly nonce: string
    readonly actor: { readonly principal: string; readonly sessionId: string }
    readonly taint: string
    readonly intentHash: string
  }
  decision: {
    readonly kind: string
    readonly basis?: ReadonlyArray<{ category?: string; code?: string }>
  } & Record<string, unknown>
}

interface GoldenReplayVectorFile {
  readonly comment?: string | readonly string[]
  readonly vectors: GoldenReplayVector[]
}

async function loadGoldenVectorFile(path: string): Promise<GoldenReplayVectorFile> {
  let file: GoldenReplayVectorFile
  try {
    file = JSON.parse(await readFile(path, "utf-8")) as GoldenReplayVectorFile
  } catch (err) {
    throw new Error(`golden vectors ilegíveis (${path}): ${(err as Error).message}`)
  }
  if (!Array.isArray(file.vectors) || file.vectors.length === 0) {
    throw new Error(
      `golden vectors vazios (${path}) — um seed vazio produziria um gate vácuo.`,
    )
  }
  return file
}

/**
 * Insert the golden vectors into `intent_audit` with `recorded_at = now`, so
 * they fall inside the subsequent replay window. Uses the audit-postgres
 * package's own `recordToRow` / `INSERT_AUDIT_SQL` / `auditInsertParams` —
 * the canonical 25-column mapping (D-014 finding: partial inserts defeat
 * tamper-evidence; never hand-roll this SQL). Also ensures the current-month
 * partition exists: `intent_audit` is RANGE-partitioned by recorded_at and
 * `ibx kernel migrate` applies only the schema, so the CI gate needs nothing
 * beyond `kernel migrate` + this command.
 */
async function seedGoldenVectors(
  client: {
    query(sql: string, params?: readonly unknown[]): Promise<unknown>
  },
  seedFile: string,
): Promise<number> {
  const file = await loadGoldenVectorFile(seedFile)
  const { INSERT_AUDIT_SQL, auditInsertParams, recordToRow } = await import(
    "@adjudicate/audit-postgres"
  )
  const { monthlyPartitionSpecs, partitionStatement } = await import(
    "../lib/kernel-migrate.js"
  )
  for (const spec of monthlyPartitionSpecs(new Date(), 0, 1)) {
    await client.query(partitionStatement(spec))
  }
  const nowIso = new Date().toISOString()
  for (const v of file.vectors) {
    if (v.envelope.actor.sessionId.startsWith(AGENT_SESSION_ID_PREFIX)) {
      // A golden vector in the agent namespace would be excluded from the
      // scan set and never replayed — a silent one-vector vacuous gate.
      throw new Error(
        `golden vector "${v.note ?? v.envelope.kind}" usa sessionId no namespace de agente ("${AGENT_SESSION_ID_PREFIX}") — seria excluído do scan e nunca replayado.`,
      )
    }
    const record = {
      version: 2,
      intentHash: v.envelope.intentHash,
      envelope: v.envelope,
      decision: v.decision,
      decision_basis: v.decision.basis ?? [],
      at: nowIso,
      durationMs: 1,
    }
    const row = recordToRow(record as never)
    await client.query(INSERT_AUDIT_SQL, [...auditInsertParams(row)])
  }
  return file.vectors.length
}

/**
 * `ibx kernel replay --update-golden <file>` — re-adjudicate every golden
 * envelope against the CURRENT packs (empty replay state, same recipe as the
 * gate) and rewrite the stored decisions in place. No database involved.
 * Run after an intended policy change; commit the diff.
 */
async function runUpdateGolden(
  filePath: string,
  opts: { json?: boolean },
): Promise<void> {
  const json = opts.json === true
  let file: GoldenReplayVectorFile
  try {
    file = await loadGoldenVectorFile(filePath)
  } catch (err) {
    if (json) {
      printReplayJson({ status: "failed", exitCode: 1, error: (err as Error).message })
    } else {
      console.error(chalk.red((err as Error).message))
    }
    process.exitCode = 1
    return
  }

  const { adjudicate } = await import("@adjudicate/core/kernel")
  const packIndex = await loadPackIndex()
  let changed = 0
  const missingPacks: string[] = []
  const adjudicationErrors: string[] = []
  for (const v of file.vectors) {
    const pack = packIndex.get(v.envelope.kind)
    if (!pack) {
      missingPacks.push(v.envelope.kind)
      continue
    }
    try {
      const decision = (await adjudicate(
        v.envelope as never,
        {} as never,
        pack.policy as never,
      )) as GoldenReplayVector["decision"]
      if (JSON.stringify(decision) !== JSON.stringify(v.decision)) {
        v.decision = decision
        changed += 1
      }
    } catch (err) {
      adjudicationErrors.push(`${v.envelope.kind}: ${(err as Error).message}`)
    }
  }

  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8")

  const failed = missingPacks.length > 0 || adjudicationErrors.length > 0
  if (json) {
    printReplayJson({
      status: failed ? "errors" : "golden-updated",
      file: filePath,
      vectors: file.vectors.length,
      changed,
      missingPacks,
      adjudicationErrors,
      exitCode: failed ? 1 : 0,
    })
  } else {
    console.log()
    console.log(chalk.bold("ibx kernel replay --update-golden"))
    console.log(
      `  ${chalk.cyan(String(file.vectors.length))} vectors; ${chalk.cyan(String(changed))} decisões regravadas → ${filePath}`,
    )
    for (const k of missingPacks) {
      console.error(chalk.red(`  ✗ sem pack instalado para ${k} — vector não re-adjudicado`))
    }
    for (const e of adjudicationErrors) {
      console.error(chalk.red(`  ✗ adjudicate falhou: ${e}`))
    }
    if (changed > 0) {
      console.log(
        chalk.yellow(
          "  Commit o diff — a revisão dessas decisões É a revisão da mudança de política.",
        ),
      )
    } else if (!failed) {
      console.log(chalk.green("  Nenhuma decisão mudou — política estável."))
    }
    console.log()
  }
  if (failed) process.exitCode = 1
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
    .sort((a, b) => a.localeCompare(b))
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
  for (const [spec, exp] of FIRST_PARTY_PACK_SPECS) {
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
  // Prefer `import.meta.resolve` (sync in modern Node), but it is unavailable
  // under some bundlers / test runners — Vite SSR turns it into an undefined
  // `__vite_ssr_import_meta__.resolve` — so fall back to `createRequire`,
  // which works wherever CJS resolution does. `import.meta.resolve` yields a
  // `file://` URL; `createRequire(...).resolve` yields a filesystem path.
  const metaResolve = (import.meta as { resolve?: (s: string) => string })
    .resolve
  const indexPath =
    typeof metaResolve === "function"
      ? fileURLToPath(await metaResolve("@adjudicate/audit-postgres"))
      : createRequire(import.meta.url).resolve("@adjudicate/audit-postgres")
  return join(dirname(dirname(indexPath)), "migrations")
}

/** A migration file paired with its SQL text. */
export interface PendingMigration {
  readonly file: string
  readonly sql: string
}

/** Minimal client surface used by the migration runner (satisfied by pg.Client). */
export interface MigrationClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Structured logger surface for the migration runner. */
export interface MigrateLog {
  info(msg: string): void
  warn(msg: string): void
}

/** Ledger table tracking which audit-postgres migrations have been applied. */
const AUDIT_MIGRATIONS_LEDGER = "audit_schema_migrations"

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Parse the constraint name out of a Postgres check_violation message. */
function violatedConstraintName(err: unknown): string | null {
  const m = /constraint "([^"]+)"/i.exec((err as Error | undefined)?.message ?? "")
  return m ? m[1]! : null
}

/**
 * True when some LATER migration re-defines (`ADD CONSTRAINT`) `name`. A
 * check_violation on a constraint that a subsequent migration re-adds means
 * the failing migration is a superseded INTERMEDIATE constraint state — e.g.
 * 005 narrows record_version to `IN (1,2,3)`, 008 widens to `IN (1,2,3,4)`,
 * 010 to `IN (1,2,3,4,5)`. On a DB whose data is already ahead of the
 * intermediate, Postgres runs each file as one implicit transaction, so the
 * failed file rolled back and the prior (wider) constraint is intact —
 * skipping it is safe. We require provable supersession so a violation on the
 * FINAL constraint (no later redefinition) is never masked.
 */
function isSupersededConstraint(
  name: string,
  laterMigrations: readonly PendingMigration[],
): boolean {
  const re = new RegExp(`ADD\\s+CONSTRAINT\\s+${escapeRegExp(name)}\\b`, "i")
  return laterMigrations.some((m) => re.test(m.sql))
}

/**
 * Apply `migrations` (in order) against `client`, recording each applied file
 * in the `audit_schema_migrations` ledger so every migration runs at most
 * once. This is the re-runnable core behind `ibx kernel migrate` /
 * `ibx bootstrap`, safe on three kinds of database:
 *
 *   - Fresh DB: ledger empty → every file runs in order and is recorded.
 *   - Already-migrated DB: recorded files are skipped via the ledger.
 *   - Pre-ledger DB that advanced past the early migrations WITH data
 *     (the regression this fixes — the old runner re-ran every file from 001
 *     and aborted re-applying the constraint-NARROWING migration 005, which
 *     existing v4 rows violate, so it never reached 010): the ledger is
 *     created empty, then each file is (re-)attempted. Additive migrations are
 *     idempotent (`IF NOT EXISTS`) or surface "already exists"/"duplicate" →
 *     recorded as applied. A constraint-narrowing migration whose data is
 *     ahead of it fails with check_violation; if a later migration re-defines
 *     that exact constraint it is a superseded intermediate → recorded and
 *     skipped. Every other failure aborts — we never swallow a violation on
 *     the final constraint, which would mask genuinely bad data.
 *
 * Defence in depth: skipping a superseded constraint is only safe if a LATER
 * migration re-establishes a VALIDATED constraint of that name. A name match
 * alone does not prove that (a future migration could re-add the constraint
 * `NOT VALID`, leaving existing bad rows unchecked). So after the run we
 * re-assert via `pg_constraint` that every skipped constraint is now present
 * AND `convalidated` — aborting if not, rather than reporting a false success.
 *
 * Requirement: each migration file is executed as ONE implicit transaction
 * (single multi-statement query), so a failed file rolls back atomically.
 * Migration files must therefore be transaction-compatible DDL — no
 * `CREATE INDEX CONCURRENTLY`, `VACUUM`, `REINDEX`, or explicit `BEGIN/COMMIT`
 * (such a statement errors with SQLSTATE 25001 and the runner aborts loudly).
 *
 * Exported for unit testing with a fake client.
 */
export async function applyMigrationsWithLedger(
  client: MigrationClient,
  migrations: readonly PendingMigration[],
  log: MigrateLog,
): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${AUDIT_MIGRATIONS_LEDGER} (` +
      `filename TEXT PRIMARY KEY, ` +
      `applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  )
  const appliedRes = await client.query(
    `SELECT filename FROM ${AUDIT_MIGRATIONS_LEDGER}`,
  )
  const applied = new Set(appliedRes.rows.map((r) => String(r.filename)))

  const record = (file: string) =>
    client.query(
      `INSERT INTO ${AUDIT_MIGRATIONS_LEDGER} (filename) VALUES ($1) ` +
        `ON CONFLICT (filename) DO NOTHING`,
      [file],
    )

  // Constraints we skipped as "superseded" — re-asserted as validated below.
  const skippedConstraints = new Set<string>()

  for (let i = 0; i < migrations.length; i++) {
    const { file, sql } = migrations[i]!
    if (applied.has(file)) {
      log.info(`  ⏭ ${file} — registrado, pulando`)
      continue
    }
    try {
      await client.query(sql)
      await record(file)
      log.info(`  ✓ ${file}`)
      continue
    } catch (err) {
      const msg = (err as Error).message ?? ""
      const code = (err as { code?: string }).code
      // Additive object already present (pre-ledger DB) — already applied.
      if (/already exists|duplicate/i.test(msg)) {
        await record(file)
        log.info(`  ↺ ${file} — já aplicado`)
        continue
      }
      // Superseded intermediate constraint state (see isSupersededConstraint).
      // Postgres code 23514 = check_violation. Prefer node-postgres' structured
      // `err.constraint` (stable wire metadata) over locale-fragile message
      // parsing; fall back to the message parse if absent.
      const cname =
        (err as { constraint?: string }).constraint ??
        violatedConstraintName(err)
      if (
        code === "23514" &&
        cname !== null &&
        isSupersededConstraint(cname, migrations.slice(i + 1))
      ) {
        skippedConstraints.add(cname)
        await record(file)
        log.warn(
          `  ⤼ ${file} — restrição "${cname}" substituída por migração posterior (dados à frente); pulando`,
        )
        continue
      }
      throw new Error(`migration ${file} failed: ${msg}`)
    }
  }

  // Defence in depth: a name match alone does not prove a skipped constraint
  // was truly superseded by a VALIDATED replacement (a later migration could
  // re-add it `NOT VALID`, leaving existing bad rows unchecked). Re-assert that
  // every skipped constraint now exists AND is `convalidated`, or abort — never
  // report success on an un-backed skip.
  if (skippedConstraints.size > 0) {
    const names = [...skippedConstraints]
    const res = await client.query(
      `SELECT conname FROM pg_constraint ` +
        `WHERE conname = ANY($1) AND convalidated`,
      [names],
    )
    const validated = new Set(res.rows.map((r) => String(r.conname)))
    const unbacked = names.filter((n) => !validated.has(n))
    if (unbacked.length > 0) {
      throw new Error(
        `migration ledger: superseded-skip left constraint(s) absent or ` +
          `unvalidated after migrate: ${unbacked.join(", ")} — refusing to ` +
          `report success`,
      )
    }
  }
}

/**
 * Resolve + read every `@adjudicate/audit-postgres` migration file in
 * numeric order. Exported so the integration test can run the same migration
 * set the CLI ships.
 */
export async function loadAuditPostgresMigrations(): Promise<PendingMigration[]> {
  const migrationsDir = await resolveAuditPostgresMigrationsDir()
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
  const migrations: PendingMigration[] = []
  for (const file of files) {
    migrations.push({
      file,
      sql: await readFile(join(migrationsDir, file), "utf8"),
    })
  }
  return migrations
}

/**
 * Apply all `@adjudicate/audit-postgres` SQL migrations against
 * `$DATABASE_URL`, exactly once each, via the `audit_schema_migrations`
 * ledger (see `applyMigrationsWithLedger`). Safe to re-run on fresh,
 * already-migrated, and pre-ledger-with-data databases.
 *
 * Exported so `ibx bootstrap` can call it as part of first-time setup
 * (after Prisma migrations + seeds).
 */
export async function applyAuditPostgresMigrations(
  databaseUrl: string,
  log: MigrateLog = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
  },
): Promise<void> {
  const migrations = await loadAuditPostgresMigrations()
  if (migrations.length === 0) {
    log.warn("Nenhum arquivo .sql de migração encontrado")
    return
  }
  const { default: pg } = await import("pg")
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await applyMigrationsWithLedger(
      client as unknown as MigrationClient,
      migrations,
      log,
    )
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

// Test-only injection seam. The defer-resume path lazily
// `import("@ibatexas/tools")` (below) to keep the heavy tools package out of
// the cold start of every other `ibx kernel` subcommand. vitest's
// interception of that DYNAMIC import is racy under CI — the first dynamic
// import of a run can resolve to the real module before the mock registers,
// which let the hermetic defer-resume tests reach the real getRedisClient()
// (→ "REDIS_URL env var required" / connect timeout). Tests inject a fake
// here instead; it is null in production, so there is no behaviour change.
let deferResumeDepsOverride: DeferResumeDeps | null = null

/** @internal test-only — inject a fake Redis + key-prefixer for defer-resume. */
export function __setDeferResumeDepsForTest(
  deps: DeferResumeDeps | null,
): void {
  deferResumeDepsOverride = deps
}

async function loadDeferResumeDeps(): Promise<DeferResumeDeps> {
  if (deferResumeDepsOverride) return deferResumeDepsOverride
  return {
    getRedis: () => getRedisClient(),
    rk: toolsRk,
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
    // operator-kicked resumes from real Stripe webhooks. The `cli:` prefix
    // tags the injection channel (CLI) ahead of the operator identity.
    cliInjectedBy: `cli:${operatorIdentity()}`,
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

// ── Governance: AI-BOM (F12) + policy coherence (F11) ──────────────────────
//
// `kernelMinVersion` floor stamped into every BOM (the @adjudicate/core major
// line these packs target). A single named constant per Hard Rule #3 — not
// authored per-pack. `KERNEL_VERSION` is the installed core line; both feed the
// reproducible `bomDigest`, so a core bump is a material re-baseline event.
const KERNEL_MIN_VERSION = "1.0.0"
const KERNEL_VERSION = "1.3.0"
// Pinned wall-clock: EXCLUDED from `bomDigest` (digest covers everything except
// generatedAt + signature), so it keeps the committed BOM artifact byte-stable.
const BOM_GENERATED_AT = "2026-06-07T00:00:00.000Z"

interface GovernancePack {
  readonly id: string
  readonly version: string
  readonly contract: string
  readonly intents: readonly string[]
  readonly signals?: readonly string[]
  readonly basisCodes?: readonly string[]
  readonly policy: unknown
  readonly planner: unknown
}

// Raw first-party pack objects (not the kind→pack index) for BOM + analyze.
// Mirrors loadPackIndex's spec list; degrades gracefully outside the monorepo.
async function loadPacksForGovernance(
  only?: string,
): Promise<GovernancePack[]> {
  const out: GovernancePack[] = []
  for (const [spec, exp] of FIRST_PARTY_PACK_SPECS) {
    if (only !== undefined && spec !== only) continue
    try {
      const mod = (await import(spec as string)) as Record<
        string,
        GovernancePack | undefined
      >
      const pack = mod[exp]
      if (pack) out.push(pack)
    } catch {
      // Unresolvable spec — skip (CLI may run outside the workspace).
    }
  }
  return out
}

async function runPackBom(opts: {
  pack?: string
  json?: boolean
  verifyFile?: string
}): Promise<void> {
  const { generateAiBom, runConformance, scorePackHealth } = await import(
    "@adjudicate/conformance"
  )
  const packs = await loadPacksForGovernance(opts.pack)
  if (packs.length === 0) {
    console.error(
      chalk.red(`Nenhum pack encontrado${opts.pack ? ` para ${opts.pack}` : ""}.`),
    )
    process.exitCode = 1
    return
  }

  let baseline: Record<string, string> | undefined
  if (opts.verifyFile !== undefined) {
    try {
      baseline = JSON.parse(await readFile(opts.verifyFile, "utf-8")) as Record<
        string,
        string
      >
    } catch {
      console.error(chalk.red(`Baseline ilegível: ${opts.verifyFile}`))
      process.exitCode = 1
      return
    }
  }

  const digests: Record<string, string> = {}
  let mismatch = false
  for (const pack of packs) {
    const conformance = runConformance(pack as never)
    const manifest = {
      contract: pack.contract as "v0" | "v1",
      packId: pack.id,
      kernelMinVersion: KERNEL_MIN_VERSION,
      intents: pack.intents,
      ...(pack.signals ? { signals: pack.signals } : {}),
    }
    const health = scorePackHealth({
      manifest: { ok: true, manifest },
      conformance,
      intentCount: pack.intents.length,
      signalCount: pack.signals?.length ?? 0,
      packId: pack.id,
    })
    const bom = generateAiBom({
      pack,
      manifest,
      conformance,
      health,
      generatedAt: BOM_GENERATED_AT,
      kernelVersion: KERNEL_VERSION,
    })
    digests[pack.id] = bom.bomDigest

    if (baseline !== undefined) {
      const want = baseline[pack.id]
      if (want === undefined) {
        console.error(chalk.red(`✗ ${pack.id}: sem entrada na baseline`))
        mismatch = true
      } else if (want !== bom.bomDigest) {
        console.error(
          chalk.red(
            `✗ ${pack.id}: bomDigest divergente (baseline ${want.slice(0, 12)}…, atual ${bom.bomDigest.slice(0, 12)}…)`,
          ),
        )
        mismatch = true
      } else {
        console.log(chalk.green(`✓ ${pack.id} → ${bom.bomDigest.slice(0, 16)}…`))
      }
    } else if (opts.json) {
      console.log(JSON.stringify(bom, null, 2))
    } else {
      console.log(chalk.bold(`AI-BOM ${pack.id}@${pack.version}`))
      console.log(`  fingerprint : ${bom.fingerprint}`)
      console.log(`  bomDigest   : ${bom.bomDigest}`)
      console.log(
        `  conformance : ${bom.conformance.passedCount}/${bom.conformance.total}`,
      )
      console.log(
        `  health      : ${bom.healthTier} (${bom.healthScore.score}/${bom.healthScore.maxScore})`,
      )
    }
  }

  // ── Managed agents (T3-3) ──────────────────────────────────────────────
  // The agent roster is part of the AI-BOM: each AgentDefinition in
  // @ibatexas/agents folds into the same digest-lock via the upstream
  // pack-health/PackManifest mapping (`generateAgentAiBom`), keyed
  // `agent/<id>` in the baseline next to the pack entries. The roster-drift
  // gate runs first, fail-closed in EVERY mode (a drifting roster must
  // never be baselined or verified green). Skipped only under `--pack`,
  // which scopes the command to one pack explicitly.
  if (opts.pack === undefined) {
    const { AGENT_REGISTRY, agentRosterDrift, generateAgentAiBom } =
      await import("@ibatexas/agents")
    const driftFindings = agentRosterDrift()
    if (driftFindings.length > 0) {
      for (const f of driftFindings) {
        console.error(
          chalk.red(`✗ agent-roster drift [${f.agentId}] ${f.code}: ${f.detail}`),
        )
      }
      mismatch = true
    }
    for (const def of AGENT_REGISTRY) {
      const bom = generateAgentAiBom(def, {
        generatedAt: BOM_GENERATED_AT,
        kernelVersion: KERNEL_VERSION,
        kernelMinVersion: KERNEL_MIN_VERSION,
      })
      digests[bom.packId] = bom.bomDigest

      if (baseline !== undefined) {
        const want = baseline[bom.packId]
        if (want === undefined) {
          console.error(chalk.red(`✗ ${bom.packId}: sem entrada na baseline`))
          mismatch = true
        } else if (want !== bom.bomDigest) {
          console.error(
            chalk.red(
              `✗ ${bom.packId}: bomDigest divergente (baseline ${want.slice(0, 12)}…, atual ${bom.bomDigest.slice(0, 12)}…)`,
            ),
          )
          mismatch = true
        } else {
          console.log(
            chalk.green(`✓ ${bom.packId} → ${bom.bomDigest.slice(0, 16)}…`),
          )
        }
      } else if (opts.json) {
        console.log(JSON.stringify(bom, null, 2))
      } else {
        console.log(
          chalk.bold(`AI-BOM ${bom.packId}@${bom.packVersion}`) +
            chalk.dim(` (agente gerenciado)`),
        )
        console.log(`  fingerprint : ${bom.fingerprint}`)
        console.log(`  bomDigest   : ${bom.bomDigest}`)
        console.log(
          `  conformance : ${bom.conformance.passedCount}/${bom.conformance.total}`,
        )
        console.log(
          `  health      : ${bom.healthTier} (${bom.healthScore.score}/${bom.healthScore.maxScore})`,
        )
      }
    }
  }

  // When neither verifying nor emitting full JSON, print the digest-lock so an
  // operator can capture/refresh governance/pack-bom-baseline.json.
  if (opts.verifyFile === undefined && opts.json !== true) {
    console.log()
    console.log(
      chalk.dim("digest-lock (governance/pack-bom-baseline.json):"),
    )
    console.log(JSON.stringify(digests, null, 2))
  }
  if (mismatch) process.exitCode = 1
}

async function runAnalyze(opts: {
  pack?: string
  json?: boolean
  sarif?: boolean
}): Promise<void> {
  const { analyzePolicy, renderJson, renderSarif, renderText } = await import(
    "@adjudicate/analyze"
  )
  const packs = await loadPacksForGovernance(opts.pack)
  if (packs.length === 0) {
    console.error(
      chalk.red(`Nenhum pack encontrado${opts.pack ? ` para ${opts.pack}` : ""}.`),
    )
    process.exitCode = 1
    return
  }
  // Tier-1 coherence (basis-vocab / default-polarity / taint-policy …). NO
  // `strict` and NO plannerProbes here: the planner-coherence Tier-3 gate
  // (AJD-301) lives in each pack's conformance.test.ts where the probe fixtures
  // are. We gate the CLI on `summary.error` only — warnings are intentional.
  let anyError = false
  for (const pack of packs) {
    const report = analyzePolicy({ pack: pack as never })
    if (!report.passed) anyError = true
    if (opts.sarif) console.log(renderSarif(report))
    else if (opts.json) console.log(renderJson(report))
    else console.log(renderText(report))
  }
  if (anyError) process.exitCode = 1
}

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
      "Re-feeda registros de audit por adjudicate() e relata drift. Exit: 0 limpo / 1 erros / 2 drift. (--since=24h, --intent-kind=X, --limit=1000)",
    )
    .option("--since <duration>", "Janela de tempo (ex: 24h, 7d, 30m)", "24h")
    .option("--intent-kind <kind>", "Filtra por intent kind (ex: order.checkout.create)")
    .option("--limit <n>", "Limite de registros (default 1000)", "1000")
    .option("--dry-run", "Apenas lista os registros sem re-adjudicar")
    .option("--json", "Emite o relatório estruturado em JSON (idioma do pack-bom)")
    .option(
      "--ci",
      "Modo CI fail-closed: falha (exit 1) se IBX_AUDIT_POSTGRES_ENABLED não estiver habilitado ou a janela estiver vazia (proteção contra gate vácuo)",
    )
    .option(
      "--seed-file <path>",
      "Semeia os golden vectors (recorded_at=agora) no intent_audit antes do replay — uso do gate de CI (governance/replay-golden-vectors.json)",
    )
    .option(
      "--update-golden <path>",
      "Re-adjudica os envelopes do arquivo golden contra os packs atuais e regrava as decisões (sem DB; rode após mudança de política intencional)",
    )
    .action(
      async (opts: {
        since?: string
        intentKind?: string
        limit?: string
        dryRun?: boolean
        json?: boolean
        ci?: boolean
        seedFile?: string
        updateGolden?: string
      }) => {
        if (opts.updateGolden !== undefined) {
          await runUpdateGolden(opts.updateGolden, { json: opts.json })
          return
        }
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

  // ── pack-bom (F12) ─────────────────────────────────────────────────────────
  group
    .command("pack-bom")
    .description(
      "Gera o AI Bill-of-Materials (EU AI Act / NIST) dos packs E do roster de agentes gerenciados (@ibatexas/agents) — fingerprint + conformance + health. --verify-file falha (exit 1) se o bomDigest divergir da baseline ou se o roster de agentes driftar.",
    )
    .option("--pack <spec>", "Pack alvo (default: todos os first-party)")
    .option("--json", "Emite o AiBom completo em JSON")
    .option(
      "--verify-file <path>",
      "Compara o bomDigest de cada pack contra a baseline commitada (CI gate)",
    )
    .action(
      async (opts: { pack?: string; json?: boolean; verifyFile?: string }) => {
        await runPackBom(opts)
      },
    )

  // ── analyze (F11) ──────────────────────────────────────────────────────────
  group
    .command("analyze")
    .description(
      "Roda os analisadores de coerência de política (Tier-1) sobre os packs e falha (exit 1) em erros. --sarif para CI.",
    )
    .option("--pack <spec>", "Pack alvo (default: todos os first-party)")
    .option("--json", "Emite o AnalysisReport em JSON")
    .option("--sarif", "Emite SARIF 2.1.0 (upload em code-scanning)")
    .action(async (opts: { pack?: string; json?: boolean; sarif?: boolean }) => {
      await runAnalyze(opts)
    })

  // ── seal (F5) ──────────────────────────────────────────────────────────────
  group
    .command("seal")
    .description(
      "Computa o config-seal digest de cada pack e imprime a linha CONFIG_SEAL_DIGESTS para fixar o boot-gate (F5).",
    )
    .option("--pack <spec>", "Pack alvo (default: todos os first-party)")
    .action(async (opts: { pack?: string }) => {
      const { computeConfigDigest, extractSealableSurface } = await import(
        "@adjudicate/conformance"
      )
      const packs = await loadPacksForGovernance(opts.pack)
      if (packs.length === 0) {
        console.error(
          chalk.red(
            `Nenhum pack encontrado${opts.pack ? ` para ${opts.pack}` : ""}.`,
          ),
        )
        process.exitCode = 1
        return
      }
      const entries: string[] = []
      for (const pack of packs) {
        const digest = computeConfigDigest(extractSealableSurface(pack as never))
        console.log(chalk.bold(`${pack.id}@${pack.version}`) + ` → ${digest}`)
        entries.push(`${pack.id}=${digest}`)
      }
      console.log()
      console.log(
        chalk.dim(
          "Fixe em .env (CONFIG_SEAL_DIGESTS) para ativar o boot-gate fail-closed:",
        ),
      )
      console.log(`CONFIG_SEAL_DIGESTS=${entries.join(";")}`)
    })
}
