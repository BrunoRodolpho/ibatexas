import path from "node:path"
import fs from "node:fs"
import type { Command } from "commander"
import chalk from "chalk"
import { ROOT } from "../utils/root.js"
import {
  buildAiBomManifest,
  buildConfigSealManifest,
  buildCoherenceManifest,
  type GovernancePackLike,
  type AgentRosterLike,
} from "./governance-manifest-export.js"

/**
 * `ibx aibom` / `ibx seal` / `ibx coherence` — ARTIFACT EXPORTERS for the
 * AI-BOM (ERDS-055), config-seal (ERDS-056), and policy-coherence (ERDS-057)
 * manifests, siblings of `ibx policy export`.
 *
 * Each `export` builds a byte-stable JSON manifest from the live first-party
 * packs (+ managed-agent roster, for the BOM) via the pure producers in
 * `governance-manifest-export.ts`, which REUSE the same platform analyzers the
 * `ibx kernel pack-bom / seal / analyze` GATES call. Commit the artifact + CI
 * `--verify-file` against the committed copy to detect unreviewed governance
 * drift (the exporter counterpart to the gates' env-/baseline-fixing role).
 *
 * Determinism: producers exclude wall-clocks from every digest and elide the
 * informational `generatedAt`/`analyzedAt` fields; the CLI omits the manifest
 * `generatedAt` for `--out` writes and for `--verify-file` comparison so the
 * committed JSON is reproducible across runs (mirrors policy-manifest.json /
 * pack-bom-baseline.json).
 *
 * Source-of-truth pack roster mirrors kernel.ts's FIRST_PARTY_PACK_SPECS.
 */

// Raw first-party pack objects (not the kind→pack index) — mirrors
// kernel.ts's FIRST_PARTY_PACK_SPECS + loadPacksForGovernance so the exporter
// and the `ibx kernel *` gates analyze the EXACT same pack set.
const FIRST_PARTY_PACK_SPECS = [
  ["@ibatexas/pack-orders", "ordersPack"],
  ["@ibatexas/pack-reservations", "reservationsPack"],
  ["@ibatexas/pack-whatsapp", "whatsappPack"],
  ["@ibatexas/pack-customer-onboarding", "customerOnboardingPack"],
  ["@ibatexas/pack-payments", "paymentsPack"],
  ["@adjudicate/pack-payments-pix", "paymentsPixPack"],
] as const

async function loadPacksForGovernance(
  only?: string,
): Promise<GovernancePackLike[]> {
  const out: GovernancePackLike[] = []
  for (const [spec, exp] of FIRST_PARTY_PACK_SPECS) {
    if (only !== undefined && spec !== only) continue
    try {
      const mod = (await import(spec as string)) as Record<
        string,
        GovernancePackLike | undefined
      >
      const pack = mod[exp]
      if (pack) out.push(pack)
    } catch {
      // Unresolvable spec — skip (CLI may run outside the workspace).
    }
  }
  return out
}

async function loadAgentRoster(): Promise<AgentRosterLike> {
  const { AGENT_REGISTRY, agentRosterDrift, generateAgentAiBom } = await import(
    "@ibatexas/agents"
  )
  return {
    AGENT_REGISTRY,
    agentRosterDrift,
    generateAgentAiBom: generateAgentAiBom as never,
  } as AgentRosterLike
}

/** Canonical serialization shared by export + verify (manifest `generatedAt` elided). */
function serialize(manifest: Record<string, unknown>): string {
  const { generatedAt: _omit, ...stable } = manifest
  return JSON.stringify(stable, null, 2) + "\n"
}

function resolveOut(out: string): string {
  // #93-4 (verified non-bug): operator-supplied paths are intentionally NOT
  // containment-checked against ROOT. This is a local dev/CI CLI run by a
  // trusted operator, not a network-exposed surface, so `..`/absolute escapes
  // are allowed by design — do NOT add a startsWith(ROOT) guard.
  return path.isAbsolute(out) ? out : path.join(ROOT, out)
}

interface ExportResult {
  readonly artifactName: string
  readonly build: (packs: GovernancePackLike[]) => Promise<Record<string, unknown>>
  readonly summary: (m: Record<string, unknown>) => string
}

