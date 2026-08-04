// Agent trigger bridge + dedup stack (T3-2).
//
// The ingress that turns a domain NATS event (e.g. `payment.status_changed`)
// into a server-resident managed-agent turn. It sits between the broker and a
// trigger-turn runner (the Stage-0 shadow Conductor composed in T3-6 / the live
// agent composition in T3-9) and owns ONLY the host-level dedup + safety stack;
// it never opens a capsule itself.
//
// Pipeline per qualifying event:
//   NATS subscribe (per agent, per subject)
//     → qualify (eventKind ∈ agent.trigger.eventKinds)
//     → map to a TriggerEvent (injected; resolves entityRef incl. customerId)
//     → enqueue a BullMQ job (jobId = `${agentId}:${externalId}` → queue-layer
//        redelivery dedup, the proven stripe-webhook-processor.ts:86 pattern)
//     → worker runs processTriggerJob():
//          1. LOOP SUPPRESSION — drop events an agent itself caused
//             (causal actor sessionId carries the `agent:` prefix), so a
//             remediation that re-publishes `payment.status_changed` can never
//             re-wake the agent. Synchronous, no I/O.
//          2. REDELIVERY DEDUP — two-phase Redis claim keyed by the
//             `${sourceSubject}:${eventId}` carrier: a redelivery of the SAME
//             event runs the turn at most once (released on failure so BullMQ
//             retries reprocess; promoted to the full window on success).
//          3. PER-ENTITY COOLDOWN — Redis SET NX EX `cooldownSeconds` keyed by
//             the entity: at most one remediation per entity per window, whatever
//             the redelivery/distinct-event pattern.
//          4. RUN under HOST HARD CAPS — wall-clock deadline
//             (`wallClockMsPerTrigger`, enforced here via an AbortSignal + race)
//             and a max-model-calls budget (`maxModelCallsPerTrigger`, enforced
//             inside the composition via {@link createModelCallCap}).
//
// Dedup layering (plan v2 §3): host-level dedup (BullMQ jobId + the cooldown /
// redelivery claims here) is PRIMARY; the kernel Execution Ledger (P0-1) catches
// exact replays at the seal as a backstop (the planner's deterministic nonce —
// `deriveDeterministicNonce`, reading `perception.externalId` — makes a
// re-delivered trigger hash identically). The two are independent and additive.
//
// Containment: this module NEVER publishes to NATS (subscribe-only test plane,
// check-bypass leg 8) and takes the turn runner as an injected dependency — the
// real Conductor wiring lands in T3-6/T3-9, tests inject a stub.

import { randomUUID } from "node:crypto";
import {
  AGENT_SESSION_NAMESPACE,
  agentSessionId,
  assertAgentRosterIntegrity,
  type AgentDefinition,
} from "@ibatexas/agents";
import { rk } from "@ibatexas/tools";
import { subscribeNatsEvent } from "@ibatexas/nats-client";
import type { ModelProvider } from "@claustrum/core";
import type { Queue, Worker } from "bullmq";
import { logger } from "../lib/logger.js";
import { createQueue, createWorker, type Job } from "../jobs/queue.js";
import { triggerExternalId, type TriggerEvent } from "./system-channel.js";

// ── Dedup-store surface (the slice of node-redis the stack needs) ────────────

/**
 * Minimal Redis surface the dedup stack uses: `SET key value [EX s] [NX]` —
 * with `NX` it returns `"OK"` on claim and `null` if the key already exists;
 * without `NX` it overwrites and returns `"OK"` (used to promote a claim's TTL,
 * mirroring `markProcessed` in subscribers/dedup.ts). Plus the F-21
 * ownership-conditional release, {@link TriggerDedupRedis.compareAndDelete}.
 *
 * A value of this type is obtained from `createTriggerDedupRedis()` in
 * `trigger-dedup-redis.ts` — the composition root that proves a client can
 * serve it. Tests inject an in-memory fake through the same factory shape.
 *
 * NOTE the absent member: there is no `del`. After F-21 nothing on this path
 * releases a claim unconditionally, and leaving `del` on the contract would
 * leave the defect one keystroke away.
 */
