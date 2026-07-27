// The WORKFLOW-RUNTIME-SHAPE pass — LE2-022's static half.
//
// `workflow-shape` (LE2-020) polices the v0 shape: references resolve, params
// bind, outcomes render, the access class is coherent. This pass polices the
// three things v1 ADDS — compensation, conditional edges, feasibility
// pre-checks — and it is a SIBLING rather than more rules in that file for a
// reason a reviewer can act on: the v0 rules are about whether a workflow is
// WELL-FORMED, these are about whether its RUNTIME BEHAVIOUR is accounted for.
// A build log that separates "this definition is malformed" from "this
// definition can half-happen and says nothing about it" is a log an author can
// triage.
//
// ── WHY ALL OF IT IS A BUILD ERROR ───────────────────────────────────────────
//
// Every rule below has the same failure signature at run time: SILENCE. Not an
// exception, not a refusal, not a log line — the workflow simply behaves
// differently from what its author read, and nothing anywhere says so:
//
//   - an uncompensated mutation strands state and the customer is told the run
//     "failed", which reads as "nothing happened";
//   - a compensator nobody can reach never runs, and the rollback that exists in
//     the definition does not exist in production;
//   - a route arm naming an activity that does not exist skips a step;
//   - an activity no arm reaches is dead code that reviews as live code;
//   - a predicate over an unknown fact is permanently false, so a branch is
//     permanently one-sided — the `claim-param-type-unknown` failure mode
//     exactly, one layer over.
//
// LE2 Implementation Decision 16 names "compensation completeness" and "graph
// shape" as compile errors, and this is that pass.
//
// ── WHAT MAKES `mutating` TRUSTWORTHY HERE ───────────────────────────────────
//
// The compensation rule does not ask the workflow author whether an activity
// mutates. It reads `CapabilityDefinition.mutating` — authored once, per
// capability, in the table that owns that question, and true for all 66
// first-party kinds today. A per-activity `mutating` slot would let the author
// who forgot the compensator also declare the step harmless, which is the same
// hand answering both halves of the question.
//
// Pure: no clock, no RNG, no IO. Reads everything structurally (`asRecord` /
// `readRecord`) — fixtures are widened, so the static types are a hint here,
// never a guarantee.

import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { isWorkflowFactName } from "../../workflows/facts.js"
import type { WorkflowDefinition } from "../../workflows/types.js"
import {
  WORKFLOW_COMPENSATION_OUTCOMES,
  WORKFLOW_CONFIRM_FACTS,
  WORKFLOW_PREDICATE_OPERATORS,
  WORKFLOW_PREDICATE_OPERATORS_WITH_VALUE,
  WORKFLOW_TERMINAL_MARKERS,
} from "../../workflows/types.js"
import { type CatalogDiagnostic, type CatalogPassResult } from "../diagnostics.js"
import { asRecord } from "../slots.js"
import { workflowObjectName } from "./workflow-shape.js"

const PASS = "workflow-runtime-shape" as const

/** The admissible {@link WorkflowCompensation} terminal markers, as a set. */
const TERMINAL_MARKERS: ReadonlySet<string> = new Set(WORKFLOW_TERMINAL_MARKERS)

/** Read any value structurally as a record (a fixture may be any shape). */
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

/** Every activity id a workflow declares, in order, blanks dropped. */
function activityIds(ctx: WorkflowContext): readonly string[] {
  return readArray(ctx.record["activities"])
    .map((activity) => readRecord(activity)["id"])
    .filter(isNonBlank)
}

/**
 * The activity ids something names as its compensator — read STRUCTURALLY
 * rather than through the catalog's own projection, because a fixture's
 * `compensation` may be any shape at all and a typed projection would throw or
 * silently read nothing on exactly the data this pass exists to reject.
 */
function compensatorIds(ctx: WorkflowContext): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const activity of readArray(ctx.record["activities"])) {
    const by = readRecord(readRecord(activity)["compensation"])["by"]
    if (isNonBlank(by)) ids.add(by)
  }
  return ids
}

/** One route step's activity-id targets, with their authored field paths. */
interface RouteTarget {
  readonly field: string
  readonly id: unknown
}

