// Stage-0 shadow sandbox ToolRegistry (plan-v2 T3-6).
//
// Stage 0 of the autonomy ladder is a TRUE shadow: a managed agent runs the
// SAME kernel-gated cognitive loop as production (real planner, real packs, real
// adjudication → real `intent_audit` rows), but it can NEVER mutate the world.
// The governance critic (plan §9-3) rejected co-mingling real + sandbox tools in
// ONE registry behind a `chooseImplementation` discriminator — the default is
// last-registered-wins, and a single mis-set ctx flag could route a real
// customer to the sandbox OR (worse) the shadow agent to a real mutator. Instead
// the shadow Conductor gets a DEDICATED registry that holds ONLY sandbox tools:
// every tool keeps the real `capability`/`intentKind` (so a kernel EXECUTE/
// REWRITE still resolves) but its `execute` is a no-op recorder and its `id` is
// namespaced `sandbox:`. Fail-closed BY CONSTRUCTION: a real tenant's conductor
// never holds these tools, and this registry holds no real executor — there is
// no flag to mis-set.
//
// `assertNoRealExecutors` is the conformance check (run at composition + in the
// acceptance suite): every tool id MUST carry the `sandbox:` prefix, so a real
// executor can never silently leak into the shadow plane.

import {
  createToolRegistry,
  type ToolDefinition,
  type ToolRegistry,
} from "@claustrum/core";

/** Every shadow tool id carries this prefix — the conformance invariant. */
export const SANDBOX_TOOL_ID_PREFIX = "sandbox:";

/** A would-be mutation the sandbox swallowed (the oracle: zero real effects). */
export interface SandboxExecution {
  readonly toolId: string;
  readonly capability: string;
  readonly intentKind: string;
  readonly input: unknown;
}

/**
 * Build a dedicated sandbox registry mirroring the real tool roster's
 * capability surface. Each sandbox tool preserves the real tool's
 * `capability`/`intentKind`/schemas/risk so the kernel pipeline resolves
 * normally on EXECUTE and on the re-adjudicated REWRITE path, but its `execute`
 * records the would-be mutation (into `record`) and returns a benign result —
 * it NEVER touches Medusa/Prisma/NATS. Ids are `sandbox:<realToolId>`.
 */
export function createSandboxToolRegistry(
  realTools: ReadonlyArray<ToolDefinition<unknown, unknown>>,
  record?: (exec: SandboxExecution) => void,
): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of realTools) {
    const sandboxId = `${SANDBOX_TOOL_ID_PREFIX}${tool.id}`;
    registry.register<unknown, unknown>({
      ...tool,
      id: sandboxId,
      description: `[sandbox no-op] ${tool.description}`,
      execute: async (input: unknown) => {
        record?.({
          toolId: sandboxId,
          capability: String(tool.capability),
          intentKind: String(tool.intentKind),
          input,
        });
        // Benign, structurally-valid result — the shadow turn completes the
        // loop (responder runs) without any real-world effect.
        return { sandbox: true, capability: String(tool.capability) };
      },
    });
  }
  return registry;
}

/**
 * Conformance check: assert a registry contains ONLY sandbox tools (every id
 * carries the `sandbox:` prefix). Throws listing the offenders. Run when a
 * shadow Conductor is composed and in the T3-6 acceptance suite so a real
 * executor can never reach the shadow plane.
 */
export function assertNoRealExecutors(registry: ToolRegistry): void {
  const leaked = registry
    .list()
    .filter((tool) => !tool.id.startsWith(SANDBOX_TOOL_ID_PREFIX))
    .map((tool) => tool.id);
  if (leaked.length > 0) {
    throw new Error(
      `shadow registry conformance failed: ${leaked.length} non-sandbox tool(s) present ` +
        `[${leaked.join(", ")}] — every shadow tool id MUST carry the "${SANDBOX_TOOL_ID_PREFIX}" prefix`,
    );
  }
}
