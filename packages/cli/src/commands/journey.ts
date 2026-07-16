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

type JourneysModule = typeof import("@ibatexas/journeys")
type LintReport = Awaited<ReturnType<JourneysModule["lintJourneys"]>>

function reportLintProblems(report: LintReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const p of report.problems) {
    const where = p.journeyId === null ? "" : ` (${p.journeyId})`
    const at = p.path === null ? "" : ` em ${p.path}`
    console.error(chalk.red(`✗ ${p.file}${where}: ${p.code}${at} — ${p.message}`))
  }
  console.error(
    chalk.red(
      `${report.problems.length} problema(s) de lint em ${report.journeys.length} jornada(s).`,
    ),
  )
}

async function verifyLintBaselineCli(
  report: LintReport,
  verifyFile: string,
  verifyLintBaseline: JourneysModule["verifyLintBaseline"],
): Promise<void> {
  let baseline: Record<string, string>
  try {
    baseline = JSON.parse(await readFile(verifyFile, "utf-8")) as Record<string, string>
  } catch {
    console.error(chalk.red(`Baseline ilegível: ${verifyFile}`))
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
}

function reportLintClean(
  report: LintReport,
  json: boolean,
  lintDigestLock: JourneysModule["lintDigestLock"],
): void {
  if (json) {
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

async function runJourneyLint(opts: {
  json?: boolean
  verifyFile?: string
  dir?: string
}): Promise<void> {
  const { lintJourneys, lintDigestLock, verifyLintBaseline } = await import(
    "@ibatexas/journeys"
  )
  const report = await lintJourneys(
    opts.dir === undefined ? undefined : { dir: opts.dir },
  )

  // ── Problemas de lint → exit 1 (com ou sem --json) ─────────────────────
  if (!report.ok) {
    reportLintProblems(report, opts.json === true)
    process.exitCode = 1
    return
  }

  // ── Verificação de baseline (idioma pack-bom) ──────────────────────────
  if (opts.verifyFile !== undefined) {
    await verifyLintBaselineCli(report, opts.verifyFile, verifyLintBaseline)
    return
  }

  // ── Saída limpa ─────────────────────────────────────────────────────────
  reportLintClean(report, opts.json === true, lintDigestLock)
}

// ── `ibx journey coverage` (T1a-3) ─────────────────────────────────────────

type CoverageReport = Awaited<ReturnType<JourneysModule["computeJourneyCoverage"]>>
type CoverageVerifyResult = ReturnType<JourneysModule["verifyCoverageBaseline"]>

function reportCoverageProblems(report: CoverageReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const p of report.problems) {
    console.error(chalk.red(`✗ ${p.file}: ${p.code} — ${p.message}`))
  }
}

async function writeCoverageViews(
  report: CoverageReport,
  outDir: string,
  json: boolean,
  deps: JourneysModule,
): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(outDir, "coverage-matrix.json"),
    `${JSON.stringify(deps.coverageMatrixView(report), null, 2)}\n`,
  )
  await writeFile(
    join(outDir, "coverage-journeys.json"),
    `${JSON.stringify(deps.journeyPassView(report), null, 2)}\n`,
  )
  if (!json) {
    console.log(
      chalk.dim(`views gravadas em ${outDir}/coverage-matrix.json + coverage-journeys.json`),
    )
  }
}

