// The WORKFLOW RUNTIME v0 (LE2-020) — instantiation, the catalog-version pin,
// and per-activity kernel adjudication.
//
// ── THE SHAPE OF A RUN ───────────────────────────────────────────────────────
//
//   1. SELECT   — the parser calls `start_workflow` from a CLOSED surface. The
//                 runtime validates the id against that same surface, resolves
//                 every declared param from a validated claim or a
//                 customer-authored slot, and mints an INSTANCE that PINS
//                 `CATALOG_VERSION`. Nothing has been adjudicated yet.
//   2. CONFIRM  — the selection envelope (the workflow's governance ANCHOR) is
//                 adjudicated by the kernel like any other capability. Its
//                 CONFIRM is the whole-workflow confirm, and the prompt the
//                 customer reads QUOTES the kernel's own grounded sentence.
//   3. RUN      — only after the customer confirms and the kernel returns
//                 EXECUTE on the anchor. Each activity is adjudicated
//                 INDIVIDUALLY, in order, writing its own audit row.
//   4. RENDER   — from the authored template for the outcome reached.
//
// ── WHAT THE RUNTIME IS NOT ALLOWED TO DO ────────────────────────────────────
//
// It never adjudicates anything itself, never bypasses a guard, and never
// decides that a step is safe. It CHOOSES WHICH ENVELOPE TO SUBMIT; the kernel
// decides whether it runs. That is why `adjudicateActivity` is injected rather
// than built here: the runtime cannot reach a policy bundle, so there is no
// code path in which it could adjudicate against a policy of its own choosing.
//
// Money is the sharpest case and it is handled by doing nothing special: an
// activity that crosses a money band meets the same band it would meet outside
// a workflow, because it is the same kernel over the same guards. A workflow
// confirm does NOT pre-authorize a step's own confirm.
//
// ── THE PIN, AND WHY IT IS NOT A LICENCE ─────────────────────────────────────
//
// LE2 Implementation Decision 17: "journey instances pin shape, adjudicate
// fresh". The instance pins the catalog version it started under, so the SHAPE
// of the run — which activities, in which order, with which templates — is
// stable even if the catalog changes mid-run. It does NOT pin policy: every
// activity passes current-code adjudication, so a policy change bites
// immediately, and a run whose pinned shape is no longer permitted fails closed
// with an honest render rather than executing a stale plan.
//
// ── FAIL-CLOSED, SEQUENTIALLY ────────────────────────────────────────────────
//
// v0 is linear with no compensation (ticket 22 owns that). So a step that does
// not reach EXECUTE STOPS the run: later activities are never submitted. The
// alternative — carrying on past a refusal — would leave the customer with a
// partial result they never agreed to, and with no compensator to undo it. The
// trace records exactly how far it got.

import { randomUUID } from "node:crypto";
import { buildEnvelope, type Decision, type IntentActor, type IntentEnvelope } from "@adjudicate/core";
import {
  CATALOG_VERSION,
  findWorkflow,
  workflowActivityKinds,
  workflowOutcomeText,
  workflowSelectionKinds,
  workflowSlotNames,
  workflowTemplateText,
  type WorkflowDefinition,
} from "@ibatexas/catalog";
import { logger } from "../../lib/logger.js";
import {
  buildActivityPayload,
  renderWorkflowTemplate,
  resolveWorkflowParams,
  type ResolvedParam,
  type ValidatedClaimValues,
  type WorkflowParamValue,
  type WorkflowSlots,
} from "./workflow-params.js";
import {
  recordWorkflowTrace,
  type WorkflowRunOutcome,
  type WorkflowStepRecord,
  type WorkflowTrace,
} from "./workflow-trace.js";

/**
 * One instantiated workflow, alive for the turn that selected it and the turn
 * that confirms it.
 */
export interface WorkflowInstance {
  readonly instanceId: string;
  readonly workflowId: string;
  /** THE PIN — the catalog serial this instance was instantiated under. */
  readonly catalogVersion: number;
  /** The definition as it was at instantiation, so the run's SHAPE is stable. */
  readonly definition: WorkflowDefinition;
  readonly params: ReadonlyMap<string, ResolvedParam>;
  /** Params that did not resolve; a non-empty list fails the run. */
  readonly unresolved: readonly string[];
  readonly startedAt: string;
}

/** One entry of the CLOSED surface the parser selects from. */
export interface AdvertisedWorkflow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The customer-authored slot names this workflow accepts. Closed. */
  readonly slots: readonly string[];
}

