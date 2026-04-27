/**
 * Pack — the unit of distribution for a kernel-governed domain capability.
 *
 * A Pack bundles every artifact an adopter needs to wire one bounded
 * domain (PIX payments, vacation approvals, commerce checkout, …) into
 * `adjudicate()`:
 *
 *   - `policyBundle`        — the rules the kernel enforces
 *   - `capabilityPlanner`   — what the LLM is allowed to see per state
 *   - `toolClassification`  — READ vs MUTATING partition
 *   - `metadata`            — name, version, declared intent kinds
 *
 * The contract is intentionally minimal: anything more (channel adapters,
 * signed tool registries, golden-path scaffolders) lives in *separate*
 * platform packages so a Pack stays portable across runtimes.
 *
 * Versioning: `PackV0` is the experimental shape. Per the platform
 * roadmap, `PackV1` extracts after three independent Packs validate the
 * surface in real adopter usage. Until then, breaking changes are
 * expected and live behind the `0.1.0-experimental` prerelease tag.
 */

import type { CapabilityPlanner } from "./llm/planner.js";
import type { ToolClassification } from "./llm/tool-classifier.js";
import type { PolicyBundle } from "./kernel/policy.js";

/**
 * Static, machine-introspectable Pack identity. Useful for telemetry
 * (`tag = pack.metadata.name`), AaC review (extract declared intent
 * kinds from PRs), and replay bookkeeping (which Pack version emitted
 * which audit record).
 */
export interface PackMetadata {
  /** npm-style package name, e.g. `@adjudicate/pack-payments-pix`. */
  readonly name: string;
  /** Semver — typically `0.1.0-experimental` until Phase 3 stabilization. */
  readonly version: string;
  /** Intent kinds this Pack adjudicates. Stable contract — bumps with major. */
  readonly intentKinds: readonly string[];
  /** One-line summary for tooling and docs. */
  readonly summary: string;
}

/**
 * The first published Pack contract. Combines the three kernel-facing
 * primitives an adopter wires into `adjudicate()`, plus identity metadata.
 *
 * Generic parameters mirror the kernel's:
 *   - `K` — intent kind union (string-literal type)
 *   - `P` — payload type (often `unknown` for cross-intent bundles)
 *   - `S` — adopter state shape consumed by guards
 *   - `C` — capability-planner context (conversation ctx, request ctx, …)
 *
 * The Pack does **not** include a tool *registry* (concrete handler
 * implementations) — those belong in `@adjudicate/tools` (Phase 2)
 * because their lifecycle (signing, fingerprinting, semver) differs
 * from the policy-bundle lifecycle.
 */
export interface PackV0<
  K extends string = string,
  P = unknown,
  S = unknown,
  C = unknown,
> {
  readonly metadata: PackMetadata;
  readonly policyBundle: PolicyBundle<K, P, S>;
  readonly capabilityPlanner: CapabilityPlanner<S, C>;
  readonly toolClassification: ToolClassification;
}

/**
 * Default Pack alias — points at the current shipped contract version.
 * Adopters import `Pack` and let the type follow the platform's lead;
 * those who want to pin to a specific version import `PackV0` directly.
 */
export type Pack<
  K extends string = string,
  P = unknown,
  S = unknown,
  C = unknown,
> = PackV0<K, P, S, C>;

/**
 * Type-level conformance helper. Use in Pack package tests:
 *
 * ```ts
 * import { expectPackV0 } from "@adjudicate/core";
 * import { pixPaymentsPack } from "../src/index.js";
 *
 * // Compile-time check; never executed at runtime.
 * expectPackV0(pixPaymentsPack);
 * ```
 *
 * The function is a no-op at runtime; the TypeScript compiler does the
 * work. Mismatches surface as type errors at the call site, not at
 * `tsc --noEmit`-time inside `@adjudicate/core` itself.
 */
export function expectPackV0<
  K extends string,
  P,
  S,
  C = unknown,
>(_pack: PackV0<K, P, S, C>): void {
  // intentionally empty — type assertion is the whole point
}

/**
 * Runtime-friendly check: confirms that an opaque value declares the
 * minimum metadata fields. Useful at adopter boundaries (loading a
 * Pack from a registry, validating an externally-supplied bundle).
 *
 * Does *not* deeply validate the policyBundle's guards — those are
 * functions and can only be exercised by adjudicating against them.
 */
export function isPackMetadata(value: unknown): value is PackMetadata {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.version === "string" &&
    typeof v.summary === "string" &&
    Array.isArray(v.intentKinds) &&
    v.intentKinds.every((k) => typeof k === "string")
  );
}
