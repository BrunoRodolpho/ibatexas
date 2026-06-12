// `ibx journey` — gates da Journey Registry (plano de teste, Fase 1a).
//
// THIN registration only: toda a lógica de lint/cobertura vive em
// `@ibatexas/journeys` (`src/gates/lint.ts` + `src/gates/coverage.ts`) —
// este arquivo apenas registra os comandos e formata a saída. Vocabulário:
// "journey" (jornada LLM-driven, novo plano de teste) ≠ "ibx scenario" (o
// engine de data-state existente — intocado).
//
// Idioma de CI exatamente igual a `ibx kernel pack-bom`:
//   - `--json`               → emite o relatório completo em JSON
//   - `--verify-file <path>` → compara o digest-lock por jornada contra a
//                              baseline commitada
//                              (packages/journeys/governance/journey-lint-baseline.json)
//   - exit 0 limpo / exit 1 em qualquer problema ou divergência. Um
//     registry vazio passa vacuamente (T1a-12 autora as jornadas).
//
// Dependência cli→journeys é a direção sancionada (check-bypass leg 6
// exclui packages/cli). Import dinâmico para não pesar o startup do ibx.

import { existsSync, realpathSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Command } from "commander"
import chalk from "chalk"

// Raiz do monorepo, ancorada neste arquivo (mesmo idioma do index.ts):
// src/commands/ e dist/commands/ estão ambos a 3 níveis de packages/cli →
// 4 níveis da raiz. realpathSync resolve symlinks de npm link.
const MONOREPO_ROOT = resolve(
  dirname(realpathSync(fileURLToPath(import.meta.url))),
  "../../../..",
)

// Runners como `pnpm --filter @ibatexas/cli exec` trocam o cwd para
// packages/cli — um caminho relativo digitado da raiz (ex.:
// packages/journeys/governance/…) deixaria de resolver. Regra: cwd primeiro;
// se não existir lá mas existir relativo à raiz do monorepo, usa a raiz.
function resolveUserPath(p: string): string {
  if (isAbsolute(p)) return p
  const fromCwd = resolve(process.cwd(), p)
  if (existsSync(fromCwd)) return fromCwd
  const fromRoot = resolve(MONOREPO_ROOT, p)
  return existsSync(fromRoot) ? fromRoot : fromCwd
}

async function runJourneyLint(opts: {
  json?: boolean
  verifyFile?: string
  dir?: string
}): Promise<void> {
  const { lintJourneys, lintDigestLock, verifyLintBaseline } = await import(
    "@ibatexas/journeys"
  )
  const report = await lintJourneys(
    opts.dir !== undefined ? { dir: opts.dir } : undefined,
  )

  // ── Problemas de lint → exit 1 (com ou sem --json) ─────────────────────
  if (!report.ok) {
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      for (const p of report.problems) {
        const where = p.journeyId !== null ? ` (${p.journeyId})` : ""
        const at = p.path !== null ? ` em ${p.path}` : ""
        console.error(chalk.red(`✗ ${p.file}${where}: ${p.code}${at} — ${p.message}`))
      }
      console.error(
        chalk.red(`${report.problems.length} problema(s) de lint em ${report.journeys.length} jornada(s).`),
      )
    }
    process.exitCode = 1
    return
  }

  // ── Verificação de baseline (idioma pack-bom) ──────────────────────────
  if (opts.verifyFile !== undefined) {
    let baseline: Record<string, string>
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
    const mismatches = verifyLintBaseline(report, baseline)
    const bad = new Map(mismatches.map((m) => [m.journeyId, m]))
    for (const entry of report.journeys) {
      const mismatch = bad.get(entry.id)
      if (mismatch === undefined) {
        console.log(chalk.green(`✓ ${entry.id} → ${entry.digest.slice(0, 16)}…`))
      } else if (mismatch.reason === "missing_in_baseline") {
        console.error(chalk.red(`✗ ${entry.id}: sem entrada na baseline`))
      } else {
        console.error(
          chalk.red(
            `✗ ${entry.id}: digest divergente (baseline ${mismatch.expected?.slice(0, 12)}…, atual ${mismatch.actual.slice(0, 12)}…)`,
          ),
        )
      }
    }
    if (mismatches.length > 0) process.exitCode = 1
    return
  }

  // ── Saída limpa ─────────────────────────────────────────────────────────
  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  if (report.journeys.length === 0) {
    console.log(chalk.green("✓ Registry vazio — lint passa vacuamente (0 jornadas)."))
  } else {
    for (const entry of report.journeys) {
      console.log(
        chalk.green(`✓ ${entry.id}`) +
          chalk.dim(` [${entry.status}, ${entry.personaContext}] ${entry.file}`),
      )
    }
  }
  // Digest-lock para capturar/atualizar a baseline (idioma pack-bom).
  console.log()
  console.log(chalk.dim("digest-lock (packages/journeys/governance/journey-lint-baseline.json):"))
  console.log(JSON.stringify(lintDigestLock(report), null, 2))
}