export interface WorkflowRuntimeDeps {
  /** The authored corpus this composition loads. Empty ⟹ the runtime is inert. */
  readonly workflows: readonly WorkflowDefinition[];
  /**
   * Adjudicate ONE activity envelope. Injected, never built here — the runtime
   * has no access to a policy bundle, which is what makes "the runtime cannot
   * adjudicate against a policy of its own choosing" structural.
   */
  readonly adjudicateActivity: (envelope: IntentEnvelope) => Promise<Decision>;
  /** Dispatch an EXECUTE-d activity through the real tool registry. */
  readonly dispatchActivity: (envelope: IntentEnvelope, ctx: unknown) => Promise<unknown>;
  /** This turn's VALIDATED claims, for claim-sourced params. */
  readonly claimsFor?: (turnId: string) => ValidatedClaimValues | undefined;
  readonly now?: () => number;
  readonly newInstanceId?: () => string;
}

export interface WorkflowRuntime {
  /**
   * The closed surface for a turn, given the capability roster the planners
   * authorized. A workflow is offered only when EVERY matcher holds — so the
   * surface can only ever narrow what was already authorized.
   */
  advertise(allowedIntents: ReadonlyArray<string>): readonly AdvertisedWorkflow[];
  /**
   * Instantiate a workflow the parser selected. Returns `undefined` when the id
   * is not on the closed surface for this turn — the defense-in-depth twin of
   * the planner's `allowed.has(capability)` check.
   */
  select(args: {
    readonly turnId: string;
    readonly workflowId: string;
    readonly slots: WorkflowSlots;
    readonly allowedIntents: ReadonlyArray<string>;
  }): WorkflowInstance | undefined;
  /** This turn's instance, if the parser selected one (the SELECTING turn). */
  instanceFor(turnId: string): WorkflowInstance | undefined;
  /**
   * An instance by its id — the lookup the CONFIRMING turn uses.
   *
   * A confirm flow spans two turns with two different turn ids, so the turn id
   * cannot be the handle that survives the park. The instance id can: it rides
   * the anchor envelope's payload into the parked envelope and comes back
   * verbatim when the customer's "sim" resumes it. That is also why it is a
   * pure lookup key and never an authority — resuming with a forged id gets you
   * an instance whose activities are still adjudicated one by one.
   */
  instanceById(instanceId: string): WorkflowInstance | undefined;
  /** Record the kernel's verdict on the ANCHOR, so the confirm can quote it. */
  recordSelectionDecision(turnId: string, decision: Decision): void;
  /** The whole-workflow confirm prompt, or `undefined` when there is none. */
  renderConfirm(turnId: string): string | undefined;
  /** Render an outcome's authored template. */
  renderOutcome(instance: WorkflowInstance, outcome: WorkflowRunOutcome): string;
  /** Run the activity sequence. Only ever called after the anchor EXECUTEs. */
  run(args: {
    readonly instanceId: string;
    readonly turnId: string;
    readonly actor: IntentActor;
    readonly ctx: unknown;
  }): Promise<WorkflowTrace | undefined>;
  /** The capability kinds that ANCHOR a loaded workflow. */
  selectionCapabilities(): ReadonlySet<string>;
  /** Every capability kind a loaded workflow's ACTIVITIES invoke. */
  activityCapabilities(): ReadonlySet<string>;
  /** INGRESS SEAM — drop this turn's instance. */
  close(turnId: string): void;
}

/** LRU cap, mirroring `funnel-tier.ts`'s per-turn maps. */
const MAX_TRACKED_TURNS = 500;

