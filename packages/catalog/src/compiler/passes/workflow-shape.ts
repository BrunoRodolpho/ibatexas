// The WORKFLOW-SHAPE pass — LE2-020's static half.
//
// A workflow is a multi-step route that a customer will be asked to confirm
// ONCE and that will then execute several governed mutations without pausing.
// Every way that shape can be wrong is a way a customer gets asked to approve
// something other than what happens, or a way a run ends with nothing to say.
// So all of it is a BUILD error, never a runtime surprise — the same fail-closed
// posture LE2 Implementation Decision 16 sets for the rest of the compiler.
//
// ── WHAT THIS PASS CHECKS ────────────────────────────────────────────────────
//
//   1. REFERENCES RESOLVE. Every capability a workflow names — in a matcher, in
//      its selection anchor, in an activity — is a kind the catalog declares
//      (`capability-reference-dangling`), and the two PARSE-REACHABLE positions
//      (matcher, selection) never name a workflow-scoped kind, which the parser
//      can never reach (`workflow-scoped-reference-unreachable`).
//   2. PARAMETERS ARE BOUND. Every activity payload binding names a param the
//      workflow declared (`activity-param-undeclared`) — the structural half of
//      "never model-invented": an unbound binding is a hole a runtime would have
//      to fill from somewhere, and there is no admissible somewhere.
//   3. TERMINAL COVERAGE. The confirm point has a template
//      (`confirm-template-missing`) and every outcome has one
//      (`outcome-template-missing`), so no path ends in silence.
//   4. IDENTITY IS UNAMBIGUOUS. Workflow ids and, within a workflow, activity
//      ids are unique (`workflow-id-duplicated`, `activity-id-duplicated`) —
//      the ids are join keys for the per-step trace, and a duplicate makes an
//      operator's step drill-in silently wrong rather than absent.
//   5. THE SEQUENCE DOES SOMETHING. A workflow with no activities would ask for
//      a confirmation and then execute nothing (`activity-sequence-empty`).
//   6. THE ACCESS CLASS IS COHERENT. A capability cannot be both declared
//      workflow-scoped and advertised by a pack planner
//      (`workflow-scoped-kind-advertised`) — the two say opposite things about
//      whether the parser may propose it, and the build is where that has to be
//      settled.
//
// ── WHY RULE 6 IS IN THIS PASS ───────────────────────────────────────────────
//
// It reads capability definitions, not workflows, so it could have gone in
// `slot-dataflow`. It lives here because it is the same INVARIANT as rules 1–5
// state from the workflow side: what may be reached from a parse and what may
// only be reached from a workflow. Splitting it would put the two halves of one
// access class in two passes, and a reviewer chasing "why can't the parser emit
// this" would find only half the answer.
//
// It is also why this pass has real work on a catalog with ZERO workflows: it
// inspects all 58 definitions, so `checked` is non-zero and the pass contract
// in `../diagnostics.ts` ("a pass reporting `checked: 0` on the real catalog is
// not passing, it is not running") is satisfied honestly rather than by an
// accident of the corpus being empty.
//
// Pure: no clock, no RNG, no IO. Reads everything structurally (`asRecord`) —
// fixtures are widened, so the static types are a hint here, never a guarantee.