// ── `ibx journey coverage` (T1a-3) ─────────────────────────────────────────

async function runJourneyCoverage(opts: {
  json?: boolean
  verifyFile?: string
  dir?: string
  waivers?: string
  out?: string
  quarantined?: string
}): Promise<void> {
  const {
    computeJourneyCoverage,
    coverageMatrixView,
    journeyPassView,
    coverageBaseline,
    verifyCoverageBaseline,
    CoverageBaselineSchema,
  } = await import("@ibatexas/journeys")

  const report = await computeJourneyCoverage({
    ...(opts.dir !== undefined ? { dir: resolveUserPath(opts.dir) } : {}),
    ...(opts.waivers !== undefined ? { waiversPath: resolveUserPath(opts.waivers) } : {}),
    ...(opts.quarantined !== undefined
      ? {
          quarantined: opts.quarantined
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }
      : {}),
  })

  // ── Problemas (registry/waivers quebrados) → exit 1 ────────────────────
  if (!report.ok) {
    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      for (const p of report.problems) {
        console.error(chalk.red(`✗ ${p.file}: ${p.code} — ${p.message}`))
      }
    }
    process.exitCode = 1
    return
  }

  // ── --out: grava as duas views (matriz célula-a-célula + journey-pass) ─
  if (opts.out !== undefined) {
    const outDir = resolveUserPath(opts.out)
    await mkdir(outDir, { recursive: true })
    await writeFile(
      join(outDir, "coverage-matrix.json"),
      `${JSON.stringify(coverageMatrixView(report), null, 2)}\n`,
    )
    await writeFile(
      join(outDir, "coverage-journeys.json"),
      `${JSON.stringify(journeyPassView(report), null, 2)}\n`,
    )
    if (opts.json !== true) {
      console.log(
        chalk.dim(`views gravadas em ${outDir}/coverage-matrix.json + coverage-journeys.json`),
      )
    }
  }

  const t = report.totals
  const totalsLine =
    `${t.covered}/${t.cells} células cobertas, ${t.uncovered} descobertas, ` +
    `waived: ${t["waived-pending-WS4"]} pending-WS4 / ` +
    `${t["waived-unadvertised"]} unadvertised / ` +
    `${t["waived-quarantined"]} quarantined`

  // ── Verificação de baseline (regressão covered→uncovered) ──────────────
  if (opts.verifyFile !== undefined) {
    const verifyPath = resolveUserPath(opts.verifyFile)
    let baselineRaw: unknown
    try {
      baselineRaw = JSON.parse(await readFile(verifyPath, "utf-8"))
    } catch {
      console.error(chalk.red(`Baseline ilegível: ${verifyPath}`))
      process.exitCode = 1
      return
    }
    const baselineParsed = CoverageBaselineSchema.safeParse(baselineRaw)
    if (!baselineParsed.success) {
      console.error(
        chalk.red(`Baseline inválida (${opts.verifyFile}): esperado {"covered": [...]}`),
      )
      process.exitCode = 1
      return
    }
    const result = verifyCoverageBaseline(report, baselineParsed.data)

    if (opts.json === true) {
      console.log(
        JSON.stringify({ ...report, verify: { file: opts.verifyFile, ...result } }, null, 2),
      )
    } else {
      for (const r of result.regressions) {
        console.error(
          chalk.red(`✗ regressão: ${r.cell} estava coberta na baseline, agora ${r.state}`),
        )
      }
      for (const cell of result.quarantinedClaims) {
        console.warn(
          chalk.yellow(`⚠ ${cell} coberta na baseline, agora waived-quarantined (flake ledger)`),
        )
      }
      if (result.newlyCovered.length > 0) {
        console.log(
          chalk.dim(
            `${result.newlyCovered.length} célula(s) coberta(s) ainda fora da baseline — atualize ${opts.verifyFile} para reivindicá-las.`,
          ),
        )
      }
      if (result.ok) {
        console.log(chalk.green(`✓ Sem regressão de cobertura. ${totalsLine}`))
      } else {
        console.error(
          chalk.red(`${result.regressions.length} regressão(ões) de cobertura. ${totalsLine}`),
        )
      }
    }
    if (!result.ok) process.exitCode = 1
    return
  }

  // ── Saída limpa ─────────────────────────────────────────────────────────
  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(chalk.green(`✓ ${totalsLine}`))
  if (report.dormantWaivers.length > 0) {
    console.log(
      chalk.dim(
        `waivers dormentes (kind fora do domínio atual): ${report.dormantWaivers.map((w) => w.kind).join(", ")}`,
      ),
    )
  }
  // Baseline para capturar/atualizar (idioma pack-bom, como o lint).
  console.log()
  console.log(
    chalk.dim("baseline (packages/journeys/governance/journey-coverage-baseline.json):"),
  )
  console.log(JSON.stringify(coverageBaseline(report), null, 2))
}

