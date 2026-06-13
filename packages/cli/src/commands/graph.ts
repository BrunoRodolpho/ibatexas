// `ibx graph` — grafos derivados do plano de teste (T2-4).
//
// THIN registration only: toda a lógica vive em `@ibatexas/journeys`
// (`src/graphs/` — contrato compartilhado + quatro geradores + engine de
// export/check). Este arquivo apenas registra o comando e formata a saída
// (mesmo idioma de packages/cli/src/commands/journey.ts).
//
//   ibx graph export             → regenera os QUATRO grafos derivados em
//                                  packages/journeys/graphs/ (artefatos
//                                  commitados — nunca editados à mão)
//   ibx graph export --check     → regenera em memória e compara byte a byte
//                                  com os artefatos commitados; exit 1 em
//                                  qualquer drift/ausência (o CI gate
//                                  regenerate-and-diff — graphs-gate.yml)
//   ibx graph export --capture-impact
//                                → agrega a janela do intent_audit
//                                  ($DATABASE_URL, EXCLUINDO o namespace de
//                                  agente "agent:" — mesmo filtro do replay
//                                  gate T1b-3) no fixture commitado e então
//                                  regenera os grafos
//
// Dependência cli→journeys é a direção sancionada; import dinâmico para não
// pesar o startup do ibx. Saída de dev/CI em inglês (convenção do plano de
// teste), descrições pt-BR.

import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Command } from "commander"
import chalk from "chalk"

// Raiz do monorepo ancorada neste arquivo (idioma de commands/journey.ts).
const MONOREPO_ROOT = resolve(
  dirname(realpathSync(fileURLToPath(import.meta.url))),
  "../../../..",
)

function resolveUserPath(p: string): string {
  if (isAbsolute(p)) return p
  const fromCwd = resolve(process.cwd(), p)
  if (existsSync(fromCwd)) return fromCwd
  const fromRoot = resolve(MONOREPO_ROOT, p)
  return existsSync(fromRoot) ? fromRoot : fromCwd
}

/** Parses "24h" / "30m" / "7d" / "60s" → ms (mirror of kernel.ts's helper). */
function parseDuration(input: string): number {
  const m = /^(\d+)([dhms])$/.exec(input.trim())
  if (!m) {
    throw new Error(
      `Duração inválida: "${input}". Use formato '24h', '30m', '7d', '60s'.`,
    )
  }
  const n = Number.parseInt(m[1]!, 10)
  const multiplier =
    m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1_000
  return n * multiplier
}

interface GraphExportFlags {
  check?: boolean
  json?: boolean
  only?: string
  dir?: string
  journeysDir?: string
  runTrace?: string
  runDecisions?: string
  captureImpact?: boolean
  since?: string
}