/**
 * The ROUTE this pass reads: the declared one, or the implicit v0 route (every
 * non-compensator activity, in declaration order) when none is declared.
 *
 * The implicit route is materialised rather than special-cased so every rule
 * below asks ONE question of ONE shape. It also means `activity-unreachable` is
 * vacuously satisfied for a v0 definition, which is correct: without a declared
 * route there is no way for an activity to be unreachable.
 */
function routeTargets(ctx: WorkflowContext): readonly RouteTarget[] {
  const declared = ctx.record["route"]
  if (!Array.isArray(declared)) {
    const compensators = compensatorIds(ctx)
    return activityIds(ctx)
      .filter((id) => !compensators.has(id))
      .map((id, index) => ({ field: `activities[${index}].id`, id }))
  }
  const targets: RouteTarget[] = []
  ;(declared as readonly unknown[]).forEach((step, index) => {
    const record = readRecord(step)
    if ("activity" in record) {
      targets.push({ field: `route[${index}].activity`, id: record["activity"] })
      return
    }
    readArray(record["then"]).forEach((id, armIndex) => {
      targets.push({ field: `route[${index}].then[${armIndex}]`, id })
    })
    readArray(record["otherwise"]).forEach((id, armIndex) => {
      targets.push({ field: `route[${index}].otherwise[${armIndex}]`, id })
    })
  })
  return targets
}

/**
 * Rule 1 — every MUTATING activity says what undoes it, or says out loud that
 * nothing does.
 *
 * ── WHY AN OMISSION CANNOT BE THE ANSWER ─────────────────────────────────────
 *
 * A workflow is several governed mutations behind ONE customer approval, so a
 * failure between step 2 and step 3 leaves the customer holding a state they
 * never asked for and never agreed to keep. The only two honest designs are "it
 * gets undone" and "we know it cannot be undone and we say so" — and an author
 * who simply did not think about it produces data identical to the second one
 * under any optional field. This rule is what makes those two cases different
 * bytes: `{by}` or `{terminal, why}`, never absence.
 *
 * `terminal` is not a weaker answer than `by`. A captured payment and a
 * dispatched WhatsApp message genuinely have no compensator, and a last mutating
 * step genuinely has nothing after it that could strand it. What `terminal` buys
 * is that the decision is on the record with a reason next to it, which is
 * exactly what a reviewer needs and what an omission destroys.
 */
function checkCompensationCompleteness(
  ctx: WorkflowContext,
  mutatingKinds: ReadonlySet<string>,
): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  readArray(ctx.record["activities"]).forEach((activity, index) => {
    const record = readRecord(activity)
    const capability = record["capability"]
    if (!isNonBlank(capability) || !mutatingKinds.has(capability)) return
    const declared = readRecord(record["compensation"])
    if (isNonBlank(declared["by"])) return
    if (TERMINAL_MARKERS.has(declared["terminal"] as string)) return
    out.push(
      diag(
        ctx,
        "mutating-activity-uncompensated",
        `activities[${index}].compensation`,
        `routes to the MUTATING capability "${capability}" and declares neither a ` +
          "compensator nor a terminal marker. A workflow runs several governed " +
          "mutations behind ONE customer approval, so a later step's failure leaves " +
          "this one's effect in the store with nobody having agreed to keep it. " +
          'Declare `{by: "<activity id>"}` if something undoes it, or ' +
          '`{terminal: "irreversible" | "harmless", why: "…"}` if nothing can or ' +
          "nothing needs to — an omission is indistinguishable from an oversight, " +
          "which is why it is not an accepted answer.",
        capability,
      ),
    )
  })
  return out
}

/**
 * Rules 2 + 3 + 4 — the compensator references themselves.
 *
 *   DANGLING (`compensator-target-dangling`) — the rollback exists in the
 *     definition and not in production. Nothing fails at run time: the runtime
 *     looks the id up, misses, and the mutation is simply never undone.
 *   NOT TERMINAL (`compensator-not-terminal`) — a compensator that declares a
 *     compensator of its own poses "what undoes the undo?", and the honest
 *     answer is that the regress has to stop somewhere. It stops HERE, at the
 *     build, rather than at run time in a loop nobody wrote.
 *   ROUTED (`compensator-routed`) — a compensator named by the forward route
 *     runs TWICE in the failure case, once as a step and once as a rollback,
 *     and once in the success case where there is nothing to roll back. Both
 *     are real mutations against a customer's order.
 */