function renderCoverageVerifyHuman(
  result: CoverageVerifyResult,
  totalsLine: string,
  verifyFile: string,
): void {
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
        `${result.newlyCovered.length} célula(s) coberta(s) ainda fora da baseline — atualize ${verifyFile} para reivindicá-las.`,
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

async function verifyCoverageCli(
  report: CoverageReport,
  verifyFile: string,
  totalsLine: string,
  json: boolean,
  deps: JourneysModule,
): Promise<void> {
  const verifyPath = resolveUserPath(verifyFile)
  let baselineRaw: unknown
  try {
    baselineRaw = JSON.parse(await readFile(verifyPath, "utf-8"))
  } catch {
    console.error(chalk.red(`Baseline ilegível: ${verifyPath}`))
    process.exitCode = 1
    return
  }
  const baselineParsed = deps.CoverageBaselineSchema.safeParse(baselineRaw)
  if (!baselineParsed.success) {
    console.error(
      chalk.red(`Baseline inválida (${verifyFile}): esperado {"covered": [...]}`),
    )
    process.exitCode = 1
    return
  }
  const result = deps.verifyCoverageBaseline(report, baselineParsed.data)

  if (json) {
    console.log(
      JSON.stringify({ ...report, verify: { file: verifyFile, ...result } }, null, 2),
    )
  } else {
    renderCoverageVerifyHuman(result, totalsLine, verifyFile)
  }
  if (!result.ok) process.exitCode = 1
}

function reportCoverageClean(
  report: CoverageReport,
  totalsLine: string,
  json: boolean,
  deps: JourneysModule,
): void {
  if (json) {
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
  console.log(JSON.stringify(deps.coverageBaseline(report), null, 2))
}

async function runJourneyCoverage(opts: {
  json?: boolean
  verifyFile?: string
  dir?: string
  waivers?: string
  out?: string
  quarantined?: string
}): Promise<void> {
  const deps = await import("@ibatexas/journeys")
  const { computeJourneyCoverage } = deps

  const report = await computeJourneyCoverage({
    ...(opts.dir === undefined ? {} : { dir: resolveUserPath(opts.dir) }),
    ...(opts.waivers === undefined ? {} : { waiversPath: resolveUserPath(opts.waivers) }),
    ...(opts.quarantined === undefined
      ? {}
      : {
          quarantined: opts.quarantined
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }),
  })

  // ── Problemas (registry/waivers quebrados) → exit 1 ────────────────────
  if (!report.ok) {
    reportCoverageProblems(report, opts.json === true)
    process.exitCode = 1
    return
  }

  // ── --out: grava as duas views (matriz célula-a-célula + journey-pass) ─
  if (opts.out !== undefined) {
    await writeCoverageViews(report, resolveUserPath(opts.out), opts.json === true, deps)
  }

  const t = report.totals
  const totalsLine =
    `${t.covered}/${t.cells} células cobertas, ${t.uncovered} descobertas, ` +
    `waived: ${t["waived-pending-WS4"]} pending-WS4 / ` +
    `${t["waived-unadvertised"]} unadvertised / ` +
    `${t["waived-quarantined"]} quarantined`

  // ── Verificação de baseline (regressão covered→uncovered) ──────────────
  if (opts.verifyFile !== undefined) {
    await verifyCoverageCli(report, opts.verifyFile, totalsLine, opts.json === true, deps)
    return
  }

  // ── Saída limpa ─────────────────────────────────────────────────────────
  reportCoverageClean(report, totalsLine, opts.json === true, deps)
}

// ── `ibx journey extraction-accuracy` (T07, FE-2.3/FE-2.4) ─────────────────
// THIN registration: all composition lives in `@ibatexas/journeys`
// (`src/extraction/accuracy-cli.ts` drives the live run;
// `src/extraction/accuracy.ts` scores it + owns the baseline/waiver gate —
// the coverage command's EXACT --json/--verify-file/--waivers/--out idiom,
// re-keyed to extraction CASES (`capability:caseId`) instead of coverage
// CELLS. Quarantine reuses `ibx journey flake --ledger <path>
// --list-quarantined` unchanged — see accuracy.ts's header, no new ledger.

type AccuracyCliResult = Awaited<ReturnType<JourneysModule["runExtractionAccuracyCli"]>>
type AccuracyReport = AccuracyCliResult["report"]
type AccuracyVerifyResult = ReturnType<JourneysModule["verifyAccuracyBaseline"]>

function formatAccuracyTotalsLine(report: AccuracyReport): string {
  if (report.byCapability.length === 0) return "0 casos rodados"
  return report.byCapability
    .map((c) => `${c.capability}: ${c.passing}/${c.total} (${(c.ratio * 100).toFixed(1)}%)`)
    .join(", ")
}

function reportAccuracyProblems(report: AccuracyReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  for (const p of report.problems) {
    console.error(chalk.red(`✗ ${p.file}: ${p.code} — ${p.message}`))
  }
}

async function writeAccuracyViews(
  report: AccuracyReport,
  outDir: string,
  json: boolean,
): Promise<void> {
  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(outDir, "accuracy-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  await writeFile(
    join(outDir, "accuracy-summary.json"),
    `${JSON.stringify(report.byCapability, null, 2)}\n`,
  )
  if (!json) {
    console.log(
      chalk.dim(`views gravadas em ${outDir}/accuracy-report.json + accuracy-summary.json`),
    )
  }
}

function renderAccuracyVerifyHuman(
  result: AccuracyVerifyResult,
  totalsLine: string,
  verifyFile: string,
): void {
  for (const r of result.regressions) {
    console.error(chalk.red(`✗ regressão: ${r.case} estava passing na baseline, agora ${r.state}`))
  }
  for (const key of result.quarantinedClaims) {
    console.warn(chalk.yellow(`⚠ ${key} passing na baseline, agora waived-quarantined (flake ledger)`))
  }
  for (const key of result.waivedClaims) {
    console.warn(chalk.yellow(`⚠ ${key} passing na baseline, agora coberto por waiver`))
  }
  if (result.newlyPassing.length > 0) {
    console.log(
      chalk.dim(
        `${result.newlyPassing.length} caso(s) passing ainda fora da baseline — atualize ${verifyFile} para reivindicá-los.`,
      ),
    )
  }
  if (result.ok) {
    console.log(chalk.green(`✓ Sem regressão de acurácia. ${totalsLine}`))
  } else {
    console.error(chalk.red(`${result.regressions.length} regressão(ões) de acurácia. ${totalsLine}`))
  }
}

async function verifyAccuracyCli(
  report: AccuracyReport,
  verifyFile: string,
  totalsLine: string,
  json: boolean,
  deps: JourneysModule,
): Promise<void> {
  const verifyPath = resolveUserPath(verifyFile)
  let baselineRaw: unknown
  try {
    baselineRaw = JSON.parse(await readFile(verifyPath, "utf-8"))
  } catch {
    console.error(chalk.red(`Baseline ilegível: ${verifyPath}`))
    process.exitCode = 1
    return
  }
  const baselineParsed = deps.AccuracyBaselineSchema.safeParse(baselineRaw)
  if (!baselineParsed.success) {
    console.error(chalk.red(`Baseline inválida (${verifyFile}): esperado {"passing": [...]}`))
    process.exitCode = 1
    return
  }
  const result = deps.verifyAccuracyBaseline(report, baselineParsed.data)

  if (json) {
    console.log(JSON.stringify({ ...report, verify: { file: verifyFile, ...result } }, null, 2))
  } else {
    renderAccuracyVerifyHuman(result, totalsLine, verifyFile)
  }
  if (!result.ok) process.exitCode = 1
}

function reportAccuracyClean(report: AccuracyReport, totalsLine: string, json: boolean, deps: JourneysModule): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(chalk.green(`✓ ${totalsLine}`))
  if (report.dormantWaivers.length > 0) {
    console.log(
      chalk.dim(
        `waivers dormentes (capability/caseId fora do corpus atual): ${report.dormantWaivers
          .map((w) => `${w.capability}${w.caseId ? `:${w.caseId}` : ""}`)
          .join(", ")}`,
      ),
    )
  }
  console.log()
  console.log(
    chalk.dim("baseline (packages/journeys/governance/extraction-accuracy-baseline.json):"),
  )
  console.log(JSON.stringify(deps.accuracyBaseline(report), null, 2))
}

async function runJourneyExtractionAccuracy(opts: {
  json?: boolean
  verifyFile?: string
  corpusDir?: string
  apiBaseUrl?: string
  envFile?: string
  waivers?: string
  out?: string
  quarantined?: string
}): Promise<void> {
  const deps = await import("@ibatexas/journeys")
  const { runExtractionAccuracyCli, ExtractionAccuracyCliError } = deps

  const onProgress = (line: string): void => {
    if (opts.json === true) process.stderr.write(`${line}\n`)
    else console.log(chalk.dim(line))
  }

  try {
    const { report } = await runExtractionAccuracyCli({
      ...(opts.corpusDir === undefined ? {} : { corpusDir: resolveUserPath(opts.corpusDir) }),
      ...(opts.apiBaseUrl === undefined ? {} : { apiBaseUrl: opts.apiBaseUrl }),
      ...(opts.envFile === undefined
        ? { envFile: resolveUserPath(join(MONOREPO_ROOT, ".env.test")) }
        : { envFile: resolveUserPath(opts.envFile) }),
      ...(opts.waivers === undefined ? {} : { waiversPath: resolveUserPath(opts.waivers) }),
      ...(opts.quarantined === undefined ? {} : { quarantined: parseIdList(opts.quarantined) }),
      onProgress,
    })

    if (!report.ok) {
      reportAccuracyProblems(report, opts.json === true)
      process.exitCode = 1
      return
    }

    if (opts.out !== undefined) {
      await writeAccuracyViews(report, resolveUserPath(opts.out), opts.json === true)
    }

    const totalsLine = formatAccuracyTotalsLine(report)

    if (opts.verifyFile !== undefined) {
      await verifyAccuracyCli(report, opts.verifyFile, totalsLine, opts.json === true, deps)
      return
    }

    reportAccuracyClean(report, totalsLine, opts.json === true, deps)
  } catch (err) {
    if (err instanceof ExtractionAccuracyCliError) {
      console.error(chalk.red(err.message))
      process.exitCode = 1
      return
    }
    throw err
  }
}

// ── `ibx journey migrate` (T1b-5) ───────────────────────────────────────────
// Aplica a camada sim do plano de teste (sim_runs/sim_results — registros
// persistentes de execução, juntáveis ao intent_audit via os namespaces de
// sessionId HASHEADOS) em DATABASE_URL. Passo DEDICADO, não dobrado em
// `ibx db provision`: a camada sim é exclusiva do test plane e `db provision`
// também roda contra bancos dev/prod (escolha registrada — T1b-5). Conecta
// como o papel de migração (DATABASE_URL); o papel de ESCRITA do runtime
// (ibx_sim_writer, INSERT/UPDATE somente em sim_*) é provisionado por
// scripts/test-stack/provision-sim-writer-role.sh DEPOIS deste comando.

async function runJourneyMigrate(): Promise<void> {
  const { migrateSimTables } = await import("@ibatexas/journeys")
  const { default: pg } = await import("pg")

  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(chalk.red("DATABASE_URL não definido — rode `ibx env check`"))
    process.exitCode = 1
    return
  }

  const client = new pg.Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    const result = await migrateSimTables(client, {
      log: (msg: string) => console.log(chalk.dim(`  ${msg}`)),
    })
    const applied =
      result.applied.length > 0 ? `${result.applied.length} aplicada(s)` : "em dia"
    console.log(
      chalk.green(
        `✓ camada sim (sim_runs/sim_results): ${applied}, ${result.skipped.length} já aplicada(s)`,
      ),
    )
  } catch (err) {
    console.error(chalk.red(`✗ journey migrate falhou: ${(err as Error).message}`))
    process.exitCode = 1
  } finally {
    await client.end().catch(() => undefined)
  }
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
  // T1b-4 — nightly mode (retry-once amarelo + flake ledger + quarentena)
  nightly?: boolean
  retryDelaySeconds?: string
}