function evictOldest(map: Map<string, unknown>): void {
  if (map.size < MAX_TRACKED_TURNS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/** Read a decision's first basis code structurally (shapes vary by pack). */
function basisCodeOf(decision: Decision): string | undefined {
  const basis = (decision as { basis?: unknown }).basis;
  if (!Array.isArray(basis)) return undefined;
  const code = (basis[0] as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The customer-facing sentence a CONFIRM decision carries, if any. */
function confirmPromptOf(decision: Decision): string | undefined {
  const record = decision as {
    prompt?: unknown;
    userFacing?: unknown;
    confirmation?: { prompt?: unknown };
  };
  for (const candidate of [
    record.prompt,
    record.confirmation?.prompt,
    record.userFacing,
  ]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return undefined;
}

export function createWorkflowRuntime(deps: WorkflowRuntimeDeps): WorkflowRuntime {
  const now = deps.now ?? Date.now;
  const newInstanceId = deps.newInstanceId ?? randomUUID;
  /** By INSTANCE ID — the handle that survives a park (see `instanceById`). */
  const instances = new Map<string, WorkflowInstance>();
  /** turnId -> instanceId, for the SELECTING turn's confirm render. */
  const instanceByTurn = new Map<string, string>();
  const anchorDecisions = new Map<string, Decision>();

  /** Resolved param values, for template filling. */
  const valuesOf = (instance: WorkflowInstance): Map<string, WorkflowParamValue> => {
    const values = new Map<string, WorkflowParamValue>();
    for (const [name, param] of instance.params) {
      if (param.resolved) values.set(name, param.value);
    }
    return values;
  };

  return {
    advertise(allowedIntents: ReadonlyArray<string>): readonly AdvertisedWorkflow[] {
      const authorized = new Set(allowedIntents);
      return deps.workflows
        .filter((workflow) =>
          // CONJUNCTIVE and deterministic — every matcher must hold. The
          // direction is what matters: this reads the roster the capability
          // planners already produced, so auth level, cart state and the ops
          // boundary all stay strictly upstream and a workflow can never widen
          // the surface, only narrow it.
          workflow.matchers.every((matcher) => authorized.has(matcher.capability)),
        )
        .map((workflow) => ({
          id: workflow.id,
          title: workflow.title,
          description: workflow.description,
          slots: [...workflowSlotNames(workflow)].sort(),
        }));
    },

    select({ turnId, workflowId, slots, allowedIntents }) {
      // Defense in depth, exactly like the planner's `allowed.has(capability)`:
      // never instantiate a workflow this turn was not offered, even if the
      // model (or a compromised prompt) names one.
      const offered = this.advertise(allowedIntents).some((w) => w.id === workflowId);
      if (!offered) {
        logger.warn(
          {
            component: "workflow",
            event: "workflow.select.rejected",
            turnId,
            workflowId,
          },
          "workflow: a selection named a workflow that is not on this turn's closed surface",
        );
        return undefined;
      }
      const definition = findWorkflow(deps.workflows, workflowId);
      if (definition === undefined) return undefined;

      const resolution = resolveWorkflowParams(definition, {
        ...(deps.claimsFor?.(turnId) === undefined
          ? {}
          : { claims: deps.claimsFor(turnId) as ValidatedClaimValues }),
        slots,
      });

      const instance: WorkflowInstance = {
        instanceId: newInstanceId(),
        workflowId,
        // THE PIN. Read once, at instantiation, and never re-read: that is what
        // makes the run's shape stable and the turn replayable.
        catalogVersion: CATALOG_VERSION,
        definition,
        params: resolution.params,
        unresolved: resolution.unresolved,
        startedAt: new Date(now()).toISOString(),
      };
      evictOldest(instances);
      instances.set(instance.instanceId, instance);
      evictOldest(instanceByTurn);
      instanceByTurn.set(turnId, instance.instanceId);
      logger.info(
        {
          component: "workflow",
          event: "workflow.selected",
          turnId,
          instanceId: instance.instanceId,
          workflowId,
          catalogVersion: instance.catalogVersion,
          activities: definition.activities.length,
          unresolvedParams: instance.unresolved,
        },
        `workflow: selected ${workflowId} (catalog v${instance.catalogVersion})`,
      );
      return instance;
    },

    instanceFor: (turnId: string) => {
      const id = instanceByTurn.get(turnId);
      return id === undefined ? undefined : instances.get(id);
    },

    instanceById: (instanceId: string) => instances.get(instanceId),

    recordSelectionDecision(turnId: string, decision: Decision): void {
      if (!instanceByTurn.has(turnId)) return;
      evictOldest(anchorDecisions);
      anchorDecisions.set(turnId, decision);
    },

    renderConfirm(turnId: string): string | undefined {
      const instanceId = instanceByTurn.get(turnId);
      const instance = instanceId === undefined ? undefined : instances.get(instanceId);
      if (instance === undefined) return undefined;
      const template = workflowTemplateText(
        instance.definition,
        instance.definition.confirm.template,
      );
      if (template === undefined) return undefined;
      const values = valuesOf(instance);
      // The GROUNDED AMOUNT. Quoted verbatim from the kernel's own confirm
      // sentence — the workflow layer never re-derives money, so there is no
      // second computation of a total that could disagree with the one the
      // guard actually enforced.
      const decision = anchorDecisions.get(turnId);
      const confirmation = decision === undefined ? undefined : confirmPromptOf(decision);
      if (confirmation !== undefined) values.set("confirmation", confirmation);
      return renderWorkflowTemplate(template, values).trim();
    },

    renderOutcome(instance: WorkflowInstance, outcome: WorkflowRunOutcome): string {
      // Compiler-guaranteed present (`outcome-template-missing`), so the
      // fallback below can only be reached by a definition the compiler never
      // saw — and it is still an honest pt-BR sentence rather than silence.
      const template = workflowOutcomeText(instance.definition, outcome);
      if (template === undefined) {
        return "Não consegui concluir essa sequência. Já chamei alguém da equipe.";
      }
      return renderWorkflowTemplate(template, valuesOf(instance)).trim();
    },

    async run({ instanceId, turnId, actor, ctx }) {
      const instance = instances.get(instanceId);
      if (instance === undefined) return undefined;

      const runStartedAt = now();
      const steps: WorkflowStepRecord[] = [];
      let outcome: WorkflowRunOutcome = "completed";
      let failedActivityId: string | undefined;
      let executed = 0;

      // A param that did not resolve fails the run BEFORE anything is
      // submitted. There is no admissible way to fill it (see
      // workflow-params.ts), so submitting a partial payload would be a real
      // mutation against a value nobody authored.
      if (instance.unresolved.length > 0) {
        outcome = "failed";
        failedActivityId = instance.definition.activities[0]?.id;
        logger.warn(
          {
            component: "workflow",
            event: "workflow.params.unresolved",
            turnId,
            instanceId: instance.instanceId,
            workflowId: instance.workflowId,
            unresolvedParams: instance.unresolved,
          },
          "workflow: params did not resolve from a validated claim or a customer slot — nothing submitted",
        );
      } else {
        for (const [stepIndex, activity] of instance.definition.activities.entries()) {
          const stepStartedAt = now();
          const payload = buildActivityPayload(activity.payload, instance.params);
          if (payload === undefined) {
            outcome = "failed";
            failedActivityId = activity.id;
            break;
          }

          const envelope = buildEnvelope({
            kind: activity.capability,
            payload,
            // The SAME actor the selection ran under: a workflow acts for the
            // customer who confirmed it, never for a broader principal.
            actor,
            // Deliberately NOT widened. The values are first-party (validated
            // claims, customer slots, authored constants), but taint describes
            // PROVENANCE of the request, and the request originated in a parse.
            // Widening it here would hand every workflow activity an authority
            // the same mutation would not have outside a workflow.
            taint: "UNTRUSTED",
            nonce: `${instance.instanceId}#${stepIndex}`,
          }) as IntentEnvelope;

          // EACH ACTIVITY, INDIVIDUALLY. Its own envelope, its own
          // adjudication, its own audit row.
          const decision = await deps.adjudicateActivity(envelope);
          const decisionKind = String((decision as { kind?: unknown }).kind ?? "UNKNOWN");
          let ran = false;
          if (decisionKind === "EXECUTE") {
            try {
              await deps.dispatchActivity(envelope, ctx);
              ran = true;
              executed += 1;
            } catch (error) {
              logger.warn(
                {
                  component: "workflow",
                  event: "workflow.activity.threw",
                  turnId,
                  instanceId: instance.instanceId,
                  activityId: activity.id,
                  capability: activity.capability,
                  error: error instanceof Error ? error.message : String(error),
                },
                "workflow: an adjudicated activity's executor threw",
              );
            }
          }

          const basisCode = basisCodeOf(decision);
          steps.push({
            instanceId: instance.instanceId,
            stepIndex,
            activityId: activity.id,
            capability: activity.capability,
            decision: decisionKind,
            ...(basisCode === undefined ? {} : { basisCode }),
            executed: ran,
            durationMs: now() - stepStartedAt,
            at: new Date(now()).toISOString(),
          });

          if (!ran) {
            // LINEAR AND FAIL-CLOSED: v0 has no compensators, so carrying on
            // past a step the kernel stopped would leave the customer with a
            // partial result nobody can undo.
            outcome = "failed";
            failedActivityId = activity.id;
            break;
          }
        }
      }

      const trace: WorkflowTrace = {
        run: {
          instanceId: instance.instanceId,
          workflowId: instance.workflowId,
          catalogVersion: instance.catalogVersion,
          turnId,
          outcome,
          activitiesTotal: instance.definition.activities.length,
          activitiesExecuted: executed,
          ...(failedActivityId === undefined ? {} : { failedActivityId }),
          durationMs: now() - runStartedAt,
          startedAt: instance.startedAt,
          at: new Date(now()).toISOString(),
        },
        steps,
      };
      recordWorkflowTrace(turnId, trace);
      return trace;
    },

    selectionCapabilities: () => workflowSelectionKinds(deps.workflows),

    activityCapabilities: () => workflowActivityKinds(deps.workflows),

    close(turnId: string): void {
      const instanceId = instanceByTurn.get(turnId);
      if (instanceId !== undefined) instances.delete(instanceId);
      instanceByTurn.delete(turnId);
      anchorDecisions.delete(turnId);
    },
  };
}