import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import type { WorkflowDefinition } from "../../workflows/types.js"
import { WORKFLOW_OUTCOMES } from "../../workflows/types.js"
import {
  capabilityObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { asRecord } from "../slots.js"

const PASS = "workflow-shape" as const

/** `workflow:<id>` — the object name for a workflow diagnostic, positional when
 *  the id is missing or not a string (the same fallback shape every other
 *  object namer in this compiler uses). */
export function workflowObjectName(id: unknown, index: number): string {
  return typeof id === "string" && id.trim() !== "" ? `workflow:${id}` : `workflow:#${index}`
}

interface WorkflowContext {
  readonly object: string
  readonly record: Readonly<Record<string, unknown>>
}

function diag(
  ctx: WorkflowContext,
  rule: string,
  field: string,
  message: string,
  reference?: string,
): CatalogDiagnostic {
  return {
    pass: PASS,
    rule,
    severity: "error",
    object: ctx.object,
    field,
    message,
    ...(reference === undefined ? {} : { reference }),
  }
}

/** Read a workflow structurally as a record (a fixture may be any shape). */
function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * A capability reference from a workflow, and whether the position it sits in
 * has to be PARSE-REACHABLE. Matchers and the selection anchor do — they are
 * evaluated against, and minted from, what a parse may produce. Activities do
 * not: reaching a workflow-scoped kind is the entire point of an activity.
 */
interface CapabilityReference {
  readonly field: string
  readonly kind: unknown
  readonly parseReachable: boolean
}

function capabilityReferences(
  record: Readonly<Record<string, unknown>>,
): readonly CapabilityReference[] {
  const references: CapabilityReference[] = []
  readArray(record["matchers"]).forEach((matcher, index) => {
    references.push({
      field: `matchers[${index}].capability`,
      kind: readRecord(matcher)["capability"],
      parseReachable: true,
    })
  })
  references.push({
    field: "selection.capability",
    kind: readRecord(record["selection"])["capability"],
    parseReachable: true,
  })
  readArray(record["activities"]).forEach((activity, index) => {
    references.push({
      field: `activities[${index}].capability`,
      kind: readRecord(activity)["capability"],
      parseReachable: false,
    })
  })
  return references
}

/** Rules 1 + the parse-reachability half of the access class. */
function checkCapabilityReferences(
  ctx: WorkflowContext,
  declaredKinds: ReadonlySet<string>,
  scopedKinds: ReadonlySet<string>,
): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  for (const reference of capabilityReferences(ctx.record)) {
    if (!isNonBlank(reference.kind)) continue
    if (!declaredKinds.has(reference.kind)) {
      out.push(
        diag(
          ctx,
          "capability-reference-dangling",
          reference.field,
          `references the capability kind "${reference.kind}", which no capability ` +
            "definition declares. A workflow can only route over capabilities the " +
            "catalog defines — the kernel default-REFUSEs an envelope whose kind no " +
            "pack owns, so an unresolved reference is a step that can never run.",
          reference.kind,
        ),
      )
      continue
    }
    if (reference.parseReachable && scopedKinds.has(reference.kind)) {
      out.push(
        diag(
          ctx,
          "workflow-scoped-reference-unreachable",
          reference.field,
          `references the WORKFLOW-SCOPED kind "${reference.kind}" from a ` +
            "parse-reachable position. A workflow-scoped kind is never advertised " +
            "to the parser and never accepted from a parse, so a matcher gated on " +
            "one can never hold and a selection anchored on one can never be " +
            "minted — the workflow would be permanently unreachable. Use an " +
            "ordinary capability here and invoke the scoped kind from an activity.",
          reference.kind,
        ),
      )
    }
  }
  return out
}

/** Rules 2 + 5 + the activity half of rule 4. */
function checkActivities(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const activities = readArray(ctx.record["activities"])

  if (activities.length === 0) {
    out.push(
      diag(
        ctx,
        "activity-sequence-empty",
        "activities",
        "declares no activities, so the workflow would ask the customer to " +
          "confirm and then execute nothing. A confirmation that buys nothing is " +
          "worse than no workflow: it teaches the customer their approval is " +
          "meaningless.",
      ),
    )
  }

  const declaredParams = new Set(
    readArray(ctx.record["params"])
      .map((param) => readRecord(param)["name"])
      .filter(isNonBlank),
  )

  const seenIds = new Set<string>()
  activities.forEach((activity, index) => {
    const record = readRecord(activity)
    const id = record["id"]
    if (isNonBlank(id)) {
      if (seenIds.has(id)) {
        out.push(
          diag(
            ctx,
            "activity-id-duplicated",
            `activities[${index}].id`,
            `re-uses the activity id "${id}". Activity ids are the join key of ` +
              "the per-step trace record, so a duplicate does not lose a step — it " +
              "makes an operator's step drill-in silently attribute two different " +
              "mutations to one row.",
            id,
          ),
        )
      }
      seenIds.add(id)
    }

    const payload = readRecord(record["payload"])
    for (const [field, binding] of Object.entries(payload)) {
      const bound = readRecord(binding)["param"]
      if (!isNonBlank(bound)) continue
      if (!declaredParams.has(bound)) {
        out.push(
          diag(
            ctx,
            "activity-param-undeclared",
            `activities[${index}].payload.${field}`,
            `binds the param "${bound}", which the workflow never declares. A ` +
              "param is what says WHERE a value comes from — a validated claim or " +
              "a customer-authored slot — so an unbound binding is a payload field " +
              "with no admissible source at all.",
            bound,
          ),
        )
      }
    }
  })

  return out
}

