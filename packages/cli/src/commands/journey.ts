// `ibx journey` — gates da Journey Registry (plano de teste, Fase 1a).
//
// THIN registration only: toda a lógica de lint vive em
// `@ibatexas/journeys` (`src/gates/lint.ts`) — este arquivo apenas registra
// o comando e formata a saída. Vocabulário: "journey" (jornada LLM-driven,
// novo plano de teste) ≠ "ibx scenario" (o engine de data-state existente —
// intocado).
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

import { readFile } from "node:fs/promises"
import type { Command } from "commander"
import chalk from "chalk"

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
}
