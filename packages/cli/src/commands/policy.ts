import path from "node:path"
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import type { Command } from "commander"
import chalk from "chalk"
import { ROOT } from "../utils/root.js"

/**
 * `ibx policy` — export + diff the rule-provenance manifest.
 *
 * The manifest is produced by apps/api's `buildIbatexasPolicyManifest`
 * (co-located with the policy composition so it describes the EXACT
 * post-prepend bundles the kernel runs). We invoke it via its built module so
 * the CLI does not re-implement the adopter-guard composition (no drift).
 *
 * The artifact (`policy-manifest.json`) is consumed by the adjudicate operator
 * console's rule-provenance tree. Commit it + regenerate in CI; `ibx policy
 * diff` against the committed copy detects unreviewed policy changes.
 *
 * Requires `@adjudicate/analyze >= 0.4.0` and a built apps/api
 * (`pnpm --filter @ibatexas/api build`).
 */

const EXPORTER_DIST = path.join(
  ROOT,
  "apps/api/dist/claustrum/policy-manifest-export.js",
)

// Pack id → source file(s) for guard source locations (path:line in the tree).
const PACK_SOURCE_FILES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "ibatexas/pack-orders": ["packages/pack-orders/src/policies.ts"],
  "ibatexas/pack-payments": ["packages/pack-payments/src/policies.ts"],
  "ibatexas/pack-reservations": ["packages/pack-reservations/src/policies.ts"],
  "ibatexas/pack-customer-onboarding": [
    "packages/pack-customer-onboarding/src/policies.ts",
  ],
  "ibatexas/pack-whatsapp": ["packages/pack-whatsapp/src/policies.ts"],
}

interface PolicyManifestLike {
  readonly digest: string
  readonly packs: ReadonlyArray<{
    readonly id: string
    readonly intents: ReadonlyArray<{ readonly kind: string; readonly guardNames: ReadonlyArray<string> }>
    readonly guards: ReadonlyArray<unknown>
  }>
}

async function loadExporter(): Promise<{
  buildIbatexasPolicyManifest: (opts?: {
    generatedAt?: string
    kernelVersion?: string
    packSourceFiles?: Readonly<Record<string, ReadonlyArray<string>>>
    sourceRoot?: string
  }) => PolicyManifestLike
}> {
  if (!fs.existsSync(EXPORTER_DIST)) {
    throw new Error(
      `apps/api is not built (${path.relative(ROOT, EXPORTER_DIST)} missing).\n` +
        `Run: pnpm --filter @ibatexas/api build`,
    )
  }
  return import(pathToFileURL(EXPORTER_DIST).href) as Promise<{
    buildIbatexasPolicyManifest: (opts?: {
      generatedAt?: string
      kernelVersion?: string
      packSourceFiles?: Readonly<Record<string, ReadonlyArray<string>>>
    }) => PolicyManifestLike
  }>
}

function buildManifest(opts: { withSource: boolean }): Promise<PolicyManifestLike> {
  const packSourceFiles: Record<string, string[]> = {}
  if (opts.withSource) {
    for (const [id, rels] of Object.entries(PACK_SOURCE_FILES)) {
      packSourceFiles[id] = rels.map((r) => path.join(ROOT, r))
    }
  }
  return loadExporter().then(({ buildIbatexasPolicyManifest }) =>
    buildIbatexasPolicyManifest({
      generatedAt: new Date().toISOString(),
      ...(opts.withSource ? { packSourceFiles, sourceRoot: ROOT } : {}),
    }),
  )
}

async function runExport(opts: {
  out?: string
  source?: boolean
  strict?: boolean
}): Promise<void> {
  const manifest = await buildManifest({ withSource: opts.source !== false })
  const json = JSON.stringify(manifest, null, 2)

  if (opts.out) {
    const outPath = path.isAbsolute(opts.out) ? opts.out : path.join(ROOT, opts.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, json + "\n")
    const packCount = manifest.packs.length
    const intentCount = manifest.packs.reduce((n, p) => n + p.intents.length, 0)
    const guardCount = manifest.packs.reduce((n, p) => n + p.guards.length, 0)
    console.log(
      chalk.green("✓") +
        ` policy manifest → ${chalk.cyan(path.relative(ROOT, outPath))}`,
    )
    console.log(
      chalk.dim(
        `  ${packCount} packs · ${intentCount} intents · ${guardCount} guards · digest ${manifest.digest.slice(0, 12)}…`,
      ),
    )
  } else {
    console.log(json)
  }

  if (opts.strict) {
    const unguarded = manifest.packs.flatMap((p) =>
      p.intents.filter((i) => i.guardNames.length === 0).map((i) => `${p.id}/${i.kind}`),
    )
    if (unguarded.length > 0) {
      console.error(
        chalk.red(`✗ ${unguarded.length} intent kind(s) have no applicable guards:`),
      )
      for (const u of unguarded) console.error(`    ${u}`)
      process.exitCode = 1
    }
  }
}

async function runDiff(baseline: string): Promise<void> {
  const baselinePath = path.isAbsolute(baseline) ? baseline : path.join(ROOT, baseline)
  if (!fs.existsSync(baselinePath)) {
    console.error(chalk.red(`✗ baseline not found: ${baseline}`))
    process.exitCode = 1
    return
  }
  const previous = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  const next = await buildManifest({ withSource: false })

  // @adjudicate/analyze is a direct CLI dependency.
  const { diffPolicyManifests } = await import("@adjudicate/analyze")
  const diff = diffPolicyManifests(previous, next as never)

  if (diff.identical) {
    console.log(chalk.green("✓ no policy drift — manifest matches baseline."))
    return
  }
  console.log(chalk.yellow("⚠ policy drift detected:"))
  for (const p of diff.packs) console.log(`  pack ${p.status}: ${p.packId}`)
  for (const i of diff.intents)
    console.log(`  intent ${i.status}: ${i.packId}/${i.kind}`)
  for (const g of diff.guards)
    console.log(`  guard ${g.status}: ${g.packId} · ${g.guardName}`)
  if (diff.unguardedIntents.length > 0) {
    console.log(chalk.red("  unguarded intents:"))
    for (const u of diff.unguardedIntents) console.log(`    ${u.packId}/${u.kind}`)
  }
  process.exitCode = 1
}

export function registerPolicyCommands(group: Command): void {
  group
    .command("export")
    .description("Export the policy manifest (rule-provenance tree data source)")
    .option("-o, --out <path>", "Write JSON to this path (default: stdout)")
    .option("--no-source", "Skip source locations (structure only, faster)")
    .option("--strict", "Exit non-zero if any intent kind has no applicable guards")
    .action(async (opts: { out?: string; source?: boolean; strict?: boolean }) => {
      try {
        await runExport(opts)
      } catch (err) {
        console.error(chalk.red(`✗ ${(err as Error).message}`))
        process.exitCode = 1
      }
    })

  group
    .command("diff <baseline>")
    .description("Diff the live manifest against a committed baseline JSON")
    .action(async (baseline: string) => {
      try {
        await runDiff(baseline)
      } catch (err) {
        console.error(chalk.red(`✗ ${(err as Error).message}`))
        process.exitCode = 1
      }
    })
}