export interface TriggerDedupRedis {
  set(
    key: string,
    value: string,
    opts: { EX?: number; NX?: true },
  ): Promise<string | null>;
  /**
   * REQUIRED, never optional. Delete `key` only while its value is still
   * `expectedValue`; returns 1 when deleted and 0 when it no longer matches
   * (someone else owns the claim — leave it alone).
   *
   * Declared REQUIRED on purpose, following the F-22 `ParkRedisCapabilities`
   * precedent: an optional atomicity member is silently SKIPPED by a client
   * that omits it, which is how a lock release becomes a no-op — or worse, how
   * a caller "helpfully" falls back to an unconditional `del`. A client that
   * cannot compare-and-delete cannot serve this path, and `tsc` says so at the
   * composition root rather than Redis saying so at 3am.
   */
  compareAndDelete(key: string, expectedValue: string): Promise<number>;
}

// ── Turn runner (injected — T3-6/T3-9 wire the real composition) ─────────────

export interface TriggerTurnInput {
  readonly agent: AgentDefinition;
  readonly event: TriggerEvent;
  /** `agent:<id>@<ver>:entity:<entityId>` (D-017, unhashed in intent_audit). */
  readonly sessionId: string;
  /** Aborts when the wall-clock deadline elapses; the runner SHOULD honor it. */
  readonly signal: AbortSignal;
  /** `budgets.maxModelCallsPerTrigger` — enforced by the composition's model cap. */
  readonly maxModelCalls: number;
}

export interface TriggerTurnResult {
  /** The kernel decision kind for the turn (EXECUTE, REFUSE, ESCALATE, …). */
  readonly decisionKind: string;
  /** Model calls the turn actually made (≤ maxModelCalls). */
  readonly modelCalls: number;
}

/** Opens a capsule and runs one trigger turn. T3-6 supplies the shadow Conductor. */
export type TriggerTurnRunner = (
  input: TriggerTurnInput,
) => Promise<TriggerTurnResult>;

// ── Outcome + journal ────────────────────────────────────────────────────────

export type TriggerSuppressionReason = "agent_loop" | "redelivery" | "cooldown";

export type TriggerOutcome =
  | { readonly status: "suppressed"; readonly reason: TriggerSuppressionReason }
  | {
      readonly status: "ran";
      readonly decisionKind: string;
      readonly modelCalls: number;
    }
  | { readonly status: "failed"; readonly error: string };

export interface TriggerJournalEntry {
  readonly event: "agent_trigger.bridge";
  readonly agentId: string;
  readonly entity: string;
  readonly externalId: string;
  readonly outcome: TriggerOutcome;
}

// ── One trigger event, fully formed for processing ───────────────────────────

export interface TriggerJob {
  readonly agent: AgentDefinition;
  readonly event: TriggerEvent;
  /**
   * sessionId of the actor whose intent CAUSED this event, when the publisher
   * stamps provenance. If it carries the `agent:` prefix the event was an
   * agent's own side effect → loop-suppressed. Absent for unstamped legacy
   * events (the per-entity cooldown is the always-on loop-breaker for those).
   */
  readonly causalActorSessionId?: string;
}

export interface ProcessTriggerJobDeps {
  readonly redis: TriggerDedupRedis;
  readonly runner: TriggerTurnRunner;
  /** Injectable clock; defaults to `Date.now`. Only used for the wall-clock cap. */
  readonly now?: () => number;
  /** Structured journal sink; defaults to the api logger at info level. */
  readonly journal?: (entry: TriggerJournalEntry) => void;
}

/** Redelivery in-flight claim lifetime before the turn confirms (5 min). */
export const REDELIVERY_INFLIGHT_TTL_S = 300;
/** Redelivery full-window after a confirmed turn (7 days, matches NATS dedup). */
const REDELIVERY_DONE_TTL_S = 604_800;

/**
 * The value a PROMOTED (decided) seen-key carries.
 *
 * Deliberately a CONSTANT, not a token — a decided event is terminal and owned
 * by no one, which is precisely why nothing may release it. See
 * PROMOTE-OVERWRITE below.
 */
const DONE_MARKER = "1";