function checkCompensatorReferences(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const declaredIds = new Set(activityIds(ctx))
  const byId = new Map(
    readArray(ctx.record["activities"]).map((activity) => {
      const record = readRecord(activity)
      return [record["id"], record] as const
    }),
  )
  const routed = new Set(
    routeTargets(ctx)
      .map((target) => target.id)
      .filter(isNonBlank),
  )

  readArray(ctx.record["activities"]).forEach((activity, index) => {
    const by = readRecord(readRecord(activity)["compensation"])["by"]
    if (!isNonBlank(by)) return
    const field = `activities[${index}].compensation.by`

    if (!declaredIds.has(by)) {
      out.push(
        diag(
          ctx,
          "compensator-target-dangling",
          field,
          `names "${by}" as its compensator, which this workflow does not declare ` +
            "as an activity. The rollback then exists in the definition and not in " +
            "production: the runtime resolves the id, misses, and the mutation is " +
            "never undone — with the definition still reading as though it would be.",
          by,
        ),
      )
      return
    }

    if (readRecord(byId.get(by))["compensation"] !== undefined) {
      const compensation = readRecord(readRecord(byId.get(by))["compensation"])
      if (!TERMINAL_MARKERS.has(compensation["terminal"] as string)) {
        out.push(
          diag(
            ctx,
            "compensator-not-terminal",
            field,
            `names "${by}" as its compensator, but "${by}" declares a compensator of ` +
              "its own. That asks what undoes the undo, and the regress has no " +
              "authored end — so it has to end here, at the build. A compensator " +
              'must declare `{terminal: "irreversible" | "harmless", why: "…"}`.',
            by,
          ),
        )
      }
    } else {
      out.push(
        diag(
          ctx,
          "compensator-not-terminal",
          field,
          `names "${by}" as its compensator, but "${by}" declares no compensation at ` +
            "all. A compensator is itself a governed mutation, so it owes the same " +
            "statement every other activity owes — and the only admissible one is " +
            'a terminal marker, because a compensator with a compensator is a ' +
            "regress with no authored end.",
          by,
        ),
      )
    }

    if (routed.has(by)) {
      out.push(
        diag(
          ctx,
          "compensator-routed",
          field,
          `names "${by}" as its compensator while the route ALSO runs "${by}" as a ` +
            "forward step. It would then execute twice on a failure — once as a step " +
            "and once as the rollback — and once on success, undoing work the " +
            "customer approved. A compensator is reached by failure only; take it " +
            "out of the route.",
          by,
        ),
      )
    }
  })

  return out
}

/**
 * Rules 5 + 6 — the conditional graph's shape.
 *
 * DANGLING and UNREACHABLE are the same authoring slip seen from its two ends
 * (a renamed activity), and both are silent: the dangling arm quietly skips a
 * step the author believes runs, and the orphaned activity quietly never runs
 * while reviewing as live code. Naming both is what makes a rename a build
 * failure instead of a behaviour change.
 *
 * A COMPENSATOR is reachable by definition — it is reached by failure, not by
 * the route — so it is excluded from the unreachable check. Without that
 * exclusion the two compensation rules and this one would contradict each other:
 * declaring a compensator correctly would make it unreachable, and routing it to
 * fix that would make it `compensator-routed`.
 */
function checkRouteGraph(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const declaredIds = new Set(activityIds(ctx))
  const targets = routeTargets(ctx)

  for (const target of targets) {
    if (!isNonBlank(target.id)) continue
    if (declaredIds.has(target.id)) continue
    out.push(
      diag(
        ctx,
        "route-target-dangling",
        target.field,
        `routes to the activity "${target.id}", which this workflow does not ` +
          "declare. The step is then simply skipped at run time — no error, no " +
          "diagnostic, and a route that reads as though it does one more thing " +
          "than it does. A renamed activity leaves exactly this behind.",
        target.id,
      ),
    )
  }

  // Only a DECLARED route can orphan an activity; the implicit one reaches every
  // non-compensator activity by construction.
  if (!Array.isArray(ctx.record["route"])) return out

  const reachable = new Set(targets.map((target) => target.id).filter(isNonBlank))
  const compensators = compensatorIds(ctx)
  readArray(ctx.record["activities"]).forEach((activity, index) => {
    const id = readRecord(activity)["id"]
    if (!isNonBlank(id)) return
    if (reachable.has(id) || compensators.has(id)) return
    out.push(
      diag(
        ctx,
        "activity-unreachable",
        `activities[${index}].id`,
        `declares the activity "${id}", which no route step reaches and no other ` +
          "activity names as its compensator. It is dead in production and live in " +
          "review — the shape a rename leaves behind, seen from the other end from " +
          "`route-target-dangling`. Route it, make it a compensator, or delete it.",
        id,
      ),
    )
  })

  return out
}