function parseIdList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

type NightlyReport = Awaited<ReturnType<JourneysModule["runNightlySuiteCli"]>>
type SuiteReport = Awaited<ReturnType<JourneysModule["runJourneySuiteCli"]>>
type SingleReport = Awaited<ReturnType<JourneysModule["runJourneyCli"]>>

function formatNightlyOutcome(o: NightlyReport["outcomes"][number]): string {
  if (o.outcome === "green") return chalk.green(`✓ ${o.journey}: GREEN`)
  if (o.outcome === "yellow") {
    return chalk.yellow(`⚠ ${o.journey}: YELLOW (failed once, passed the retry)`)
  }
  let suffix = ""
  if (o.abortedByBudget) suffix = " (aborted-by-budget)"
  else if (o.retried) suffix = " (failed twice)"
  return chalk.red(`✗ ${o.journey}: RED${suffix}`)
}

function renderNightlyReport(report: NightlyReport): void {
  for (const skipped of report.quarantinedSkipped) {
    console.log(chalk.yellow(`⊘ ${skipped}: QUARANTINED — skipped (flake ledger)`))
  }
  for (const o of report.outcomes) {
    console.log(formatNightlyOutcome(o))
  }
  if (report.ledger.changed) {
    const newlyQuarantined =
      report.ledger.newlyQuarantined.length > 0
        ? ` — newly quarantined: ${report.ledger.newlyQuarantined.join(", ")}`
        : ""
    console.log(chalk.dim(`flake ledger UPDATED (${report.ledger.path})${newlyQuarantined}`))
  }
  for (const issue of report.issues) {
    console.error(chalk.red(`issue: ${issue.title}`))
  }
  console.log(
    report.pass
      ? chalk.green(`✓ nightly green (${report.outcomes.length} journeys, ${report.date})`)
      : chalk.red(`✗ nightly RED (${report.date})`),
  )
}

