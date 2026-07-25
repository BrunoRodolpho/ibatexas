// `ibx catalog` — o compilador do catálogo (LE2-016).
//
// THIN registration only: toda a lógica vive em `@ibatexas/catalog`
// (`src/compiler/` — quatro passes estáticos puros + o formatador do
// relatório). Este arquivo apenas registra o comando, escolhe a saída
// (texto ou `--json`) e define o exit code (mesmo idioma de
// `packages/cli/src/commands/graph.ts`).
//
//   ibx catalog check          → roda os QUATRO passes estáticos sobre o
//                                catálogo autorado e imprime o resultado
//                                por pass; exit 1 em qualquer rejeição
//                                (o mesmo gate que roda no `build` do pacote
//                                e no CI)
//   ibx catalog check --json   → o `CatalogCompileResult` completo em JSON
//                                (stdout limpo), para consumo por ferramenta
//
// FAIL-CLOSED (LE2 Implementation Decision 16): um catálogo incoerente não
// compila. Os passes são PUROS — sem relógio, sem rede, sem IO além do
// próprio dado do pacote — então este comando não precisa de banco, de
// serviço no ar, nem de build da apps/api. Ele reproduz exatamente o que o
// CI vê.
//
// Dependência cli→catalog é a direção sancionada (packages são estritamente
// upstream de apps; o catálogo não depende de ninguém do workspace); import
// dinâmico para não pesar o startup do ibx. Saída de dev/CI em inglês
// (convenção do plano de teste), descrições pt-BR.

import type { Command } from "commander"
import chalk from "chalk"
import type { CatalogCompileResult, CatalogPassResult } from "@ibatexas/catalog"

interface CatalogCheckFlags {
  json?: boolean
}

/** Uma linha por pass: `✓ pass — OK (N checked)` ou `✗ pass — N error(s)`. */
function printPass(pass: CatalogPassResult): void {
  const clean = pass.diagnostics.length === 0
  const head = clean
    ? chalk.green(`✓ ${pass.pass} — OK (${pass.checked} checked)`)
    : chalk.red(`✗ ${pass.pass} — ${pass.diagnostics.length} error(s) (${pass.checked} checked)`)
  if (clean) {
    console.log(head)
    return
  }
  console.error(head)
}

function printReport(
  result: CatalogCompileResult,
  formatDiagnostic: (d: CatalogCompileResult["diagnostics"][number]) => string,
): void {
  console.log(
    chalk.dim(
      `catalog v${result.catalogVersion} — ${result.capabilities} capability definition(s), ` +
        `${result.passes.length} static pass(es)`,
    ),
  )
  for (const pass of result.passes) {
    printPass(pass)
    for (const diagnostic of pass.diagnostics) {
      console.error(chalk.red(`    ${formatDiagnostic(diagnostic)}`))
    }
  }
  console.log(
    result.ok
      ? chalk.green("✓ catalog check clean — every static pass is satisfied")
      : chalk.red(
          `✗ catalog check FAILED — ${result.diagnostics.length} diagnostic(s). ` +
            "O catálogo é dado AUTORADO: corrija packages/catalog/src/ — nunca o pass — " +
            "ou mude a regra deliberadamente e explique por quê.",
        ),
  )
}

async function runCatalogCheck(opts: CatalogCheckFlags): Promise<void> {
  const { CAPABILITY_DEFINITIONS, compileCatalog, formatDiagnostic } = await import(
    "@ibatexas/catalog"
  )
  const result = compileCatalog(CAPABILITY_DEFINITIONS)

  if (opts.json === true) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printReport(result, formatDiagnostic)
  }

  if (!result.ok) process.exitCode = 1
}

export function registerCatalogCommands(group: Command): void {
  group.description(
    "Catálogo — o compilador fail-closed da raiz versionada de definição de negócio " +
      "(@ibatexas/catalog). Roda os passes estáticos que também rodam no build do " +
      "pacote e no CI.",
  )

  group
    .command("check")
    .description(
      "Roda os quatro passes estáticos sobre o catálogo autorado " +
        "(referential-integrity: toda referência cruzada resolve e toda identidade é " +
        "única; slot-dataflow: todo slot declarado é bem-formado para o contrato do seu " +
        "tier; safety-implication-edges: nenhuma aresta de claim termina em atributo de " +
        "alérgeno/dieta — BKL-143/123/171 ratificados; terminal-coverage: os terminais " +
        "declarados são completos e coerentes por pack). " +
        "Exit 1 em qualquer rejeição — é o mesmo gate do build e do CI.",
    )
    .option("--json", "Emite o CatalogCompileResult completo em JSON (stdout limpo)")
    .action(async (opts: CatalogCheckFlags) => {
      await runCatalogCheck(opts)
    })
}