async function runExport(
  cfg: ExportResult,
  opts: { out?: string; pack?: string; verifyFile?: string },
): Promise<void> {
  const packs = await loadPacksForGovernance(opts.pack)
  if (packs.length === 0) {
    console.error(
      chalk.red(`Nenhum pack encontrado${opts.pack ? ` para ${opts.pack}` : ""}.`),
    )
    process.exitCode = 1
    return
  }
  const manifest = await cfg.build(packs)
  const json = serialize(manifest)

  // ── Verify mode: byte-compare the live manifest against the committed copy ──
  if (opts.verifyFile !== undefined) {
    const vf = resolveOut(opts.verifyFile)
    if (!fs.existsSync(vf)) {
      console.error(chalk.red(`✗ baseline não encontrada: ${opts.verifyFile}`))
      process.exitCode = 1
      return
    }
    const committed = fs.readFileSync(vf, "utf8")
    if (committed === json) {
      console.log(
        chalk.green(`✓ ${cfg.artifactName} sem drift — confere com a baseline.`),
      )
      return
    }
    // Re-serialize the committed copy through the same elision so a stray
    // `generatedAt` in the committed file does not cause a false positive.
    // #93-3 (verified non-bug): a SHALLOW re-serialize (single parse + canonical
    // stringify) is sufficient — serialize() already emits stable 2-space,
    // key-insertion-order JSON, and BOTH sides are produced by the same builder,
    // so no deep canonicalization is needed.
    let normalizedCommitted = committed
    try {
      normalizedCommitted = serialize(JSON.parse(committed))
    } catch {
      // Non-JSON / unparseable committed file → treat as drift.
    }
    if (normalizedCommitted === json) {
      console.log(
        chalk.green(`✓ ${cfg.artifactName} sem drift — confere com a baseline.`),
      )
      return
    }
    console.error(
      chalk.red(
        `✗ ${cfg.artifactName}: drift detectado vs ${opts.verifyFile} (re-gere com 'export --out').`,
      ),
    )
    console.error(chalk.dim(cfg.summary(manifest)))
    process.exitCode = 1
    return
  }

  // ── Write or print ──────────────────────────────────────────────────────
  if (opts.out) {
    const outPath = resolveOut(opts.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, json)
    console.log(
      chalk.green("✓") +
        ` ${cfg.artifactName} → ${chalk.cyan(path.relative(ROOT, outPath))}`,
    )
    console.log(chalk.dim("  " + cfg.summary(manifest)))
  } else {
    console.log(json.replace(/\n$/, ""))
  }
}

// ── ibx aibom ──────────────────────────────────────────────────────────────

export function registerAibomCommands(group: Command): void {
  group
    .command("export")
    .description(
      "Exporta o AI Bill-of-Materials (EU AI Act Art. 11 / NIST AI RMF) dos packs + roster de agentes como artefato JSON commitável. --verify-file falha (exit 1) em drift (ERDS-055).",
    )
    .option("-o, --out <path>", "Escreve o JSON neste caminho (default: stdout)")
    .option("--pack <spec>", "Pack alvo (default: todos os first-party + agentes)")
    .option(
      "--verify-file <path>",
      "Compara o manifesto vivo contra a baseline commitada (CI gate)",
    )
    .action(
      async (opts: { out?: string; pack?: string; verifyFile?: string }) => {
        try {
          await runExport(
            {
              artifactName: "ai-bom",
              build: async (packs) =>
                buildAiBomManifest({
                  packs,
                  // Fold the managed-agent roster only on full runs.
                  ...(opts.pack === undefined
                    ? { agents: await loadAgentRoster() }
                    : {}),
                }) as unknown as Record<string, unknown>,
              summary: (m) => {
                const digests = (m.digests ?? {}) as Record<string, string>
                const ids = Object.keys(digests)
                return `${ids.length} componentes · ${ids.filter((i) => i.startsWith("agent/")).length} agentes`
              },
            },
            opts,
          )
        } catch (err) {
          console.error(chalk.red(`✗ ${(err as Error).message}`))
          process.exitCode = 1
        }
      },
    )
}

// ── ibx seal ─────────────────────────────────────────────────────────────────

export function registerSealCommands(group: Command): void {
  group
    .command("export")
    .description(
      "Exporta o config-seal digest (ADR-121) de cada pack como artefato JSON commitável. --verify-file falha (exit 1) em drift (ERDS-056).",
    )
    .option("-o, --out <path>", "Escreve o JSON neste caminho (default: stdout)")
    .option("--pack <spec>", "Pack alvo (default: todos os first-party)")
    .option(
      "--verify-file <path>",
      "Compara o manifesto vivo contra a baseline commitada (CI gate)",
    )
    .action(
      async (opts: { out?: string; pack?: string; verifyFile?: string }) => {
        try {
          await runExport(
            {
              artifactName: "config-seal",
              build: async (packs) =>
                buildConfigSealManifest({ packs }) as unknown as Record<
                  string,
                  unknown
                >,
              summary: (m) =>
                `${(m.seals as unknown[] | undefined)?.length ?? 0} packs selados`,
            },
            opts,
          )
        } catch (err) {
          console.error(chalk.red(`✗ ${(err as Error).message}`))
          process.exitCode = 1
        }
      },
    )
}

// ── ibx coherence ────────────────────────────────────────────────────────────

export function registerCoherenceCommands(group: Command): void {
  group
    .command("export")
    .description(
      "Exporta o relatório de coerência de política Tier-1 (ADR-109) de cada pack como artefato JSON commitável. --verify-file falha (exit 1) em drift (ERDS-057).",
    )
    .option("-o, --out <path>", "Escreve o JSON neste caminho (default: stdout)")
    .option("--pack <spec>", "Pack alvo (default: todos os first-party)")
    .option(
      "--verify-file <path>",
      "Compara o manifesto vivo contra a baseline commitada (CI gate)",
    )
    .action(
      async (opts: { out?: string; pack?: string; verifyFile?: string }) => {
        try {
          await runExport(
            {
              artifactName: "coherence",
              build: async (packs) =>
                buildCoherenceManifest({ packs }) as unknown as Record<
                  string,
                  unknown
                >,
              summary: (m) => {
                const t = (m.totals ?? {}) as Record<string, number>
                return `${(m.packs as unknown[] | undefined)?.length ?? 0} packs · ${t.error ?? 0} erros · ${t.warning ?? 0} avisos`
              },
            },
            opts,
          )
        } catch (err) {
          console.error(chalk.red(`✗ ${(err as Error).message}`))
          process.exitCode = 1
        }
      },
    )
}
