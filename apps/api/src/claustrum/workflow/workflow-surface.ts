// The WORKFLOW SELECTION SURFACE — what the model is offered, and what it is
// allowed to say back (LE2-020).
//
// ── SELECTION IS A PARSE OUTCOME, NOT A SIDE CHANNEL ─────────────────────────
//
// The ticket's wording is exact: "the parser SELECTS the workflow from a closed
// surface (selection is a parse outcome, subject to the same governance as any
// capability)". So the surface is built the same way `express_intent`'s is —
// an enum of ids the turn actually authorized, on the same wire, in the same
// `tools` array — and the model's answer is treated with the same suspicion:
// validated against the closed set, its slots stripped to the declared names,
// and turned into an `IntentEnvelope` the kernel adjudicates.
//
// ── WHY IT MUST GO THROUGH `buildToolSurface` ────────────────────────────────
//
// Because that is what the L1 parse cache digests. `buildParseCacheKey` takes
// the whole `tools` array, so putting the workflow surface inside it means a
// parse made while a workflow was offered can never be replayed onto a turn
// where it was not — the cache-the-parse doctrine's requirement that the key
// digest every input the parse is a function of. Advertising workflows through
// any other channel would silently break that, and the breakage would look like
// a cache hit returning a workflow selection on a turn that never offered one.
//
// ── THE SLOT SURFACE IS CLOSED TOO ───────────────────────────────────────────
//
// A selection carries customer-authored slots. Those are model-extracted, so
// they get the same treatment `stripUnauthoredPayloadFields` gives a capability
// payload: anything outside the names the workflow declares is dropped, by
// name, before it reaches the runtime. A workflow's params can then only ever
// read a slot its own definition declared.

import type { CompletionRequest } from "@claustrum/core";
import type { AdvertisedWorkflow } from "./workflow-runtime.js";
import type { WorkflowParamValue, WorkflowSlots } from "./workflow-params.js";

/**
 * The LLM-facing name of the selection tool.
 *
 * A SECOND tool alongside `express_intent`, not a capability inside it. The two
 * are different acts: `express_intent` proposes ONE mutation, while this
 * proposes an authored multi-step route whose steps the model does not choose
 * and cannot see. Folding workflows into the capability enum would blur that —
 * the model would have no way to express "run the authored sequence" as
 * distinct from "do this one thing", and the payload shapes are different
 * anyway (a capability payload vs. a workflow id plus declared slots).
 */
export const START_WORKFLOW_TOOL = "start_workflow";

/**
 * The anchor payload key carrying the instance id across a park.
 *
 * Underscore-prefixed so it cannot collide with an authored slot name, and
 * deliberately NOT a slot: it is written by the runtime, never by the model,
 * and {@link sanitizeWorkflowSlots} would strip it if a completion tried to
 * supply one — which is the correct outcome, since a model-supplied instance id
 * would just fail to resolve to an instance.
 */
export const WORKFLOW_INSTANCE_PAYLOAD_KEY = "_workflowInstanceId";

/** Read the instance id off an anchor tool's input, if one is present. */
export function workflowInstanceIdOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const id = (input as Record<string, unknown>)[WORKFLOW_INSTANCE_PAYLOAD_KEY];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** The raw shape of a `start_workflow` call's `input`. */
export interface StartWorkflowInput {
  readonly workflow: string;
  readonly slots?: unknown;
}

export function isStartWorkflowInput(input: unknown): input is StartWorkflowInput {
  return (
    input !== null &&
    typeof input === "object" &&
    typeof (input as { workflow?: unknown }).workflow === "string"
  );
}

/**
 * One workflow's line in the `start_workflow` catalogue.
 *
 * ── WHY THE PHRASINGS ARE HERE AND NOT ONLY IN THE DESCRIPTION ───────────────
 *
 * The description says what a workflow DOES; the phrasings say what it SOUNDS
 * LIKE when a customer asks for it, and those are different retrieval signals.
 * LE2-020 shipped this line description-only and LE2-021's live drive measured
 * the cost against the real engine: 87.5% selection over 8 phrasings × 5 passes,
 * with `"manda o de sempre"` — an ordinary pt-BR idiom naming neither "pedido"
 * nor "repetir" — selecting 0/5. A description cannot cover that; an example
 * can.
 *
 * The phrasings are AUTHORED CATALOG DATA, compiler-checked for a floor, for
 * duplicates and for cross-namespace collisions (`workflow-shape` rule 8), so
 * what lands on the wire here is bounded by the same review as everything else
 * the catalog declares. They are quoted so the model reads them as examples of
 * customer speech rather than as instructions.
 *
 * Extracted as a named function rather than inlined in the `.map` because this
 * string IS the selection surface: the L1 parse cache digests the whole tools
 * array, so every character here is part of a cache key, and a line worth
 * measuring is a line worth being able to read on its own.
 */
function describeWorkflowForSurface(workflow: AdvertisedWorkflow): string {
  const examples =
    workflow.triggerPhrasings.length === 0
      ? ""
      : ` (o cliente diz: ${workflow.triggerPhrasings.map((p) => `"${p}"`).join("; ")})`;
  const slots = `(dados: ${workflow.slots.join(", ") || "nenhum"})`;
  return `${workflow.id}: ${workflow.description}${examples} ${slots}`;
}