function renderSuiteReport(report: SuiteReport): void {
  for (const j of report.journeys) {
    const aborted = j.status === "aborted-by-budget"
    const failLabel = aborted ? "ABORTED-BY-BUDGET" : "FAIL"
    const head = j.pass
      ? chalk.green(`✓ ${j.journey}: PASS`)
      : chalk.red(`✗ ${j.journey}: ${failLabel}`)
    const greenCount = `${j.attempts.filter((a) => a.pass).length}/${j.k} green`
    const detail = chalk.dim(`(${greenCount})`)
    console.log(`${head} ${detail}`)
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
      : chalk.red(
          `✗ suite RED (${report.journeys.filter((j) => j.pass).length}/${report.journeys.length} green)`,
        ),
  )
}

function renderSingleReport(report: SingleReport): void {
  for (const attempt of report.attempts) {
    const failLabel =
      attempt.status === "aborted-by-budget" ? "ABORTED-BY-BUDGET" : "FAIL"
    const head = attempt.pass
      ? chalk.green(`✓ attempt ${attempt.attempt}: PASS`)
      : chalk.red(`✗ attempt ${attempt.attempt}: ${failLabel}`)
    const meta = `runId=${attempt.runId} turns=${attempt.turns} ${(attempt.durationMs / 1000).toFixed(1)}s ${attempt.certifying ? "certifying" : "NON-certifying"}`
    console.log(`${head} ${chalk.dim(meta)}`)
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
      : chalk.red(
          `✗ ${report.journey} failed (${report.attempts.filter((a) => a.pass).length}/${report.k} green)`,
        ),
  )
}