/** Every predicate a workflow declares, with the field path it sits at. */
function declaredPredicates(
  ctx: WorkflowContext,
): readonly { readonly field: string; readonly predicate: Readonly<Record<string, unknown>> }[] {
  const out: { field: string; predicate: Readonly<Record<string, unknown>> }[] = []
  readArray(ctx.record["prechecks"]).forEach((precheck, index) => {
    out.push({
      field: `prechecks[${index}].predicate`,
      predicate: readRecord(readRecord(precheck)["predicate"]),
    })
  })
  readArray(ctx.record["route"]).forEach((step, index) => {
    const record = readRecord(step)
    if (!("when" in record)) return
    out.push({ field: `route[${index}].when`, predicate: readRecord(record["when"]) })
  })
  return out
}

/**
 * Rules 7 + 8 — the predicates themselves.
 *
 * FACT UNKNOWN is the rule this whole pass most exists for, and it is the
 * `claim-param-type-unknown` failure mode one layer over: the runtime resolves a
 * fact by map lookup, misses, and the predicate is FALSE forever — so a
 * conditional edge is permanently one-sided and a feasibility pre-check either
 * never fires or always does, with no diagnostic anywhere and a definition that
 * reads correctly. The closed vocabulary in `workflows/facts.ts` is also where
 * the anti-confabulation guarantee lives: every legal fact name is a projection
 * the resolver grounds, so a predicate cannot reach model output because no such
 * name compiles.
 *
 * MALFORMED covers operator/value arity in BOTH directions. An `equals` with no
 * `value` compares against nothing and is permanently false — the same silent
 * one-sidedness — and a `present` carrying one reads to a reviewer as though it
 * compares something it does not, which is how the wrong branch gets approved.
 */
function checkPredicates(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const operators = new Set<string>(WORKFLOW_PREDICATE_OPERATORS)
  const withValue = new Set<string>(WORKFLOW_PREDICATE_OPERATORS_WITH_VALUE)

  for (const { field, predicate } of declaredPredicates(ctx)) {
    const fact = predicate["fact"]
    if (isNonBlank(fact) && !isWorkflowFactName(fact)) {
      out.push(
        diag(
          ctx,
          "predicate-fact-unknown",
          `${field}.fact`,
          `reads the fact "${fact}", which is not a member of the closed workflow ` +
            "fact vocabulary (`workflows/facts.ts`). The vocabulary is what makes a " +
            "workflow condition GROUNDED: every member names a field the resolver " +
            "projects into the same state the kernel's guards are adjudicated " +
            "against, so a name outside it has nothing behind it. At run time this " +
            "is perfectly silent — the fact resolves by map lookup, misses, and the " +
            "predicate is FALSE forever, leaving a branch permanently one-sided or a " +
            "pre-check that never fires.",
          fact,
        ),
      )
    }

    const op = predicate["op"]
    if (!isNonBlank(op) || !operators.has(op)) continue
    const hasValue = predicate["value"] !== undefined
    const needsValue = withValue.has(op)
    if (hasValue === needsValue) continue
    out.push(
      diag(
        ctx,
        "predicate-malformed",
        `${field}.value`,
        needsValue
          ? `uses the operator "${op}", which compares against an authored value, ` +
              "and declares none. There is nothing to compare to, so the predicate " +
              "is FALSE for every fact value it will ever see — a branch that looks " +
              "conditional and is not."
          : `uses the operator "${op}", which takes no value, and declares one. ` +
              "The value is ignored, so the predicate does not test what it reads as " +
              "testing — and a reviewer approves the comparison rather than the " +
              "presence check that actually runs.",
        op,
      ),
    )
  }

  return out
}