/**
 * Build the `start_workflow` tool definition for a turn's offered workflows, or
 * `undefined` when none are offered (in which case the wire is byte-identical
 * to pre-LE2-020 — the tools array simply does not grow).
 *
 * The `workflow` enum is the CLOSED surface. `slots` is a free object here
 * because the admissible names differ per workflow and this engine drops the
 * `allOf`/`if-then` narrowing that would express that (LE2-004, wire-proven) —
 * so the bound is enforced where it actually holds, at the parse seam, by
 * {@link sanitizeWorkflowSlots}. Advertising a constraint this engine discards
 * would be dead wire pretending to be a guarantee.
 */
/**
 * BKL-275 — resolve the NAME a parse wrote for a workflow to a DECLARED id.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `start_workflow`'s `workflow` property is advertised with a closed `enum`, but
 * this engine does not enforce enums at decode (LE2-004: `json_schema` binds as a
 * grammar only in the OpenAI nesting, and unsupported constraints never error) —
 * so the enum is a HINT on the wire and the bound is enforced here. Measured on
 * epoch 54cf4353d5a32564: of 12 `start_workflow` calls the model wrote the full
 * declared id 8 times, the bare suffix `orders.paid-cancel` twice, and omitted
 * the property twice. The bare-suffix form was refused, and a customer asking to
 * cancel a paid order reached no route at all.
 *
 * ── WHY A SUFFIX RULE, AND WHY IT CANNOT WIDEN ANYTHING ─────────────────────
 *
 * The workflow name is a PAYLOAD PARAMETER, not an intent kind: it names a route
 * the runtime then instantiates, and every capability that route touches is
 * adjudicated one activity at a time regardless. So this is not one of the five
 * kind-admission sites and it grants nothing on its own.
 *
 * Three properties make it safe to be lenient HERE and nowhere else:
 *
 *   EXACT WINS      — a declared id resolves to itself before any suffix is
 *                     considered, so this can never re-point a correct name.
 *   UNIQUE OR NOTHING — a suffix resolves only when EXACTLY ONE declared id
 *                     carries it. Two candidates is an ambiguity, and an
 *                     ambiguous cancel is precisely the coin flip LE2-024
 *                     retired the direct route to remove, so it refuses.
 *   DOT-BOUNDED     — the match is on `.<name>`, so `cancel` cannot match
 *                     `workflow.orders.paid-cancel` (the preceding character is
 *                     `-`, not `.`). A partial word can never select a route.
 *
 * And the caller's closed-surface check is UNCHANGED and still authoritative: a
 * resolved id that this turn did not advertise is still rejected. Uniqueness is
 * computed over the DECLARED corpus rather than the turn's advertised subset on
 * purpose — it makes this a pure, turn-independent function, so a name cannot
 * mean different routes on two turns.
 *
 * An unknown or ambiguous name is returned UNCHANGED, which lands it in the
 * existing rejection path. This function can only ever turn a REFUSAL into a
 * declared id; it can never turn one declared id into another.
 */
export function resolveWorkflowName(
  named: unknown,
  declaredIds: readonly string[],
): { readonly id: string; readonly normalizedFrom?: string } {
  if (typeof named !== "string" || named === "") return { id: "" };
  if (declaredIds.includes(named)) return { id: named };
  const suffixMatches = declaredIds.filter((id) => id.endsWith(`.${named}`));
  if (suffixMatches.length !== 1) return { id: named };
  return { id: suffixMatches[0] as string, normalizedFrom: named };
}

export function startWorkflowToolDefinition(
  workflows: readonly AdvertisedWorkflow[],
): NonNullable<CompletionRequest["tools"]>[number] | undefined {
  if (workflows.length === 0) return undefined;
  const catalogue = workflows.map(describeWorkflowForSurface).join(" | ");
  return {
    name: START_WORKFLOW_TOOL,
    description:
      "Iniciar um fluxo pré-autorizado de várias etapas. Use `workflow` (uma das " +
      `opções do enum) e \`slots\` com os dados que o cliente informou. Fluxos: ${catalogue}`,
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          enum: workflows.map((w) => w.id),
          description: "O fluxo a ser iniciado.",
        },
        slots: {
          type: "object",
          description: "Dados informados pelo cliente para este fluxo.",
        },
      },
      required: ["workflow"],
      additionalProperties: false,
    },
  };
}

function isSlotValue(value: unknown): value is WorkflowParamValue {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

/**
 * Strip a selection's slots to the names the chosen workflow declares.
 *
 * The direct analogue of `stripUnauthoredPayloadFields` one level up, and it
 * closes the same class of hole: an undeclared key that rode the wire into a
 * payload nobody bounded. Returns the kept slots plus the dropped NAMES — never
 * the dropped values, which are arbitrary model-generated text.
 */
export function sanitizeWorkflowSlots(
  raw: unknown,
  declared: ReadonlySet<string>,
): { readonly slots: WorkflowSlots; readonly dropped: readonly string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { slots: {}, dropped: [] };
  }
  const slots: Record<string, WorkflowParamValue> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (declared.has(name) && isSlotValue(value)) {
      slots[name] = value;
    } else {
      dropped.push(name);
    }
  }
  return { slots, dropped };
}
