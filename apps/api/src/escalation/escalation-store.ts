// Escalation state + bot-pause (responder-trace-admin D2).
//
// When a turn ESCALATEs (support.handoff_requested), a human takes over the
// session. We need: (a) a queue of open escalations for staff; (b) a CHEAP
// per-session "paused for human" check on the hot path so the LLM stops
// auto-replying once a human is handling it. Per the plan this is backed by
// Redis (not a per-turn DB hit, and no Prisma migration): the escalation
// lifecycle is operational state, not the kernel audit ledger.
//
// Keys (via rk(), Hard Rule #7):
//   escalation:rec:<sessionId>  → JSON EscalationRecord
//   escalation:open             → SET of sessionIds with an OPEN escalation
//
// The pause is active for as long as the escalation is OPEN; resolving it
// un-pauses the session (the bot resumes auto-replying).

import { getRedisClient, rk } from "@ibatexas/tools";

export interface EscalationRecord {
  readonly sessionId: string;
  readonly customerId: string | null;
  readonly reason: string | null;
  readonly channel: string | null;
  readonly handoffAt: string;
  readonly status: "open" | "resolved";
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
}

/** Minimal node-redis v4 surface the store uses (injectable for tests). */
export interface EscalationRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sAdd(key: string, member: string): Promise<unknown>;
  sRem(key: string, member: string): Promise<unknown>;
  sMembers(key: string): Promise<string[]>;
}

export interface EscalationStore {
  /** Record (idempotently) that a session escalated to a human. */
  recordHandoff(input: {
    sessionId: string;
    customerId?: string | null;
    reason?: string | null;
    channel?: string | null;
    at: string;
  }): Promise<EscalationRecord>;
  get(sessionId: string): Promise<EscalationRecord | null>;
  /** Cheap hot-path check: is this session currently handled by a human? */
  isPaused(sessionId: string): Promise<boolean>;
  /** Resolve an open escalation → un-pauses the session. */
  resolve(
    sessionId: string,
    resolvedBy: string,
    at: string,
  ): Promise<EscalationRecord | null>;
  /** The open-escalation queue (newest handoff first). */
  listOpen(limit?: number): Promise<EscalationRecord[]>;
}

const OPEN_SET = (): string => rk("escalation:open");
const recKey = (sessionId: string): string => rk(`escalation:rec:${sessionId}`);

function parse(raw: string | null): EscalationRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EscalationRecord;
  } catch {
    return null;
  }
}

export function createEscalationStore(redis: EscalationRedis): EscalationStore {
  const store: EscalationStore = {
    async get(sessionId) {
      return parse(await redis.get(recKey(sessionId)));
    },

    async recordHandoff(input) {
      const existing = parse(await redis.get(recKey(input.sessionId)));
      // Idempotent on NATS redelivery: keep the original open record (handoffAt,
      // reason) rather than resetting it.
      if (existing && existing.status === "open") return existing;
      const rec: EscalationRecord = {
        sessionId: input.sessionId,
        customerId: input.customerId ?? null,
        reason: input.reason ?? null,
        channel: input.channel ?? null,
        handoffAt: input.at,
        status: "open",
      };
      await redis.set(recKey(input.sessionId), JSON.stringify(rec));
      await redis.sAdd(OPEN_SET(), input.sessionId);
      return rec;
    },

    async isPaused(sessionId) {
      const rec = parse(await redis.get(recKey(sessionId)));
      return rec?.status === "open";
    },

    async resolve(sessionId, resolvedBy, at) {
      const rec = parse(await redis.get(recKey(sessionId)));
      await redis.sRem(OPEN_SET(), sessionId);
      if (!rec) return null;
      const updated: EscalationRecord = {
        ...rec,
        status: "resolved",
        resolvedAt: at,
        resolvedBy,
      };
      await redis.set(recKey(sessionId), JSON.stringify(updated));
      return updated;
    },

    async listOpen(limit = 100) {
      const members = await redis.sMembers(OPEN_SET());
      const recs = await Promise.all(
        members.map((id) => redis.get(recKey(id)).then(parse)),
      );
      const open: EscalationRecord[] = [];
      for (let i = 0; i < members.length; i++) {
        const rec = recs[i];
        if (rec && rec.status === "open") {
          open.push(rec);
        } else {
          // Self-heal: a missing/resolved record left a stale set member.
          await redis.sRem(OPEN_SET(), members[i]!);
        }
      }
      open.sort((a, b) => (a.handoffAt < b.handoffAt ? 1 : -1));
      return open.slice(0, Math.max(0, limit));
    },
  };
  return store;
}

/** Lazily build a store over the shared redis client. */
export async function getEscalationStore(): Promise<EscalationStore> {
  const redis = (await getRedisClient()) as unknown as EscalationRedis;
  return createEscalationStore(redis);
}

/**
 * Hot-path bot-pause gate. Best-effort + fail-OPEN: a Redis hiccup must NEVER
 * wedge the conversational pipeline into permanent silence — if we can't read
 * the flag, the bot keeps replying (a missed pause is recoverable; a stuck-mute
 * bot is not). Returns true only when an OPEN escalation is confirmed.
 */
export async function isSessionPausedForHuman(sessionId: string): Promise<boolean> {
  try {
    const store = await getEscalationStore();
    return await store.isPaused(sessionId);
  } catch {
    return false;
  }
}