/**
 * Rule 9 — a pre-check's honest reason exists.
 *
 * A pre-check's whole deliverable is the REASON: it fires precisely when the
 * system is about to tell a customer it will not do the thing they asked for,
 * which is the moment a generic sentence is least useful and silence is worst.
 * Without a template the runtime has nothing to render and the only remaining
 * source for that sentence is model prose — the exact substitution the
 * renderer-from-claims design exists to prevent.
 */
function checkPrecheckTemplates(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const templateIds = new Set(
    readArray(ctx.record["templates"])
      .map((template) => readRecord(template)["id"])
      .filter(isNonBlank),
  )
  readArray(ctx.record["prechecks"]).forEach((precheck, index) => {
    const templateId = readRecord(precheck)["template"]
    if (isNonBlank(templateId) && templateIds.has(templateId)) return
    out.push(
      diag(
        ctx,
        "precheck-template-missing",
        `prechecks[${index}].template`,
        `names the template "${String(templateId)}", which the workflow does not ` +
          "declare. A pre-check exists to say WHY the workflow will not run, at the " +
          "one moment a customer is being turned down; with no template there is " +
          "nothing to render, and the only remaining source of that sentence is " +
          "model prose.",
        isNonBlank(templateId) ? templateId : undefined,
      ),
    )
  })
  return out
}

/**
 * Rule 10 — a workflow that can HALF-happen has text for having half-happened.
 *
 * Required exactly when the route can reach more than one non-compensator
 * activity, because that is exactly when a run can stop in the middle. Below
 * that threshold the two outcomes are unreachable and requiring them would mean
 * authoring pt-BR nobody can ever read — which reviewers approve without
 * reading, making the requirement worse than useless.
 *
 * Both are required together, never one: `compensated` and `stranded` are the
 * two halves of "some of it ran", and a workflow that can say "I undid it" but
 * not "I could not undo it" will render the reassuring one for the frightening
 * case the first time a compensator is refused.
 */
function checkCompensationOutcomes(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const compensators = compensatorIds(ctx)
  const routed = new Set(
    routeTargets(ctx)
      .map((target) => target.id)
      .filter(isNonBlank),
  )
  const forward = [...routed].filter((id) => !compensators.has(id))
  if (forward.length <= 1) return []

  const out: CatalogDiagnostic[] = []
  const templateIds = new Set(
    readArray(ctx.record["templates"])
      .map((template) => readRecord(template)["id"])
      .filter(isNonBlank),
  )
  const outcomes = readRecord(ctx.record["outcomes"])
  for (const outcome of WORKFLOW_COMPENSATION_OUTCOMES) {
    const templateId = outcomes[outcome]
    if (isNonBlank(templateId) && templateIds.has(templateId)) continue
    out.push(
      diag(
        ctx,
        "compensation-outcome-template-missing",
        `outcomes.${outcome}`,
        `routes ${forward.length} activities and has no "${outcome}" template ` +
          `(names "${String(templateId)}"). A multi-step run can stop in the middle, ` +
          "and the two honest things to say about that are different: `compensated` " +
          "means everything that ran was undone, `stranded` means something that ran " +
          "could not be. Falling back to `failed` would tell the customer NOTHING " +
          "happened while a real mutation sits in the store.",
    ),
    )
  }
  return out
}

/** The closed confirm-fact vocabulary, as a set. */
const CONFIRM_FACTS: ReadonlySet<string> = new Set(WORKFLOW_CONFIRM_FACTS)

/**
 * DECLARED CONFIRM COVERAGE MUST BE COVERED BY THE CONFIRM — LE2-023.
 *
 * Two rules over one declaration, and together they are the compile half of the
 * gate that makes coverage honest:
 *
 *   `confirm-coverage-fact-unknown` — a coverage (or a confirm) naming a fact
 *     outside {@link WORKFLOW_CONFIRM_FACTS}. The same closed-vocabulary
 *     discipline `predicate-fact-unknown` applies to predicates: a name nobody
 *     declared cannot be checked against anything, so it would be a coverage
 *     claim that is neither true nor false.
 *   `confirm-coverage-unstated` — a coverage claiming a fact the workflow's own
 *     confirm does NOT declare it states. THE load-bearing one. Coverage means
 *     "the customer was already asked this exact question", and a question they
 *     were asked must have named the things it was about. Without this rule an
 *     author could declare that a bare "confirma?" covered a guard whose whole
 *     content was an amount and a refund — and the run would then execute a
 *     paid cancellation on a customer who had approved a sentence that never
 *     mentioned their money.
 *
 * This half checks a CLAIM against a CLAIM. The other half — a runtime test
 * driving the real anchor and asserting its real sentence carries each declared
 * fact — checks the claim against reality. Neither is sufficient: the first
 * cannot see the guard's words, the second only covers the cases a test drives.
 * Together a stale declaration is a build failure or a test failure rather than
 * a customer reading a confirmation for something else.
 */