/** Rule 3 — terminal coverage over the confirm point and every outcome. */
function checkTemplates(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const templateIds = new Set(
    readArray(ctx.record["templates"])
      .map((template) => readRecord(template)["id"])
      .filter(isNonBlank),
  )

  const confirmTemplate = readRecord(ctx.record["confirm"])["template"]
  if (!isNonBlank(confirmTemplate) || !templateIds.has(confirmTemplate)) {
    out.push(
      diag(
        ctx,
        "confirm-template-missing",
        "confirm.template",
        `names the template "${String(confirmTemplate)}", which the workflow does ` +
          "not declare. The confirm point is the ONE moment the customer is shown " +
          "what they are approving; without its template the runtime would have " +
          "nothing to render and the only remaining source of that sentence would " +
          "be model prose.",
        isNonBlank(confirmTemplate) ? confirmTemplate : undefined,
      ),
    )
  }

  const outcomes = readRecord(ctx.record["outcomes"])
  for (const outcome of WORKFLOW_OUTCOMES) {
    const templateId = outcomes[outcome]
    if (isNonBlank(templateId) && templateIds.has(templateId)) continue
    out.push(
      diag(
        ctx,
        "outcome-template-missing",
        `outcomes.${outcome}`,
        `has no render template (names "${String(templateId)}"). Every outcome a ` +
          "workflow can reach needs authored pt-BR text, including the ones nobody " +
          "wants to think about: a declined run and a failed run are exactly when " +
          "the customer most needs an honest sentence, and a missing template is " +
          "how a run ends in silence.",
      ),
    )
  }

  return out
}

/**
 * Rule 6 — the access class's structural half, read off the CAPABILITY
 * definitions. This is the half that runs on every catalog, workflows or not.
 */
function checkAccessClass(
  definitions: readonly CapabilityDefinition[],
): { readonly diagnostics: readonly CatalogDiagnostic[]; readonly checked: number } {
  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0

  definitions.forEach((definition, index) => {
    const record = asRecord(definition)
    checked += 1
    if (record["workflowScoped"] !== true) return
    const advertisedBy = record["plannerAdvertisedBy"]
    if (!Array.isArray(advertisedBy) || advertisedBy.length === 0) return
    diagnostics.push({
      pass: PASS,
      rule: "workflow-scoped-kind-advertised",
      severity: "error",
      object: capabilityObjectName(record["kind"], index),
      field: "plannerAdvertisedBy",
      message:
        "is declared workflow-scoped AND advertised by a capability planner. The " +
        "two say opposite things about whether the parser may propose this kind: " +
        "workflow-scoped means it is never advertised and never accepted from a " +
        "parse, while plannerAdvertisedBy records that a planner does put it in " +
        "the advertised roster. Settle it here — either the kind is a free verb " +
        "or it is workflow-invocable, and the runtime must not have to guess.",
    })
  })

  return { diagnostics, checked }
}

/**
 * Run the workflow-shape pass.
 *
 * `checked` counts INSPECTIONS: every capability definition read for
 * access-class coherence, plus, per workflow, its identity, its capability
 * references, its activities and its templates. The capability leg is what
 * keeps the count honest on a catalog that declares no workflow yet.
 */
export function runWorkflowShapePass(
  definitions: readonly CapabilityDefinition[],
  _externalReferences?: unknown,
  _aliases?: unknown,
  workflows: readonly WorkflowDefinition[] = [],
): CatalogPassResult {
  const accessClass = checkAccessClass(definitions)
  const diagnostics: CatalogDiagnostic[] = [...accessClass.diagnostics]
  let checked = accessClass.checked

  const declaredKinds = new Set(
    definitions
      .map((definition) => asRecord(definition)["kind"])
      .filter(isNonBlank),
  )
  const scopedKinds = new Set(
    definitions
      .filter((definition) => asRecord(definition)["workflowScoped"] === true)
      .map((definition) => asRecord(definition)["kind"])
      .filter(isNonBlank),
  )

  const seenWorkflowIds = new Set<string>()
  workflows.forEach((workflow, index) => {
    const record = readRecord(workflow)
    const ctx: WorkflowContext = {
      object: workflowObjectName(record["id"], index),
      record,
    }

    checked += 1
    const id = record["id"]
    if (isNonBlank(id)) {
      if (seenWorkflowIds.has(id)) {
        diagnostics.push(
          diag(
            ctx,
            "workflow-id-duplicated",
            "id",
            `re-uses the workflow id "${id}". The id is what the parser selects ` +
              "and what an instance pins itself to, so two definitions under one " +
              "id means a customer's selection resolves to whichever one the " +
              "corpus happens to list first.",
            id,
          ),
        )
      }
      seenWorkflowIds.add(id)
    }

    checked += capabilityReferences(record).length
    diagnostics.push(...checkCapabilityReferences(ctx, declaredKinds, scopedKinds))

    checked += readArray(record["activities"]).length
    diagnostics.push(...checkActivities(ctx))

    checked += WORKFLOW_OUTCOMES.length + 1
    diagnostics.push(...checkTemplates(ctx))
  })

  return { pass: PASS, checked, diagnostics }
}
