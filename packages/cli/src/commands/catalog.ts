// `ibx catalog` — o compilador do catálogo (LE2-016 / LE2-018).
//
// THIN registration only: toda a lógica vive em `@ibatexas/catalog`
// (`src/compiler/` — cinco passes estáticos puros + o formatador do
// relatório) e em `@ibatexas/tools` (a reconciliação de referências
// externas). Este arquivo apenas registra o comando, escolhe a saída
// (texto ou `--json`) e define o exit code (mesmo idioma de
// `packages/cli/src/commands/graph.ts`).
//
//   ibx catalog check          → roda os CINCO passes estáticos sobre o
//                                catálogo autorado e imprime o resultado
//                                por pass; exit 1 em qualquer rejeição
//                                (o mesmo gate que roda no `build` do pacote
//                                e no CI)
//   ibx catalog check --live   → além dos passes, reconcilia cada referência
//                                externa DECLARADA contra a sua loja viva
//                                (Medusa, zonas de entrega); exit 1 se
//                                faltar qualquer uma
//   ibx catalog check --json   → o resultado completo em JSON (stdout limpo),
//                                para consumo por ferramenta
//
// FAIL-CLOSED (LE2 Implementation Decision 16): um catálogo incoerente não
// compila. Os passes são PUROS — sem relógio, sem rede, sem IO além do
// próprio dado do pacote — então `check` sozinho não precisa de banco, de
// serviço no ar, nem de build da apps/api. Ele reproduz exatamente o que o
// CI vê.
//
// `--live` é a OUTRA metade, e é deliberadamente opt-in: ela fala com as
// lojas configuradas (MEDUSA_*, DATABASE_URL), então não roda no CI — roda no
// pipeline de deploy e na mão de quem vai publicar. É a MITIGAÇÃO do gate
// estrito de boot: a mesma verificação que derruba o start da API, disponível
// ANTES de reiniciar qualquer coisa. Ver docs/setup/deployment.md.
//
// Dependência cli→catalog/tools é a direção sancionada (packages são
// estritamente upstream de apps); import dinâmico para não pesar o startup do
// ibx. Saída de dev/CI em inglês (convenção do plano de teste), descrições
// pt-BR.

import type { Command } from "commander"
import chalk from "chalk"
import type { CatalogCompileResult, CatalogPassResult } from "@ibatexas/catalog"
import type { ExternalReferenceReconciliation } from "@ibatexas/tools"

interface CatalogCheckFlags {
  json?: boolean
  live?: boolean
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
        `${result.externalReferences} external reference(s), ${result.passes.length} static pass(es)`,
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

/** O relatório da reconciliação viva, uma linha por referência declarada. */
function printLiveReport(live: ExternalReferenceReconciliation): void {
  console.log(
    chalk.dim(
      `external references — ${live.checked} declared, ${live.resolved.length} present, ` +
        `${live.misses.length} missing`,
    ),
  )
  for (const hit of live.resolved) {
    console.log(chalk.green(`✓ ${hit.id} — "${hit.key}" in ${hit.store}`))
  }
  for (const miss of live.misses) {
    console.error(chalk.red(`✗ ${miss.id} — ${miss.reason} in the ${miss.store} store`))
    console.error(
      chalk.red(
        `    key: ${miss.key === null ? `(unset — set ${miss.keyFrom})` : `"${miss.key}" (from ${miss.keyFrom})`}`,
      ),
    )
    console.error(chalk.red(`    ${miss.detail}`))
    console.error(chalk.red(`    breaks: ${miss.consumers.join(", ")}`))
  }
  console.log(
    live.ok
      ? chalk.green("✓ external references reconciled — every declared reference exists")
      : chalk.red(
          `✗ external references FAILED — ${live.misses.length} missing. ` +
            "A API RECUSA O BOOT nesse estado (LE2 Implementation Decision 16): crie a " +
            "referência na sua loja, ou aponte a variável declarada para uma que exista.",
        ),
  )
}

async function runCatalogCheck(opts: CatalogCheckFlags): Promise<void> {
  const { CAPABILITY_DEFINITIONS, compileCatalog, formatDiagnostic } = await import(
    "@ibatexas/catalog"
  )
  const result = compileCatalog(CAPABILITY_DEFINITIONS)

  // A ordem importa: os passes estáticos primeiro, sempre. Uma tabela de
  // declarações malformada torna a reconciliação sem sentido (que loja? que
  // variável?), então quando o compilador rejeita não se toca em loja nenhuma —
  // o operador recebe o erro que ele pode de fato consertar.
  const live =
    opts.live === true && result.ok
      ? await (async () => {
          const { reconcileExternalReferences } = await import("@ibatexas/tools")
          return reconcileExternalReferences()
        })()
      : undefined

  if (opts.json === true) {
    console.log(JSON.stringify(live === undefined ? result : { ...result, live }, null, 2))
  } else {
    printReport(result, formatDiagnostic)
    if (live !== undefined) {
      console.log("")
      printLiveReport(live)
    }
  }

  if (!result.ok || live?.ok === false) process.exitCode = 1
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
      "Roda os cinco passes estáticos sobre o catálogo autorado " +
        "(referential-integrity: toda referência cruzada resolve e toda identidade é " +
        "única; slot-dataflow: todo slot declarado é bem-formado para o contrato do seu " +
        "tier; safety-implication-edges: nenhuma aresta de claim termina em atributo de " +
        "alérgeno/dieta — BKL-143/123/171 ratificados; terminal-coverage: os terminais " +
        "declarados são completos e coerentes por pack; external-references: a tabela de " +
        "referências externas é bem-formada e cada consumidor resolve). " +
        "Exit 1 em qualquer rejeição — é o mesmo gate do build e do CI.",
    )
    .option("--json", "Emite o resultado completo em JSON (stdout limpo)")
    .option(
      "--live",
      "Além dos passes, RECONCILIA cada referência externa declarada contra a sua loja " +
        "viva (promoções no Medusa, zonas de entrega no banco) usando a configuração do " +
        "ambiente atual. É exatamente o gate que a API roda no boot — rode antes de " +
        "publicar, não depois de reiniciar. Exit 1 se faltar qualquer referência.",
    )
    .action(async (opts: CatalogCheckFlags) => {
      await runCatalogCheck(opts)
    })
}