function checkConfirmCoverage(ctx: WorkflowContext): readonly CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const confirm = readRecord(ctx.record["confirm"])
  const confirmFacts = readArray(confirm["statesFacts"]).filter(isNonBlank)

  for (const fact of confirmFacts) {
    if (CONFIRM_FACTS.has(fact)) continue
    out.push(
      diag(
        ctx,
        "confirm-coverage-fact-unknown",
        "confirm.statesFacts",
        `names "${fact}", which is not a member of WORKFLOW_CONFIRM_FACTS. A ` +
          "confirm may only declare facts the vocabulary knows, or a coverage " +
          "over it could be neither true nor false.",
      ),
    )
  }

  const stated = new Set(confirmFacts.filter((fact) => CONFIRM_FACTS.has(fact)))

  readArray(ctx.record["activities"]).forEach((activity, index) => {
    const record = readRecord(activity)
    const coverage = record["confirmCoveredBy"]
    if (coverage === undefined || coverage === null) return
    const declared = readRecord(coverage)
    const activityId = isNonBlank(record["id"]) ? record["id"] : `#${String(index)}`

    if (!isNonBlank(declared["basisReason"])) {
      out.push(
        diag(
          ctx,
          "confirm-coverage-unstated",
          `activities.${activityId}.confirmCoveredBy.basisReason`,
          "declares a coverage with no basis reason. Coverage names ONE guard " +
            "verdict by the reason it states; a coverage without one would " +
            "match every question that guard can ask, including ones the " +
            "confirm never addressed.",
        ),
      )
    }

    for (const fact of readArray(declared["statesFacts"]).filter(isNonBlank)) {
      if (!CONFIRM_FACTS.has(fact)) {
        out.push(
          diag(
            ctx,
            "confirm-coverage-fact-unknown",
            `activities.${activityId}.confirmCoveredBy.statesFacts`,
            `names "${fact}", which is not a member of WORKFLOW_CONFIRM_FACTS.`,
          ),
        )
        continue
      }
      if (stated.has(fact)) continue
      out.push(
        diag(
          ctx,
          "confirm-coverage-unstated",
          `activities.${activityId}.confirmCoveredBy.statesFacts`,
          `claims the whole-workflow confirm covers a guard stating "${fact}", ` +
            "but `confirm.statesFacts` does not declare it. A confirm can only " +
            "cover a question it actually asked — otherwise the customer " +
            "approves one sentence and a governed mutation runs on the strength " +
            "of a different one.",
        ),
      )
    }
  })

  return out
}

/**
 * A ROUTE THAT CAN ESCALATE MUST SAY WHAT IT WILL TELL THE CUSTOMER — LE2-023.
 *
 * Required exactly when the route can reach an activity whose capability the
 * catalog declares `escalatable: true`, because that is precisely when a run can
 * end with a decision sitting on a staff queue.
 *
 * The reachability predicate is DECLARED, not inferred, and the honesty of this
 * rule is bounded by that: whether a guard escalates is a fact about a function
 * body in another package, and nothing static can decide it (see the
 * `escalatable` field's own doc for why a synthetic-probe gate would be vacuous
 * enforcement rather than enforcement). So this rule fires reliably for every
 * kind somebody declared, and cannot fire for one nobody did — which is why the
 * field carries a maintenance contract rather than a promise.
 *
 * Falling back to `failed` is the failure this prevents, and it is a sharp one:
 * `failed` means NOTHING RAN, which for a first-step escalation is literally
 * true and still leaves the customer believing the matter is closed while an
 * owner is about to decide it.
 */
