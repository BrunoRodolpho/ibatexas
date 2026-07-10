// Content-addressed prompt registry for the ibatexas planner + responder
// (responder-trace-admin-plan.md — Phase B).
//
// Adopts claustrum's PromptComposer (`@claustrum/core`): the pt-BR prompt
// CONTENT (personas + the 17 capability descriptions) is registered as
// `PromptFragment`s here in ibatexas; claustrum owns only the assembly SHAPE.
// Each fragment carries a content `hash`, so the per-turn `fragmentManifest`
// recorded in the `LLMTrace` / `turn_trace` pins the prompt VERSION (id@hash),
// not just its identity — a reader of an old trace can tell whether a persona
// was later edited (the prompt-drift guard test asserts the hash moves with the
// content).
//
// Surface selection: ONE registry + ONE composer; the caller sets
// `ctx.extra.surface` (+ `ctx.capabilities`) to choose which fragments apply
// this turn. The planner composes ONLY the persona fragment, so its composed
// `system` is byte-identical to the recorded golden surface (golden stays green).

import { createHash } from "node:crypto";
import {
  createFragmentRegistry,
  createPromptComposer,
  type FragmentRegistry,
  type PromptComposer,
  type PromptContext,
  type PromptFragment,
} from "@claustrum/core";
import { IBATEXAS_CAPABILITY_DESCRIPTIONS } from "../../tools/register-ibatexas-tool-packs.js";
import { resolvePrompt } from "./prompt-overrides.js";
import {
  PLANNER_PERSONA,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
} from "./personas.js";

/** Surface tags placed on `PromptContext.extra.surface` to select fragments. */
export const PLANNER_SURFACE = "planner";
export const RESPONDER_CONVERSATIONAL_SURFACE = "responder.conversational";
export const RESPONDER_GROUNDED_SURFACE = "responder.grounded";

/** 12-hex content hash — short enough to read in a trace, long enough to pin a
 * version. Stable across runs (no salt). */
export function hashFragmentContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Rough token estimate for budget eviction (chars/4; the composer never drops
 * an inviolable fragment regardless). */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function surfaceOf(ctx: PromptContext): string | undefined {
  const extra = ctx.extra as { surface?: unknown } | undefined;
  return typeof extra?.surface === "string" ? extra.surface : undefined;
}

/** A static fragment whose content resolves a live override (default fallback). */
function staticFragment(
  id: string,
  surface: string,
  content: string,
): PromptFragment {
  const resolved = (): string => resolvePrompt(id, content);
  return {
    id,
    // Hash is content-addressed to the CONTENT ACTUALLY USED, not the
    // compiled-in default: a getter over the resolved text (a live override when
    // active, else the default) so the turn_trace `id@hash` manifest is honest
    // in both cases. With no override, resolved === default, so the recorded
    // hash is unchanged and the golden surface + prompt-drift guard stay green.
    get hash() {
      return hashFragmentContent(resolved());
    },
    priority: 0, // personas are inviolable (never evicted under budget pressure)
    tokens: estimateTokens(content),
    content: () => resolved(),
    applies: (ctx) => surfaceOf(ctx) === surface,
  };
}

/** A capability-description fragment: applies on the grounded responder surface
 * when its capability was acted this turn (ctx.capabilities). */
function capabilityFragment(kind: string, description: string): PromptFragment {
  const id = `ibatexas/capability.${kind}`;
  const content = `- ${kind}: ${description}`;
  // Override replaces the DESCRIPTION; the `- kind:` framing is preserved.
  const resolved = (): string => `- ${kind}: ${resolvePrompt(id, description)}`;
  return {
    id,
    // Content-addressed to the resolved text (override or default) so the
    // recorded hash matches what was actually sent — see staticFragment.
    get hash() {
      return hashFragmentContent(resolved());
    },
    priority: 10, // lower priority than personas; evictable under budget pressure
    tokens: estimateTokens(content),
    content: () => resolved(),
    applies: (ctx) =>
      surfaceOf(ctx) === RESPONDER_GROUNDED_SURFACE &&
      (ctx.capabilities ?? []).includes(kind),
  };
}

/** The full fragment spec list (exported for the prompt-drift guard test). */
export function ibatexasPromptFragments(): ReadonlyArray<PromptFragment> {
  const personas: PromptFragment[] = [
    staticFragment("ibatexas/planner.persona", PLANNER_SURFACE, PLANNER_PERSONA),
    staticFragment(
      "ibatexas/responder.persona",
      RESPONDER_CONVERSATIONAL_SURFACE,
      RESPONDER_PERSONA_PTBR,
    ),
    staticFragment(
      "ibatexas/responder.grounded",
      RESPONDER_GROUNDED_SURFACE,
      RESPONDER_GROUNDED_PERSONA_PTBR,
    ),
  ];
  const capabilities = Object.entries(IBATEXAS_CAPABILITY_DESCRIPTIONS).map(
    ([kind, description]) => capabilityFragment(kind, description),
  );
  return [...personas, ...capabilities];
}

/** Build the shared ibatexas fragment registry (planner + responder content). */
export function createIbatexasPromptRegistry(): FragmentRegistry {
  const registry = createFragmentRegistry();
  for (const fragment of ibatexasPromptFragments()) {
    registry.register(fragment);
  }
  return registry;
}

/** The composer + its registry (the registry is needed to resolve id → hash). */
export interface IbatexasPromptComposer {
  readonly composer: PromptComposer;
  readonly registry: FragmentRegistry;
}

export function createIbatexasPromptComposer(): IbatexasPromptComposer {
  const registry = createIbatexasPromptRegistry();
  return { composer: createPromptComposer({ registry }), registry };
}

/**
 * Content-addressing (Phase B fix): claustrum's synthesizer records bare
 * fragment IDs in `ComposedPrompt.fragmentManifest` (synthesizer.ts:
 * `selected.map(f => f.id)`), so a trace pins prompt IDENTITY but not VERSION.
 * Map each manifest entry to `id@hash` using the owning registry so `turn_trace`
 * is genuinely content-addressed. Idempotent: an entry that already carries an
 * `@` (a future claustrum that emits id@hash directly) is passed through.
 */
export function manifestWithHashes(
  registry: FragmentRegistry,
  manifest: ReadonlyArray<string>,
): string[] {
  return manifest.map((entry) => {
    if (entry.includes("@")) return entry;
    const hash = registry.byId(entry)?.hash;
    return hash ? `${entry}@${hash}` : entry;
  });
}