// ── Nightly path (T1b-4): suite + retry-once + flake ledger ─────────────
// SOMENTE o modo nightly lê/escreve o flake ledger — runs locais de
// suíte nunca mutam o estado de quarentena.
async function runNightlyPath(
  id: string | undefined,
  opts: JourneyRunCliFlags,
  deps: JourneysModule,
  k: number,
  budgetUsd: number | undefined,
  onProgress: (line: string) => void,
): Promise<void> {
  if (opts.suite !== true || id !== undefined) {
    console.error(chalk.red("--nightly requer --suite (e não combina com <id>)"))
    process.exitCode = 1
    return
  }
  const report = await deps.runNightlySuiteCli({
    ...(opts.only === undefined ? {} : { only: parseIdList(opts.only) }),
    k,
    ...(opts.kMoney === undefined ? {} : { kMoney: Number.parseInt(opts.kMoney, 10) }),
    ...(opts.moneyFlows === undefined ? {} : { moneyFlows: parseIdList(opts.moneyFlows) }),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(opts.retryDelaySeconds === undefined
      ? {}
      : { retryDelaySeconds: Number.parseInt(opts.retryDelaySeconds, 10) }),
    ...(opts.dir === undefined ? {} : { dir: resolveUserPath(opts.dir) }),
    ...(opts.envFile === undefined ? {} : { envFile: resolveUserPath(opts.envFile) }),
    onProgress,
  })

  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    renderNightlyReport(report)
  }
  if (!report.pass) process.exitCode = 1
}

// ── Suite path (T1b-8): all active journeys, sequential, dollar-capped ──
async function runSuitePath(
  id: string | undefined,
  opts: JourneyRunCliFlags,
  deps: JourneysModule,
  k: number,
  budgetUsd: number | undefined,
  onProgress: (line: string) => void,
): Promise<void> {
  if (id !== undefined) {
    console.error(
      chalk.red("--suite roda todas as jornadas ativas — não combine com <id> (use --only)"),
    )
    process.exitCode = 1
    return
  }
  const report = await deps.runJourneySuiteCli({
    ...(opts.only === undefined ? {} : { only: parseIdList(opts.only) }),
    k,
    ...(opts.kMoney === undefined ? {} : { kMoney: Number.parseInt(opts.kMoney, 10) }),
    ...(opts.moneyFlows === undefined ? {} : { moneyFlows: parseIdList(opts.moneyFlows) }),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(opts.dir === undefined ? {} : { dir: resolveUserPath(opts.dir) }),
    ...(opts.envFile === undefined ? {} : { envFile: resolveUserPath(opts.envFile) }),
    onProgress,
  })

  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    renderSuiteReport(report)
  }
  if (!report.pass) process.exitCode = 1
}

// ── Single-journey path (T1a-13; budget applies to the --k loop too) ────
async function runSinglePath(
  id: string,
  opts: JourneyRunCliFlags,
  deps: JourneysModule,
  k: number,
  budgetUsd: number | undefined,
  onProgress: (line: string) => void,
): Promise<void> {
  const report = await deps.runJourneyCli({
    journeyId: id,
    k,
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(opts.dir === undefined ? {} : { dir: resolveUserPath(opts.dir) }),
    ...(opts.envFile === undefined ? {} : { envFile: resolveUserPath(opts.envFile) }),
    onProgress,
  })

  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    renderSingleReport(report)
  }
  if (!report.pass) process.exitCode = 1
}