function checkEscalatedOutcome(
  ctx: WorkflowContext,
  escalatableKinds: ReadonlySet<string>,
): readonly CatalogDiagnostic[] {
  const byId = new Map<string, Readonly<Record<string, unknown>>>()
  for (const activity of readArray(ctx.record["activities"])) {
    const record = readRecord(activity)
    if (isNonBlank(record["id"])) byId.set(record["id"], record)
  }
  // Reachable on SOME path — both arms of every branch, and the compensators,
  // which are reached by failure and can escalate exactly as a forward step can.
  const reachable = new Set<string>(
    routeTargets(ctx)
      .map((target) => target.id)
      .filter(isNonBlank),
  )
  for (const activity of byId.values()) {
    const compensation = readRecord(activity["compensation"])
    if (isNonBlank(compensation["by"])) reachable.add(compensation["by"])
  }

  const canEscalate = [...reachable].some((id) => {
    const capability = byId.get(id)?.["capability"]
    return isNonBlank(capability) && escalatableKinds.has(capability)
  })
  if (!canEscalate) return []

  const templateIds = new Set(
    readArray(ctx.record["templates"])
      .map((template) => readRecord(template)["id"])
      .filter(isNonBlank),
  )
  const templateId = readRecord(ctx.record["outcomes"])["escalated"]
  if (isNonBlank(templateId) && templateIds.has(templateId)) return []

  return [
    diag(
      ctx,
      "escalated-outcome-template-missing",
      "outcomes.escalated",
      'routes a capability declared `escalatable: true` and has no "escalated" ' +
        `template (names "${String(templateId)}"). A run can end with a step ` +
        "handed to a human, and the two things the customer must be told are " +
        "that the act awaits review AND that the rest of the route did not run " +
        "— an approval resumes the escalated activity alone. `failed` would say " +
        "nothing happened, which closes a matter that is still open.",
    ),
  ]
}

/**
 * A POLICY-GATED ACTIVITY MUST ALSO BE UNREACHABLE FROM A PARSE — LE2-023.
 *
 * The rule `workflows/types.ts` has promised since ac290eb3 and which, until
 * now, did not exist. A doc comment citing a nonexistent gate is worse than no
 * comment: a reviewer reads "the compiler checks this" and stops checking.
 *
 * ── THE TWO LOCKS, AND WHY THIS IS THE ONE WORTH COMPILING ──────────────────
 *
 * A policy switch closes a ROUTE. It does not close an EXECUTION. A capability
 * sitting behind `whenPolicyOpen` is therefore protected by exactly two things:
 * the switch being absent, and the kernel refusing the kind anyway. The first is
 * catalog DATA — one line, editable by anyone who can edit data, and a feature
 * shipping behind data alone is one careless line from being live.
 *
 * So this rule enforces the half that data cannot undo: a policy-gated activity's
 * capability must be `workflowScoped`, which means no parse can ever propose it
 * no matter what any route says. Opening the switch then still cannot make the
 * kind reachable from a customer sentence — it can only make a workflow ROUTE to
 * it, where the kernel meets it with the pack's own verdict.
 *
 * The second lock — that the pack produces no EXECUTE — is deliberately NOT
 * checked here, and the reason is the one the `escalatable` slot's doc gives:
 * whether a guard executes is a fact about a function body in another package,
 * and a synthetic probe over invented envelopes would pass green while the real
 * behaviour drifted. That half is proved by a FIXTURE that forces the route open
 * and asserts the kernel still refuses — behaviour, not a static claim.
 */
