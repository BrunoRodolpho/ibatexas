// claims-kernel-floor.ts — a publish-free boot-time OBSERVABILITY guard for the
// claims pipeline's kernel dependency.
//
// RCA 2026-06-29 (Track A on Nemotron-4B): with the claims pipeline ENABLED, a
// store-open turn silently degraded to the UNKNOWN safe terminal. The drop point
// was NOT a planning-layer bug — the candidate was produced, threaded, and
// reached the kernel. It died at the kernel/render boundary because the RUNTIME
// resolved the PUBLISHED kernels (@adjudicate/core 1.6.0 + @claustrum/core
// 0.3.1), which LACK exactly the features the Track-A tag-then-derive code
// requires:
//   - @adjudicate/core >= 1.7.0 — the W6 surface: `valueBinding` /
//     `falsifierComplete` / `resolveAgainstFalsifiers` + `renderableCanonical`.
//     Below this a STORE_OPEN_NOW candidate carrying a `valueBinding` it ignores
//     can never reach VALIDATED → UNKNOWN.
//   - @claustrum/core >= 0.3.2 — the `handleTurn` stage 6a render-from-claims
//     (`claimsRenderer`). Below this there is no stage to render a VALIDATED set.
//
// This is a Wall-2 (kernel/conductor republish) condition: NO ibatexas-only edit
// can synthesize the missing kernel value-binding/falsifier logic or the missing
// 6a render stage. What an ibatexas-only edit CAN do — and this module does — is
// make the silent degradation OPERATOR-VISIBLE at boot: when the pipeline is
// enabled but the resolved kernels are below the floor, emit a loud warning so
// the next operator sees the dependency mismatch instead of a mysterious 4/4
// degrade. PURE + best-effort (never throws, never false-alarms on unknown).

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";

/**
 * The egress-brand kernel floor the Track-A claims pipeline REQUIRES at runtime.
 * Bump alongside the kernel features the pipeline consumes; relax only when the
 * required surface is in a PUBLISHED kernel ≤ the listed version.
 */
export const CLAIMS_KERNEL_FLOOR = {
  "@adjudicate/core": "1.7.0",
  "@claustrum/core": "0.3.2",
} as const;

export type KernelPackage = keyof typeof CLAIMS_KERNEL_FLOOR;

/** The kernel versions actually resolved at runtime. A package is absent when its
 * version could not be determined — treated as UNKNOWN (never a false alarm). */
export type ResolvedKernelVersions = Partial<Record<KernelPackage, string>>;

/** Parse `major.minor.patch` (prerelease / build metadata ignored). */
function parseVersion(v: string): readonly [number, number, number] {
  const core = (v.split("+")[0] ?? v).split("-")[0] ?? v;
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** `true` iff semver `a` is strictly below `b` (major.minor.patch). */
function isBelow(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i]! !== y[i]!) return x[i]! < y[i]!;
  }
  return false;
}

/**
 * PURE. The human-readable warning for each linked kernel BELOW the floor. An
 * empty array ⟹ the floor is satisfied OR a version is unknown (never a false
 * alarm). The drop-point explanation is inlined so a log reader needs no RCA.
 */
export function claimsKernelFloorWarnings(
  resolved: ResolvedKernelVersions,
  floor: typeof CLAIMS_KERNEL_FLOOR = CLAIMS_KERNEL_FLOOR,
): string[] {
  const warnings: string[] = [];
  for (const pkg of Object.keys(floor) as KernelPackage[]) {
    const got = resolved[pkg];
    if (got === undefined) continue; // unknown ⟹ stay silent, not wrong
    if (isBelow(got, floor[pkg])) {
      warnings.push(
        `[claims-pipeline] ${pkg}@${got} is BELOW the egress-brand floor >=${floor[pkg]} — ` +
          `the claims pipeline is ENABLED but this kernel lacks the surface it requires ` +
          `(adjudicate W6 valueBinding/falsifier/renderableCanonical; claustrum 6a render-from-claims). ` +
          `Validated claims will degrade to the UNKNOWN safe terminal. Publish/link the egress-brand ` +
          `kernel (>=${floor[pkg]}) to activate the pipeline.`,
      );
    }
  }
  return warnings;
}

/** Read the nearest ancestor `package.json` whose `name` matches, return version. */
function readVersionFor(entryPath: string, name: string): string | undefined {
  let dir = dirname(entryPath);
  const root = parsePath(dir).root;
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const parsed = JSON.parse(readFileSync(pj, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === name && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // unreadable/garbled package.json — keep walking up.
      }
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/**
 * Best-effort runtime resolution of the linked kernel versions. NEVER throws:
 * any package that cannot be resolved is simply omitted (→ UNKNOWN → no false
 * alarm). The kernels restrict `./package.json` in their `exports`, so we resolve
 * the package ENTRY and walk up to its `package.json`.
 */
export function resolveKernelVersions(
  resolve: (specifier: string) => string = createRequire(import.meta.url).resolve,
): ResolvedKernelVersions {
  const out: ResolvedKernelVersions = {};
  for (const pkg of Object.keys(CLAIMS_KERNEL_FLOOR) as KernelPackage[]) {
    try {
      const version = readVersionFor(resolve(pkg), pkg);
      if (version !== undefined) out[pkg] = version;
    } catch {
      // unresolvable specifier — leave UNKNOWN.
    }
  }
  return out;
}