// ── `ibx journey run` (T1a-13) ──────────────────────────────────────────────
// THIN registration: toda a composição (preflight → fixture → driver → http →
// verify[] → trace JSONL → relatório de custo) vive em @ibatexas/journeys
// (src/harness/run-journey-cli.ts). Saída de dev/CI em inglês (convenção do
// plano de teste); exit 0 somente com TODAS as tentativas verdes.

interface JourneyRunCliFlags {
  k?: string
  json?: boolean
  dir?: string
  envFile?: string
  // T1b-8 — suite + dollar-abort flags
  suite?: boolean
  only?: string
  kMoney?: string
  moneyFlows?: string
  budgetUsd?: string
}

function parseIdList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function runJourneyRun(id: string | undefined, opts: JourneyRunCliFlags): Promise<void> {
  const { runJourneyCli, runJourneySuiteCli, JourneyRunCliError, BudgetConfigError } =
    await import("@ibatexas/journeys")

  const k = opts.k !== undefined ? Number.parseInt(opts.k, 10) : 1
  const budgetUsd = opts.budgetUsd !== undefined ? Number.parseFloat(opts.budgetUsd) : undefined
  // Progress lines stream to stderr so --json keeps stdout machine-clean.
  const onProgress = (line: string): void => {
    if (opts.json === true) process.stderr.write(`${line}\n`)
    else console.log(chalk.dim(line))
  }

  try {
    // ── Suite path (T1b-8): all active journeys, sequential, dollar-capped ──
    if (opts.suite === true) {
      if (id !== undefined) {
        console.error(chalk.red("--suite roda todas as jornadas ativas — não combine com <id> (use --only)"))
        process.exitCode = 1
        return
      }
      const report = await runJourneySuiteCli({
        ...(opts.only !== undefined ? { only: parseIdList(opts.only) } : {}),
        k,
        ...(opts.kMoney !== undefined ? { kMoney: Number.parseInt(opts.kMoney, 10) } : {}),
        ...(opts.moneyFlows !== undefined ? { moneyFlows: parseIdList(opts.moneyFlows) } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(opts.dir !== undefined ? { dir: resolveUserPath(opts.dir) } : {}),
        ...(opts.envFile !== undefined ? { envFile: resolveUserPath(opts.envFile) } : {}),
        onProgress,
      })

      if (opts.json === true) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        for (const j of report.journeys) {
          const aborted = j.status === "aborted-by-budget"
          const head = j.pass
            ? chalk.green(`✓ ${j.journey}: PASS`)
            : chalk.red(`✗ ${j.journey}: ${aborted ? "ABORTED-BY-BUDGET" : "FAIL"}`)
          console.log(
            `${head} ${chalk.dim(`(${j.attempts.filter((a) => a.pass).length}/${j.k} green)`)}`,
          )
          console.log(j.costLine)
        }
        console.log(report.costLine)
        if (report.abortedByBudget) {
          console.error(
            chalk.red(
              `✗ suite aborted-by-budget: spent $${report.budget.spentUsd.toFixed(4)} >= cap $${report.budget.capUsd.toFixed(4)} (${report.budget.source}) — RED run`,
            ),
          )
        }
        console.log(
          report.pass
            ? chalk.green(`✓ suite green (${report.journeys.length} journeys)`)
            : chalk.red(`✗ suite RED (${report.journeys.filter((j) => j.pass).length}/${report.journeys.length} green)`),
        )
      }
      if (!report.pass) process.exitCode = 1
      return
    }

    // ── Single-journey path (T1a-13; budget applies to the --k loop too) ────
    if (id === undefined) {
      console.error(chalk.red("informe uma jornada (<id>) ou rode a suíte com --suite"))
      process.exitCode = 1
      return
    }
    const report = await runJourneyCli({
      journeyId: id,
      k,
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(opts.dir !== undefined ? { dir: resolveUserPath(opts.dir) } : {}),
      ...(opts.envFile !== undefined ? { envFile: resolveUserPath(opts.envFile) } : {}),
      onProgress,
    })

    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      for (const attempt of report.attempts) {
        const head = attempt.pass
          ? chalk.green(`✓ attempt ${attempt.attempt}: PASS`)
          : chalk.red(
              `✗ attempt ${attempt.attempt}: ${attempt.status === "aborted-by-budget" ? "ABORTED-BY-BUDGET" : "FAIL"}`,
            )
        console.log(
          `${head} ${chalk.dim(
            `runId=${attempt.runId} turns=${attempt.turns} ${(attempt.durationMs / 1000).toFixed(1)}s ${attempt.certifying ? "certifying" : "NON-certifying"}`,
          )}`,
        )
        console.log(attempt.costLine)
        if (attempt.error !== undefined) console.error(chalk.red(`  ${attempt.error}`))
      }
      console.log(report.costLine)
      if (report.status === "aborted-by-budget") {
        console.error(
          chalk.red(
            `✗ aborted-by-budget: spent $${report.budget.spentUsd.toFixed(4)} >= cap $${report.budget.capUsd.toFixed(4)} (${report.budget.source})`,
          ),
        )
      }
      console.log(
        report.pass
          ? chalk.green(`✓ ${report.journey} green ${report.k}/${report.k}`)
          : chalk.red(`✗ ${report.journey} failed (${report.attempts.filter((a) => a.pass).length}/${report.k} green)`),
      )
    }
    if (!report.pass) process.exitCode = 1
  } catch (err) {
    if (err instanceof JourneyRunCliError || err instanceof BudgetConfigError) {
      console.error(chalk.red(err.message))
      process.exitCode = 1
      return
    }
    throw err
  }
}