async function runGraphExport(opts: GraphExportFlags): Promise<void> {
  const {
    exportGraphs,
    fetchImpactWindow,
    writeImpactWindowFixture,
    GraphExportError,
    GRAPH_NAMES,
  } = await import("@ibatexas/journeys")

  try {
    // ── --capture-impact: live/seeded audit DB → committed window fixture ──
    if (opts.captureImpact === true) {
      if (opts.check === true) {
        console.error(
          chalk.red("--capture-impact não combina com --check (o check nunca escreve)"),
        )
        process.exitCode = 1
        return
      }
      const databaseUrl = process.env.DATABASE_URL
      if (databaseUrl === undefined || databaseUrl === "") {
        console.error(
          chalk.red("DATABASE_URL não definido — a captura agrega o intent_audit ao vivo."),
        )
        process.exitCode = 1
        return
      }
      const sinceMs = parseDuration(opts.since ?? "24h")
      const toIso = new Date().toISOString()
      const fromIso = new Date(Date.now() - sinceMs).toISOString()

      const { default: pg } = await import("pg")
      const client = new pg.Client({ connectionString: databaseUrl })
      await client.connect()
      let fixturePath: string
      let excludedAgentRows: number
      let rowCount: number
      try {
        const window = await fetchImpactWindow(client, {
          fromIso,
          toIso,
          source: "test-stack intent_audit aggregation (ibx graph export --capture-impact)",
        })
        excludedAgentRows = window.excludedAgentRows
        rowCount = window.rows.length
        fixturePath = await writeImpactWindowFixture(
          {
            comment: [
              "T2-4 impact-window fixture — kind×decision counts aggregated from a",
              "test-stack intent_audit window, EXCLUDING the 'agent:' session",
              "namespace (same filter as the T1b-3 kernel-replay gate; the exclusion",
              "count is reported, never silent). Captured via `ibx graph export",
              "--capture-impact` against a golden-vector-seeded audit database; the",
              "committed impact.json regenerates from THIS file so the drift gate",
              "stays deterministic and DB-free. Recapture + regenerate together.",
            ],
            ...window,
          },
          opts.dir !== undefined ? resolveUserPath(opts.dir) : undefined,
        )
      } finally {
        await client.end().catch(() => undefined)
      }
      if (opts.json !== true) {
        console.log(
          chalk.dim(
            `impact window captured -> ${fixturePath} (${rowCount} kind×decision rows, ` +
              `${excludedAgentRows} agent-namespace row(s) excluded)`,
          ),
        )
      }
    }

    const report = await exportGraphs({
      ...(opts.check === true ? { check: true } : {}),
      ...(opts.dir !== undefined ? { graphsDir: resolveUserPath(opts.dir) } : {}),
      ...(opts.journeysDir !== undefined
        ? { journeysDir: resolveUserPath(opts.journeysDir) }
        : {}),
      ...(opts.runTrace !== undefined ? { runTracePath: resolveUserPath(opts.runTrace) } : {}),
      ...(opts.runDecisions !== undefined
        ? { runDecisionsPath: resolveUserPath(opts.runDecisions) }
        : {}),
      ...(opts.only !== undefined
        ? {
            only: opts.only
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0) as (typeof GRAPH_NAMES)[number][],
          }
        : {}),
    })

    if (opts.json === true) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      for (const entry of report.graphs) {
        const line = `${entry.graph} (${entry.file}): ${entry.nodes} nodes, ${entry.edges} edges`
        if (entry.status === "written") {
          console.log(chalk.green(`✓ ${line} — written`))
        } else if (entry.status === "clean") {
          console.log(chalk.green(`✓ ${line} — clean`))
        } else {
          console.error(chalk.red(`✗ ${line} — ${entry.status.toUpperCase()}`))
        }
      }
      if (report.mode === "check") {
        console.log(
          report.ok
            ? chalk.green("✓ committed graphs are current (regenerate-and-diff clean)")
            : chalk.red(
                "✗ graph drift — os grafos são DERIVADOS: rode `ibx graph export` e commit o diff " +
                  "(nunca edite os .json à mão; packages/journeys/graphs/README.md)",
              ),
        )
      } else {
        console.log(chalk.dim(`graphs dir: ${report.graphsDir}`))
      }
    }
    if (!report.ok) process.exitCode = 1
  } catch (err) {
    if (err instanceof Error && err.name === "GraphExportError") {
      console.error(chalk.red(err.message))
      process.exitCode = 1
      return
    }
    // Re-check via the imported class for robustness across module copies.
    if (err instanceof GraphExportError) {
      console.error(chalk.red(err.message))
      process.exitCode = 1
      return
    }
    throw err
  }
}

export function registerGraphCommands(group: Command): void {
  group.description(
    "Graphs — grafos derivados do plano de teste (capability/journeys/run/impact; T2-4). " +
      "Artefatos commitados em packages/journeys/graphs/ — nunca editados à mão.",
  )

  group
    .command("export")
    .description(
      "Regenera os quatro grafos derivados (capability: packs→intents→tools/planners com flags dangling/unadvertised; " +
        "journeys: registry→acts→kind×decision + gaps de bloqueio; run: trace fixture→envelopes→decisões; " +
        "impact: agregação do intent_audit excluindo o namespace 'agent:'). " +
        "--check regenera em memória e diffa contra os commitados (exit 1 em drift — o CI gate).",
    )
    .option("--check", "Regenerate-and-diff contra os artefatos commitados (nunca escreve)")
    .option("--json", "Emite o relatório em JSON (stdout limpo)")
    .option(
      "--only <names>",
      "Restringe aos grafos listados (capability,journeys,run,impact — vírgula)",
    )
    .option(
      "--dir <path>",
      "Diretório de grafos alternativo (default: packages/journeys/graphs/)",
    )
    .option(
      "--journeys-dir <path>",
      "Registry de jornadas alternativo (default: packages/journeys/journeys/)",
    )
    .option(
      "--run-trace <path>",
      "Trace JSONL de um run real para o grafo run (debug; recusado com --check)",
    )
    .option(
      "--run-decisions <path>",
      "Decisões observadas do run (shape do join sim_runs; recusado com --check)",
    )
    .option(
      "--capture-impact",
      "Antes de exportar: agrega a janela do intent_audit ($DATABASE_URL, excluindo 'agent:') no fixture commitado",
    )
    .option(
      "--since <duration>",
      "Janela da captura de impacto (default 24h; formato 24h/30m/7d)",
    )
    .action(async (opts: GraphExportFlags) => {
      await runGraphExport(opts)
    })
}