async function runJourneyRun(id: string | undefined, opts: JourneyRunCliFlags): Promise<void> {
  const deps = await import("@ibatexas/journeys")
  const { JourneyRunCliError, BudgetConfigError, FlakeLedgerError } = deps

  const k = opts.k === undefined ? 1 : Number.parseInt(opts.k, 10)
  const budgetUsd = opts.budgetUsd === undefined ? undefined : Number.parseFloat(opts.budgetUsd)
  // Progress lines stream to stderr so --json keeps stdout machine-clean.
  const onProgress = (line: string): void => {
    if (opts.json === true) process.stderr.write(`${line}\n`)
    else console.log(chalk.dim(line))
  }

  try {
    if (opts.nightly === true) {
      await runNightlyPath(id, opts, deps, k, budgetUsd, onProgress)
      return
    }

    if (opts.suite === true) {
      await runSuitePath(id, opts, deps, k, budgetUsd, onProgress)
      return
    }

    if (id === undefined) {
      console.error(chalk.red("informe uma jornada (<id>) ou rode a suíte com --suite"))
      process.exitCode = 1
      return
    }
    await runSinglePath(id, opts, deps, k, budgetUsd, onProgress)
  } catch (err) {
    if (
      err instanceof JourneyRunCliError ||
      err instanceof BudgetConfigError ||
      err instanceof FlakeLedgerError
    ) {
      console.error(chalk.red(err.message))
      process.exitCode = 1
      return
    }
    throw err
  }
}

// ── `ibx journey flake` (T1b-4) ─────────────────────────────────────────────
// Leitura/escrita do flake ledger (packages/journeys/governance/
// flake-ledger.json — a lista de quarentena autoritativa do nightly).
//   (sem flags)            resumo humano das entradas
//   --list-quarantined     ids em quarentena, separados por vírgula (stdout
//                          limpo — o workflow nightly alimenta
//                          `ibx journey coverage --quarantined` com isso)
//   --dequarantine <id>    de-quarentena MANUAL: o critério documentado é
//                          verde duas vezes em re-run manual
//                          (`ibx journey run <id> --k 2 --json`) ANTES de
//                          rodar este comando — quem roda está atestando.

async function runJourneyFlake(opts: {
  json?: boolean
  dequarantine?: string
  listQuarantined?: boolean
  ledger?: string
}): Promise<void> {
  const {
    dequarantineJourney,
    DEFAULT_FLAKE_LEDGER_PATH,
    FlakeLedgerError,
    loadFlakeLedger,
    quarantinedJourneyIds,
    saveFlakeLedger,
  } = await import("@ibatexas/journeys")

  const ledgerPath =
    opts.ledger === undefined ? DEFAULT_FLAKE_LEDGER_PATH : resolveUserPath(opts.ledger)
  try {
    const ledger = loadFlakeLedger(ledgerPath)

    if (opts.listQuarantined === true) {
      // Machine-clean stdout for the nightly's coverage seam (empty = none).
      console.log(quarantinedJourneyIds(ledger).join(","))
      return
    }

    if (opts.dequarantine !== undefined) {
      const next = dequarantineJourney(ledger, opts.dequarantine)
      saveFlakeLedger(next, ledgerPath)
      console.log(
        chalk.green(
          `✓ ${opts.dequarantine} removido da quarentena (${ledgerPath}) — commit o ledger atualizado.`,
        ),
      )
      return
    }

    if (opts.json === true) {
      console.log(JSON.stringify(ledger, null, 2))
      return
    }
    const entries = Object.values(ledger.journeys)
    if (entries.length === 0) {
      console.log(chalk.green("✓ flake ledger vazio — nenhuma jornada flaky ou em quarentena."))
      return
    }
    for (const e of entries) {
      const head =
        e.status === "quarantined"
          ? chalk.red(`⊘ ${e.journey}: quarantined desde ${e.quarantinedAt ?? "?"}`)
          : chalk.yellow(`⚠ ${e.journey}: flaky (${e.consecutiveFlakyNights} noite(s) consecutiva(s))`)
      const detail = chalk.dim(
        `firstSeen=${e.firstSeen} lastFlakyNight=${e.lastFlakyNight} owner=${e.owner === "" ? "UNASSIGNED" : e.owner}`,
      )
      console.log(`${head} ${detail}`)
    }
  } catch (err) {
    if (err instanceof FlakeLedgerError) {
      console.error(chalk.red(err.message))
      process.exitCode = 1
      return
    }
    throw err
  }
}

