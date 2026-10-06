// The WORKFLOW-SCOPED ACCESS CLASS, at the parse seam (LE2-020).
//
// LE2 Implementation Decision 15: "a journey-scoped access class is introduced.
// The reorder orchestration becomes journey-invocable: never emittable by the
// parser as a free verb, instantiable only by the journey executor,
// per-activity kernel adjudication intact."
//
// ── THE CLASS HAS TWO HALVES AND THEY MUST NOT BE ENFORCED SEPARATELY ────────
//
//   NEVER ADVERTISED — the kind must not appear in the tool surface the model
//                      sees, so the model is never invited to propose it.
//   NEVER ACCEPTED   — even if a completion emits it anyway (a hallucination, a
//                      stale cached parse, a prompt-injection attempt), the
//                      parse seam must refuse to build an envelope for it.
//
// Enforcing only the first is the classic mistake: "the model can't see it" is
// a property of a prompt, and prompts are not a security boundary. Enforcing
// only the second leaves the kind on the wire, inviting a refusal loop the
// customer experiences as the assistant repeatedly trying and failing.
//
// ── HOW ONE EDIT BUYS BOTH ───────────────────────────────────────────────────
//
// Both halves derive from the SAME value in `ibatexas-planner.ts`: the roster
// `unionPlans()` returns. `buildToolSurface` puts that roster's kinds in the
// `capability` enum, and `translateToolCalls`'s `allowed` set is built from it.
// So subtracting the class ONCE, immediately after `unionPlans` and before
// anything reads the result, makes both halves true — and makes it impossible
// for a future edit to fix one and forget the other, because there is only one
// place to edit.
//
// That is also why the subtraction is upstream of L2's retriever: retrieval can
// only narrow what it is given, so a workflow-scoped kind cannot re-enter the
// surface through a stale retrieval index.

import { CAPABILITY_DEFINITIONS, workflowScopedKinds } from "@ibatexas/catalog";

/**
 * The kinds no parse may propose, projected from the catalog at module load.
 *
 * A CONSTANT, not a per-turn computation: the access class is authored data
 * that cannot change at run time (the catalog is inert, hand-authored, and has
 * no mutation path — that is a ratified Out-of-Scope item), so computing it per
 * turn would be work that can only ever produce the same answer, with a
 * per-turn opportunity to be handed the wrong definitions.
 */
export const WORKFLOW_SCOPED_KINDS: ReadonlySet<string> =
  workflowScopedKinds(CAPABILITY_DEFINITIONS);

/**
 * Subtract the workflow-scoped class from a turn's authorized roster.
 *
 * Returns the input array unchanged (same reference) when nothing is subtracted,
 * so a composition with no workflow-scoped kind is byte-identical to pre-LE2-020.
 */
export function withoutWorkflowScopedKinds(
  allowedIntents: readonly string[],
): readonly string[] {
  if (WORKFLOW_SCOPED_KINDS.size === 0) return allowedIntents;
  const kept = allowedIntents.filter((kind) => !WORKFLOW_SCOPED_KINDS.has(kind));
  return kept.length === allowedIntents.length ? allowedIntents : kept;
}

/** `true` when a kind is workflow-scoped — the parse seam's rejection test. */
export function isWorkflowScopedKind(kind: string): boolean {
  return WORKFLOW_SCOPED_KINDS.has(kind);
}