export function registerJourneyCommands(group: Command): void {
  group.description(
    "Journeys — registry de jornadas LLM-driven e seus gates de governança (plano de teste)",
  )

  group
    .command("lint")
    .description(
      "Roda o roster gate sobre packages/journeys/journeys/*.yaml — intent kinds conhecidos, expectativas alcançáveis por superfície, invariantes resolvíveis. --verify-file falha (exit 1) se o digest divergir da baseline.",
    )
    .option("--json", "Emite o relatório de lint em JSON")
    .option(
      "--verify-file <path>",
      "Compara o digest de cada jornada contra a baseline commitada (CI gate)",
    )
    .option(
      "--dir <path>",
      "Diretório alternativo de jornadas (default: packages/journeys/journeys/)",
    )
    .action(async (opts: { json?: boolean; verifyFile?: string; dir?: string }) => {
      await runJourneyLint(opts)
    })

  group
    .command("run [id]")
    .description(
      "Executa uma jornada (<id>) ou a suíte (--suite, todas as ativas em sequência) contra o stack de teste ao vivo: preflight → fixture/chat/http acts → verify[] → trace JSONL (runs/<runId>/) → relatório de custo via llm.call × price-table. --k N exige N tentativas TODAS verdes (exit 0 só com todas). Abort por orçamento (T1b-8): custo acumulado ≥ cap → run VERMELHO, restante reportado aborted-by-budget (cap: --budget-usd > IBX_NIGHTLY_BUDGET_USD > $50).",
    )
    .option("--k <n>", "Tentativas sequenciais; todas devem passar (default 1)")
    .option("--suite", "Roda TODAS as jornadas ativas em sequência (T1b-8; nightly T1b-4)")
    .option(
      "--only <ids>",
      "Com --suite: restringe às jornadas listadas (ids separados por vírgula)",
    )
    .option(
      "--k-money <n>",
      "Com --suite: tentativas para as jornadas de --money-flows (default: --k)",
    )
    .option(
      "--money-flows <ids>",
      "Com --suite: ids das jornadas money-flow que recebem --k-money (vírgula)",
    )
    .option(
      "--budget-usd <usd>",
      "Cap de dólares da execução (default: IBX_NIGHTLY_BUDGET_USD ou $50) — custo acumulado ≥ cap aborta como run vermelho",
    )
    .option("--json", "Emite o relatório da execução em JSON (stdout limpo)")
    .option(
      "--dir <path>",
      "Diretório alternativo de jornadas (default: packages/journeys/journeys/)",
    )
    .option(
      "--env-file <path>",
      "Arquivo .env do stack de teste (default: <repo>/.env.test; shell env tem precedência)",
    )
    .action(async (id: string | undefined, opts: JourneyRunCliFlags) => {
      await runJourneyRun(id, opts)
    })

  group
    .command("coverage")
    .description(
      "Matriz de cobertura célula-a-célula (kind × decisão × superfície, DR-5) sobre o registry de jornadas. --verify-file falha (exit 1) em regressão covered→uncovered contra a baseline; waivers em packages/journeys/governance/journey-coverage-waivers.json.",
    )
    .option("--json", "Emite o relatório de cobertura em JSON")
    .option(
      "--verify-file <path>",
      "Compara as células cobertas contra a baseline commitada (CI gate; exit 1 em regressão)",
    )
    .option(
      "--dir <path>",
      "Diretório alternativo de jornadas (default: packages/journeys/journeys/)",
    )
    .option(
      "--waivers <path>",
      "Arquivo de waivers alternativo (default: packages/journeys/governance/journey-coverage-waivers.json)",
    )
    .option(
      "--out <dir>",
      "Grava as duas views (coverage-matrix.json + coverage-journeys.json) no diretório",
    )
    .option(
      "--quarantined <ids>",
      "Ids de jornadas em quarentena, separados por vírgula (seam — o flake ledger da Fase 1b é a fonte autoritativa)",
    )
    .action(
      async (opts: {
        json?: boolean
        verifyFile?: string
        dir?: string
        waivers?: string
        out?: string
        quarantined?: string
      }) => {
        await runJourneyCoverage(opts)
      },
    )
}