// ── `ibx journey from-audit` (T2-3) ─────────────────────────────────────────
// THIN registration: toda a lógica vive em @ibatexas/journeys
// (src/schema/scaffold.ts). O operador passa o sessionId BRUTO do chat
// (`ibx chat list`); o scaffolder re-deriva o namespace de auditoria HASHEADO
// (D-012: session_id = "hashed:" + sha256(raw + AUDIT_REDACT_SECRET)[0..8]),
// então o comando RODA CONTRA O ENV DE TESTE/OPS que carrega o MESMO
// AUDIT_REDACT_SECRET do audit sink do stack (default: <repo>/.env.test;
// --env-file para um env de ops) + ORACLE_DATABASE_URL (papel SELECT-only).
// O scaffold nasce status: blocked, blocked_by: [scaffold-review] — um
// scaffold nunca nasce ativo.

/** Resolve um caminho de SAÍDA (o arquivo ainda não existe — ancora no diretório). */
function resolveOutPath(p: string): string {
  if (isAbsolute(p)) return p
  const fromCwd = resolve(process.cwd(), p)
  if (existsSync(dirname(fromCwd))) return fromCwd
  const fromRoot = resolve(MONOREPO_ROOT, p)
  return existsSync(dirname(fromRoot)) ? fromRoot : fromCwd
}