function checkPolicyGatedActivities(
  ctx: WorkflowContext,
  scopedKinds: ReadonlySet<string>,
): readonly CatalogDiagnostic[] {
  const byId = new Map<string, Readonly<Record<string, unknown>>>()
  for (const activity of readArray(ctx.record["activities"])) {
    const record = readRecord(activity)
    if (isNonBlank(record["id"])) byId.set(record["id"], record)
  }

  const out: CatalogDiagnostic[] = []
  readArray(ctx.record["route"]).forEach((step, index) => {
    const record = readRecord(step)
    if (!("whenPolicyOpen" in record)) return
    // Only the OPEN arm is policy-gated. The `otherwise` arm is the SHIPPED
    // path — it runs today, it is not behind the switch, and requiring it to be
    // workflow-scoped would forbid a policy branch from falling back to any
    // ordinary capability, which is exactly what the shipped arm must do.
    readArray(record["then"]).forEach((id, armIndex) => {
      if (!isNonBlank(id)) return
      const capability = byId.get(id)?.["capability"]
      if (!isNonBlank(capability) || scopedKinds.has(capability)) return
      out.push(
        diag(
          ctx,
          "policy-gated-activity-not-scoped",
          `route[${index}].then[${armIndex}]`,
          `is gated on the policy switch "${String(record["whenPolicyOpen"])}" and ` +
            `routes to "${id}", whose capability "${capability}" is NOT declared ` +
            "`workflowScoped: true`. A policy switch closes a route, not an " +
            "execution: it is catalog DATA, so it is one edited line from being " +
            "open, and behind it must sit a kind no parse can propose in the " +
            "first place. Declare the capability workflow-scoped, or do not gate " +
            "it on a policy switch.",
          capability,
        ),
      )
    })
  })
  return out
}

/**
 * Run the workflow-runtime-shape pass.
 *
 * `checked` counts INSPECTIONS: per workflow, every activity (compensation
 * completeness + its compensator reference), every route target, every declared
 * predicate, every pre-check, and the two compensation outcomes. A catalog with
 * no workflow authored reports `checked: 0` — which is HONEST here rather than
 * vacuous, and the difference matters: unlike `workflow-shape`, whose
 * access-class rule reads the capability definitions, every rule in this pass is
 * a statement about a workflow. There is nothing to inspect when there are no
 * workflows, and reporting a borrowed non-zero count would be the vacuity the
 * pass contract in `../diagnostics.ts` warns about, not a defence against it.
 */
export function runWorkflowRuntimeShapePass(
  definitions: readonly CapabilityDefinition[],
  _externalReferences?: unknown,
  _aliases?: unknown,
  workflows: readonly WorkflowDefinition[] = [],
): CatalogPassResult {
  const mutatingKinds = new Set(
    definitions
      .filter((definition) => asRecord(definition)["mutating"] === true)
      .map((definition) => asRecord(definition)["kind"])
      .filter(isNonBlank),
  )

  // LE2-023 — the DECLARED escalate-band set. Review-enforced, not
  // gate-enforced; see the `escalatable` field's doc.
  const escalatableKinds = new Set(
    definitions
      .filter((definition) => asRecord(definition)["escalatable"] === true)
      .map((definition) => asRecord(definition)["kind"])
      .filter(isNonBlank),
  )

  // LE2-023 — the access class, read off the capability table, for
  // `policy-gated-activity-not-scoped`.
  const scopedKinds = new Set(
    definitions
      .filter((definition) => asRecord(definition)["workflowScoped"] === true)
      .map((definition) => asRecord(definition)["kind"])
      .filter(isNonBlank),
  )

  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0

  workflows.forEach((workflow, index) => {
    const record = readRecord(workflow)
    const ctx: WorkflowContext = {
      object: workflowObjectName(record["id"], index),
      record,
    }

    checked += readArray(record["activities"]).length
    diagnostics.push(...checkCompensationCompleteness(ctx, mutatingKinds))
    diagnostics.push(...checkCompensatorReferences(ctx))

    checked += routeTargets(ctx).length
    diagnostics.push(...checkRouteGraph(ctx))

    checked += declaredPredicates(ctx).length
    diagnostics.push(...checkPredicates(ctx))

    checked += readArray(record["prechecks"]).length
    diagnostics.push(...checkPrecheckTemplates(ctx))

    checked += WORKFLOW_COMPENSATION_OUTCOMES.length
    diagnostics.push(...checkCompensationOutcomes(ctx))

    // LE2-023 — one inspection per activity for the coverage rules (each may
    // declare one), plus the single `escalated` outcome.
    checked += readArray(record["activities"]).length + 1
    diagnostics.push(...checkConfirmCoverage(ctx))
    diagnostics.push(...checkEscalatedOutcome(ctx, escalatableKinds))

    // One inspection per POLICY-GATED route step.
    checked += readArray(record["route"]).filter(
      (step) => "whenPolicyOpen" in readRecord(step),
    ).length
    diagnostics.push(...checkPolicyGatedActivities(ctx, scopedKinds))
  })

  return { pass: PASS, checked, diagnostics }
}