// ── PROMOTE-OVERWRITE — measured, and deliberately NOT converted ──────────────
//
// The two `set(seenKey, DONE_MARKER, { EX: REDELIVERY_DONE_TTL_S })` promotes
// overwrite the in-flight claim without checking who owns it. F-21 asks whether
// that is the same defect as the release path. It is not, for two reasons — one
// measured, one semantic.
//
// MEASURED — the dangerous interleaving is unreachable. An ownership-blind
// overwrite only harms anyone if THIS invocation's claim can lapse while the
// invocation is still running, letting a second delivery re-claim the carrier
// before this one writes. It cannot:
//
//     REDELIVERY_INFLIGHT_TTL_S              = 300_000 ms (5 min)
//     max(budgets.wallClockMsPerTrigger)     =  60_000 ms (1 min)
//         — AGENT_REGISTRY's only agent, packages/agents/src/registry.ts:45
//
// and `runWithWallClock` does not merely observe that cap, it REJECTS at it
// (a `Promise.race` against a rejecting deadline timer), so a turn that would
// outlive its claim goes to the CATCH path — the ownership-conditional one —
// rather than to a promote. The confirm promote is reachable only when the
// runner RESOLVED, bounded by 60s; the cooldown promote is reachable a few
// round trips after the claim. Both sit 5x inside the window.
//
// That is a budget-dependent premise, not a structural one, so it is PINNED:
// `agent-trigger-promote-window.unit.test.ts` fails if any agent's wall-clock
// budget grows to within the in-flight TTL. Raising that budget past 300s
// re-opens this and must re-open this decision with it.
//
// SEMANTIC — a conditional promote would be WORSE. A promote means "this event
// is decided; do not reprocess it for 7 days". Under a compare-and-delete-style
// guard the promote could FAIL and leave the 5-minute in-flight claim in place;
// that claim then lapses and a redelivery genuinely re-runs an event that was
// already decided — the double-remediation the dedup exists to prevent. The
// release path wants ownership because releasing early is the hazard; the
// promote path wants unconditional write because NOT marking is the hazard.
// Opposite failure directions, opposite mechanisms.

function redeliveryKey(agentId: string, externalId: string): string {
  return rk(`agent:trigger:seen:${agentId}:${externalId}`);
}

function cooldownKey(agentId: string, entity: TriggerEvent["entityRef"]): string {
  return rk(`agent:trigger:cooldown:${agentId}:${entity.kind}:${entity.id}`);
}

function isAgentCaused(causalActorSessionId: string | undefined): boolean {
  return (
    causalActorSessionId !== undefined &&
    causalActorSessionId.startsWith(AGENT_SESSION_NAMESPACE)
  );
}

/**
 * Run one trigger turn through the full dedup + host-cap stack. Pure of any
 * broker/queue concern — the worker (and the acceptance tests) call this with
 * an injected redis + runner, so every suppression path is deterministic.
 */
export async function processTriggerJob(
  job: TriggerJob,
  deps: ProcessTriggerJobDeps,
): Promise<TriggerOutcome> {
  const { agent, event } = job;
  const externalId = triggerExternalId(event);
  const journal =
    deps.journal ??
    ((entry: TriggerJournalEntry) =>
      logger.info({ component: "agent-trigger-bridge", ...entry }, "trigger processed"));
  const record = (outcome: TriggerOutcome): TriggerOutcome => {
    journal({
      event: "agent_trigger.bridge",
      agentId: agent.id,
      entity: `${event.entityRef.kind}:${event.entityRef.id}`,
      externalId,
      outcome,
    });
    return outcome;
  };

  // 1. Loop suppression — never re-wake an agent on its own side effect.
  if (isAgentCaused(job.causalActorSessionId)) {
    return record({ status: "suppressed", reason: "agent_loop" });
  }

  // 2. Redelivery dedup — two-phase claim on the deterministic carrier.
  //
  // F-21: the in-flight claims carry a per-invocation UUID rather than the
  // constant "1", because the catch path below RELEASES them and a release
  // without an ownership token is how one delivery destroys another's claim.
  // One token covers both claims: they are acquired and released together, by
  // the same invocation, so a second UUID would add ceremony and no isolation.
  const claimToken = randomUUID();
  const seenKey = redeliveryKey(agent.id, externalId);
  const cdKey = cooldownKey(agent.id, event.entityRef);
  const claimed = await deps.redis.set(seenKey, claimToken, {
    EX: REDELIVERY_INFLIGHT_TTL_S,
    NX: true,
  });
  if (claimed !== "OK") {
    return record({ status: "suppressed", reason: "redelivery" });
  }

  try {
    // 3. Per-entity cooldown — at most one remediation per entity per window.
    if (agent.budgets.cooldownSeconds > 0) {
      const cooled = await deps.redis.set(cdKey, claimToken, {
        EX: agent.budgets.cooldownSeconds,
        NX: true,
      });
      if (cooled !== "OK") {
        // Decided (suppressed by cooldown): promote the seen-key (plain SET,
        // overwriting the in-flight TTL) so a later redelivery of THIS event
        // short-circuits at step 2 rather than re-walking the cooldown.
        // Ownership-blind BY DESIGN — see PROMOTE-OVERWRITE below.
        await deps.redis.set(seenKey, DONE_MARKER, { EX: REDELIVERY_DONE_TTL_S });
        return record({ status: "suppressed", reason: "cooldown" });
      }
    }

    // 4. Run under host hard caps (wall-clock deadline + model-call budget).
    const result = await runWithWallClock(agent, () => deps.runner, event, deps.now);

    // Confirm: promote the redelivery claim to the full window (plain SET,
    // overwriting the short in-flight TTL). Ownership-blind BY DESIGN — see
    // PROMOTE-OVERWRITE below.
    await deps.redis.set(seenKey, DONE_MARKER, { EX: REDELIVERY_DONE_TTL_S });
    return record({
      status: "ran",
      decisionKind: result.decisionKind,
      modelCalls: result.modelCalls,
    });
  } catch (err) {
    // The turn threw — no decision was reached. Release BOTH the in-flight
    // redelivery claim AND the cooldown claim so a BullMQ retry genuinely
    // reprocesses (at-least-once) rather than being short-circuited as a
    // redelivery or a cooldown hit. Best-effort — the short in-flight TTL
    // bounds the redelivery claim regardless.
    //
    // F-21: ownership-CONDITIONAL. The pre-rollout form was
    // `del(seenKey); del(cdKey)`, which destroys whatever is at those keys NOW.
    // If this invocation's in-flight claim had already lapsed and a later
    // delivery re-claimed the carrier, this catch deleted the LIVE claim of a
    // turn that was still running, plus a cooldown that delivery had just
    // established — waking the agent twice on one entity, past the very
    // cooldown that bounds remediation attempts. With the token the release is
    // a no-op in that interleaving and the other delivery keeps its claims;
    // the comment above already names the in-flight TTL as the backstop, and
    // leave-to-TTL is exactly what a non-owner should fall back to (F-22's
    // failure direction: never a blind DEL without ownership proof).
    try {
      await deps.redis.compareAndDelete(seenKey, claimToken);
      await deps.redis.compareAndDelete(cdKey, claimToken);
    } catch {
      /* in-flight TTL guarantees eventual expiry */
    }
    return record({ status: "failed", error: String(err) });
  }
}

