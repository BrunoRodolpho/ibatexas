// PARAM RESOLUTION — the anti-confabulation half of the workflow runtime
// (LE2-020).
//
// A workflow's activities carry payloads, and every value in one has to come
// from somewhere. The whole design of this module is about what "somewhere" is
// allowed to be, and the answer is exactly two things:
//
//   a VALIDATED CLAIM   — a value the claims kernel already validated this turn.
//   a CUSTOMER-AUTHORED SLOT — a value the customer typed, extracted into the
//                         closed slot surface the workflow declares.
//
// and, for completeness, a CONSTANT the author wrote in the catalog — which is
// first-party by construction and is not a runtime source at all.
//
// ── THE GUARANTEE IS STRUCTURAL, NOT DOCUMENTARY ────────────────────────────
//
// {@link resolveWorkflowParams} takes NO model port. There is no argument it
// could call a model through, no `deps` object with one hiding in it, and no
// async boundary where one could be introduced without changing this
// signature — the function is synchronous and pure over its inputs. That is the
// enforcement: "the model invented this parameter" is not a state this code can
// reach, rather than a rule a reviewer has to keep checking.
//
// The catalog half is the same shape: `WorkflowParamSource` is a two-member
// union with no `{ from: "model" }` member and no default, so an authored
// definition cannot express the forbidden source either.
//
// ── UNRESOLVED IS A FIRST-CLASS RESULT ──────────────────────────────────────
//
// A claim that did not validate, or a slot the customer never filled, yields an
// UNRESOLVED param — never a placeholder, never an empty string, never a guess.
// An activity that binds an unresolved param cannot run, and the run fails with
// its authored `failed` template. That is the correct trade: a workflow step
// that executes against a fabricated id is a real mutation against the wrong
// object, which is strictly worse than an honest "I could not do that".
//
// Pure: no clock, no RNG, no IO, no model.

import type {
  WorkflowDefinition,
  WorkflowPayloadBinding,
} from "@ibatexas/catalog";

/** A value a param may hold. Deliberately scalar — no nested model output. */
export type WorkflowParamValue = string | number | boolean;

/**
 * The claims a turn validated, in the shape this module reads them: claim type
 * -> the validated value's fields. Supplied by the composition root from the
 * claims kernel's output; absent (no claims pipeline wired) means NO
 * claim-sourced param resolves, which is the fail-closed direction.
 */
export type ValidatedClaimValues = ReadonlyMap<
  string,
  Readonly<Record<string, unknown>>
>;

/** The customer-authored slots carried on the selection call. */
export type WorkflowSlots = Readonly<Record<string, WorkflowParamValue>>;

/** One param's resolution — a value, or the reason there is none. */
export type ResolvedParam =
  | { readonly resolved: true; readonly value: WorkflowParamValue }
  | { readonly resolved: false; readonly reason: string };

export interface WorkflowParamResolution {
  readonly params: ReadonlyMap<string, ResolvedParam>;
  /** The names that did NOT resolve, sorted — the run's fail-closed input. */
  readonly unresolved: readonly string[];
}

function isParamValue(value: unknown): value is WorkflowParamValue {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

/**
 * Resolve every param a workflow declares, from the two admissible sources.
 *
 * Takes no model port and never will — see the module doc.
 */
export function resolveWorkflowParams(
  workflow: WorkflowDefinition,
  sources: {
    readonly claims?: ValidatedClaimValues;
    readonly slots?: WorkflowSlots;
  },
): WorkflowParamResolution {
  const params = new Map<string, ResolvedParam>();
  const unresolved: string[] = [];

  for (const param of workflow.params) {
    const resolution = resolveOne(param.source, sources);
    params.set(param.name, resolution);
    if (!resolution.resolved) unresolved.push(param.name);
  }

  return { params, unresolved: unresolved.sort() };
}

function resolveOne(
  source: WorkflowDefinition["params"][number]["source"],
  sources: {
    readonly claims?: ValidatedClaimValues;
    readonly slots?: WorkflowSlots;
  },
): ResolvedParam {
  if (source.from === "claim") {
    const claim = sources.claims?.get(source.claimType);
    if (claim === undefined) {
      return {
        resolved: false,
        reason: `no VALIDATED claim of type "${source.claimType}" this turn`,
      };
    }
    const value = claim[source.field];
    if (!isParamValue(value)) {
      return {
        resolved: false,
        reason: `validated claim "${source.claimType}" carries no scalar "${source.field}"`,
      };
    }
    return { resolved: true, value };
  }

  const slot = sources.slots?.[source.slot];
  if (!isParamValue(slot)) {
    return {
      resolved: false,
      reason: `the customer authored no "${source.slot}" slot on this selection`,
    };
  }
  return { resolved: true, value: slot };
}

/**
 * Build one activity's payload from its authored bindings.
 *
 * Returns `undefined` when any binding names an unresolved param — the activity
 * cannot run, and the caller fails the run rather than submitting a payload with
 * a hole in it. A partial payload is the dangerous shape here: the kernel would
 * adjudicate it, some guards would read the fields that ARE present, and the
 * mutation would land against whatever the missing field defaulted to
 * downstream.
 */
export function buildActivityPayload(
  bindings: Readonly<Record<string, WorkflowPayloadBinding>>,
  resolved: ReadonlyMap<string, ResolvedParam>,
): Readonly<Record<string, WorkflowParamValue>> | undefined {
  const payload: Record<string, WorkflowParamValue> = {};
  for (const [field, binding] of Object.entries(bindings)) {
    if ("const" in binding) {
      payload[field] = binding.const;
      continue;
    }
    const param = resolved.get(binding.param);
    if (param === undefined || !param.resolved) return undefined;
    payload[field] = param.value;
  }
  return payload;
}

/**
 * Fill a template's `{name}` placeholders from resolved params plus any extra
 * grounded values the caller supplies.
 *
 * An UNKNOWN placeholder is left verbatim rather than blanked: a template that
 * references something the workflow does not have is an authoring bug, and a
 * literal `{typo}` in a dev render is how it gets noticed. Every authored
 * template's placeholders are reviewable alongside its params in one file.
 */
export function renderWorkflowTemplate(
  text: string,
  values: ReadonlyMap<string, WorkflowParamValue>,
): string {
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = values.get(name);
    return value === undefined ? whole : String(value);
  });
}