async function runJourneyFromAudit(
  sessionId: string,
  opts: { out?: string; envFile?: string; transcript?: string },
): Promise<void> {
  const {
    FromAuditScaffoldError,
    loadTestEnv,
    OracleDatabaseUrlError,
    scaffoldFromAuditSession,
    transcriptFromChatDumpJson,
  } = await import("@ibatexas/journeys")

  // Contrato de env do plano de teste (mesma semântica de `journey run`):
  // .env.test é autoritativo — AUDIT_REDACT_SECRET + ORACLE_DATABASE_URL.
  const envFile =
    opts.envFile === undefined ? join(MONOREPO_ROOT, ".env.test") : resolveUserPath(opts.envFile)
  try {
    const loaded = loadTestEnv(envFile)
    console.error(
      chalk.dim(
        `env: ${envFile} (${loaded.injected.length} injected, ${loaded.overridden.length} overridden, ${loaded.identical.length} identical)`,
      ),
    )
  } catch {
    console.error(chalk.dim(`env: ${envFile} not readable — relying on the shell environment`))
  }

  try {
    const transcript =
      opts.transcript === undefined
        ? undefined
        : transcriptFromChatDumpJson(await readFile(resolveUserPath(opts.transcript), "utf-8"))
    const result = await scaffoldFromAuditSession(sessionId, {
      ...(transcript === undefined ? {} : { transcript }),
    })
    // Resumo no stderr — stdout fica limpo para pipe do YAML.
    console.error(
      chalk.dim(
        `audit namespace: ${result.hashedSessionId} (D-012) — ${result.auditRows} envelope row(s) → ` +
          `${result.expectTuples} expect tuple(s), ${result.chatActs} chat act(s)`,
      ),
    )
    if (opts.out === undefined) {
      process.stdout.write(result.yaml)
    } else {
      const outPath = resolveOutPath(opts.out)
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, result.yaml)
      console.log(
        chalk.green(
          `✓ scaffold written: ${outPath} (status: blocked, blocked_by: [scaffold-review]) — review before activation`,
        ),
      )
    }
  } catch (err) {
    if (err instanceof FromAuditScaffoldError || err instanceof OracleDatabaseUrlError) {
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
    .command("migrate")
    .description(
      "Aplica a camada sim do test plane (sim_runs/sim_results — packages/journeys/migrations/, ledger apply-once journeys_sim_migrations) em DATABASE_URL. Idempotente; invocado por scripts/test-stack-up.sh antes do papel ibx_sim_writer.",
    )
    .action(async () => {
      await runJourneyMigrate()
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
    .option(
      "--nightly",
      "Com --suite: modo nightly (T1b-4) — retry-once = amarelo, flake ledger (quarentena após 2 noites flaky consecutivas), payloads de gh issue para runs vermelhos. SOMENTE este modo lê/escreve o ledger.",
    )
    .option(
      "--retry-delay-seconds <n>",
      "Com --nightly: espera antes do único retry (default 0; o nightly usa 600 — janela do rate limit de cancelamento, 5/10min/cliente)",
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
    .command("flake")
    .description(
      "Flake ledger do nightly (T1b-4; packages/journeys/governance/flake-ledger.json). Sem flags: resumo. --list-quarantined: ids em quarentena (vírgula, stdout limpo). --dequarantine <id>: de-quarentena manual — critério documentado: `ibx journey run <id> --k 2 --json` verde DUAS vezes antes deste comando.",
    )
    .option("--json", "Emite o ledger em JSON")
    .option(
      "--list-quarantined",
      "Imprime os ids em quarentena separados por vírgula (consumido pelo workflow nightly: `ibx journey coverage --quarantined ...`)",
    )
    .option(
      "--dequarantine <id>",
      "Remove a jornada da quarentena (recusa entradas não-quarantined; flaky se resolve com noite verde)",
    )
    .option(
      "--ledger <path>",
      "Arquivo de ledger alternativo (default: packages/journeys/governance/flake-ledger.json)",
    )
    .action(
      async (opts: {
        json?: boolean
        dequarantine?: string
        listQuarantined?: boolean
        ledger?: string
      }) => {
        await runJourneyFlake(opts)
      },
    )

  group
    .command("from-audit <sessionId>")
    .description(
      "Scaffolda um journey YAML a partir de um slice de auditoria de produção (T2-3): transcript (ibx_domain.conversations, mesmo material de `ibx chat dump --json`) + linhas do intent_audit no namespace HASHEADO da sessão (D-012). Recebe o sessionId BRUTO do chat (`ibx chat list`) e re-deriva o hash com AUDIT_REDACT_SECRET — roda contra o env de teste/ops que carrega o secret do stack (default <repo>/.env.test) + ORACLE_DATABASE_URL (papel SELECT-only). O scaffold nasce status: blocked, blocked_by: [scaffold-review].",
    )
    .option("--out <file>", "Grava o scaffold no arquivo (default: stdout; resumo sempre no stderr)")
    .option(
      "--transcript <file>",
      "Transcript alternativo: arquivo JSON no formato de `ibx chat dump <id> --json` (sessões só-Redis sem linha em conversations)",
    )
    .option(
      "--env-file <path>",
      "Arquivo .env do stack de teste/ops (default: <repo>/.env.test; precisa de AUDIT_REDACT_SECRET + ORACLE_DATABASE_URL)",
    )
    .action(
      async (sessionId: string, opts: { out?: string; envFile?: string; transcript?: string }) => {
        await runJourneyFromAudit(sessionId, opts)
      },
    )

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

  group
    .command("extraction-accuracy")
    .description(
      "Meter de acurácia de extração (FE-2.3/FE-2.4, FE-T07): roda o corpus de extração (packages/journeys/extraction-corpus/*.yaml) contra o modelo AO VIVO via o canal ops-chat, materializa ExtractionIR/HydratedIntentIR via o audit-reader oracle, e reporta acurácia por capability. --verify-file falha (exit 1) em regressão passing→not-passing contra a baseline; waivers em packages/journeys/governance/extraction-accuracy-waivers.json; quarentena via `ibx journey flake --ledger <path> --list-quarantined` (mesma máquina do flake ledger, arquivo distinto).",
    )
    .option("--json", "Emite o relatório de acurácia em JSON")
    .option(
      "--verify-file <path>",
      "Compara os casos passing contra a baseline commitada (CI gate; exit 1 em regressão)",
    )
    .option(
      "--corpus-dir <path>",
      "Diretório alternativo do corpus de extração (default: packages/journeys/extraction-corpus/)",
    )
    .option(
      "--api-base-url <url>",
      "Base da API AO VIVO a driblar (default: IBX_TEST_API_URL ou http://localhost:3001)",
    )
    .option(
      "--env-file <path>",
      "Arquivo .env do stack de teste (default: <repo>/.env.test; shell env tem precedência)",
    )
    .option(
      "--waivers <path>",
      "Arquivo de waivers alternativo (default: packages/journeys/governance/extraction-accuracy-waivers.json)",
    )
    .option(
      "--out <dir>",
      "Grava as duas views (accuracy-report.json + accuracy-summary.json) no diretório",
    )
    .option(
      "--quarantined <ids>",
      "Case keys (<capability>:<caseId>) em quarentena, separados por vírgula (seam — o flake ledger é a fonte autoritativa)",
    )
    .action(
      async (opts: {
        json?: boolean
        verifyFile?: string
        corpusDir?: string
        apiBaseUrl?: string
        envFile?: string
        waivers?: string
        out?: string
        quarantined?: string
      }) => {
        await runJourneyExtractionAccuracy(opts)
      },
    )
}