/**
 * Enforce `budgets.wallClockMsPerTrigger`: race the turn against a deadline
 * timer; on timeout, abort the controller (so a signal-aware runner unwinds)
 * and reject. The model-call cap rides {@link createModelCallCap} inside the
 * composition, not here (the bridge cannot see individual model calls).
 */
async function runWithWallClock(
  agent: AgentDefinition,
  getRunner: () => TriggerTurnRunner,
  event: TriggerEvent,
  _now: (() => number) | undefined,
): Promise<TriggerTurnResult> {
  const controller = new AbortController();
  const sessionId = agentSessionId(agent, event.entityRef.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `wall-clock cap exceeded (${agent.budgets.wallClockMsPerTrigger}ms)`,
        ),
      );
    }, agent.budgets.wallClockMsPerTrigger);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([
      getRunner()({
        agent,
        event,
        sessionId,
        signal: controller.signal,
        maxModelCalls: agent.budgets.maxModelCallsPerTrigger,
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── Model-call cap wrapper (host hard cap; used by the T3-6 composition) ─────

/**
 * Wrap a {@link ModelProvider} so the turn can make at most `maxCalls`
 * completions; the `(maxCalls + 1)`-th throws. This is the host-level
 * `maxModelCallsPerTrigger` cap — composed into the agent Conductor's planner +
 * responder model so a runaway plan/respond loop cannot burn unbounded tokens.
 * Each trigger turn gets a FRESH wrapper (the counter is per-turn).
 */
export function createModelCallCap(
  model: ModelProvider,
  maxCalls: number,
): ModelProvider & { readonly calls: () => number } {
  let calls = 0;
  const guard = () => {
    calls += 1;
    if (calls > maxCalls) {
      throw new Error(
        `model-call cap exceeded (${maxCalls} per trigger)`,
      );
    }
  };
  return {
    async complete(req) {
      // async so an over-budget guard surfaces as a rejected promise (the
      // planner awaits complete(); a synchronous throw would escape that await).
      guard();
      return model.complete(req);
    },
    stream(req) {
      // stream() is synchronous in the ModelProvider contract (returns a
      // CancellableStream); the guard throw is synchronous to match.
      guard();
      return model.stream(req);
    },
    embed(text) {
      // Embedding is grounding/retrieval, not a planner/responder turn call —
      // it does not count against the per-trigger model-call budget.
      return model.embed(text);
    },
    calls: () => calls,
  };
}

// ── Bridge lifecycle (NATS subscribe + BullMQ worker) ────────────────────────

export const TRIGGER_QUEUE_NAME = "agent-trigger";
const TRIGGER_QUEUE_GROUP = "ibatexas-trigger-bridge";

/** Persisted BullMQ job payload. */
interface TriggerJobData {
  readonly agentId: string;
  readonly event: TriggerEvent;
  readonly causalActorSessionId?: string;
}

/**
 * Map a raw NATS payload (for a subject the agent subscribes to) into a
 * {@link TriggerJob} candidate, or `null` to drop it (e.g. an event kind the
 * agent does not act on, or an entity whose customer cannot be resolved). The
 * mapper owns the order→customer resolution the payment events lack a field for
 * (T3-9 supplies the real one); kept injected so the bridge stays product-agnostic.
 */
export type TriggerEventMapper = (
  agent: AgentDefinition,
  subject: string,
  payload: Record<string, unknown>,
) => Promise<TriggerJob | null> | TriggerJob | null;

export interface AgentTriggerBridgeDeps {
  readonly registry: ReadonlyArray<AgentDefinition>;
  readonly runner: TriggerTurnRunner;
  readonly redis: TriggerDedupRedis;
  readonly mapEvent: TriggerEventMapper;
  readonly journal?: (entry: TriggerJournalEntry) => void;
  readonly now?: () => number;
}

export interface AgentTriggerBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Compose the trigger bridge over the agent registry. `start()` asserts roster
 * integrity (fail-closed) then subscribes every agent's trigger subjects and
 * starts the dedup worker; `stop()` tears both down.
 */
export function createAgentTriggerBridge(
  deps: AgentTriggerBridgeDeps,
): AgentTriggerBridge {
  let queue: Queue | null = null;
  let worker: Worker | null = null;
  const subscriptions: Array<{ unsubscribe: () => void }> = [];

  const byId = new Map(deps.registry.map((a) => [a.id, a]));

  return {
    async start() {
      // Fail-closed: a roster-invalid process must never open an agent capsule.
      assertAgentRosterIntegrity(deps.registry);

      queue = createQueue(TRIGGER_QUEUE_NAME);
      const q = queue;

      worker = createWorker(TRIGGER_QUEUE_NAME, async (job: Job) => {
        const data = job.data as TriggerJobData;
        const agent = byId.get(data.agentId);
        if (agent === undefined) {
          // Roster changed under a queued job — drop loudly, do not crash.
          logger.warn(
            { component: "agent-trigger-bridge", agentId: data.agentId },
            "queued trigger for unknown agent id — dropping",
          );
          return;
        }
        await processTriggerJob(
          {
            agent,
            event: data.event,
            ...(data.causalActorSessionId === undefined
              ? {}
              : { causalActorSessionId: data.causalActorSessionId }),
          },
          {
            redis: deps.redis,
            runner: deps.runner,
            ...(deps.journal === undefined ? {} : { journal: deps.journal }),
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
        );
      });

      // Subscribe each agent's trigger subjects; qualify + enqueue per delivery.
      for (const agent of deps.registry) {
        for (const subject of agent.trigger.subjects) {
          const sub = await subscribeNatsEvent(
            subject,
            async (payload) => {
              const eventKind = String(
                ((payload as { eventType?: unknown }).eventType ??
                  (payload as { kind?: unknown }).kind ??
                  "") as string,
              );
              if (
                eventKind.length > 0 &&
                !agent.trigger.eventKinds.includes(eventKind)
              ) {
                return; // not a kind this agent acts on
              }
              const candidate = await deps.mapEvent(agent, subject, payload);
              if (candidate === null) return;
              const externalId = triggerExternalId(candidate.event);
              await q.add(
                eventKind || candidate.event.kind,
                {
                  agentId: agent.id,
                  event: candidate.event,
                  ...(candidate.causalActorSessionId === undefined
                    ? {}
                    : { causalActorSessionId: candidate.causalActorSessionId }),
                } satisfies TriggerJobData,
                {
                  // Queue-layer redelivery dedup (stripe-webhook-processor.ts:86).
                  jobId: `${agent.id}:${externalId}`,
                  removeOnComplete: true,
                },
              );
            },
            { queueGroup: TRIGGER_QUEUE_GROUP },
          );
          subscriptions.push(sub);
        }
      }
    },

    async stop() {
      for (const sub of subscriptions.splice(0)) {
        try {
          sub.unsubscribe();
        } catch {
          /* best-effort teardown */
        }
      }
      if (worker !== null) {
        await worker.close();
        worker = null;
      }
      if (queue !== null) {
        await queue.close();
        queue = null;
      }
    },
  };
}
