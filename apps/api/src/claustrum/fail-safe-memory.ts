// Fail-safe MemoryPort wrapper (sibling of fail-safe-grounding.ts — D-009's
// pattern applied to the memory port; recorded as D-012).
//
// `handleTurn` awaits `capsule.memory.recall(...)` with no catch (the
// UNDERSTAND Promise.all in @claustrum/core handle-turn.ts:69), and the
// composed provider throws on every COLD-PATH call today:
// `createPostgresMemoryProvider` reads `prisma.claustrum_memory_*` delegates
// (postgres-memory-provider.ts:164-183), but the injected client is
// `@ibatexas/domain`'s generated PrismaClient, whose schema declares NO
// claustrum_memory_* models — the delegate is `undefined` and `.findMany`
// is a TypeError. (The SQL tables exist — `ibx claustrum migrate` provisions
// them — the gap is the Prisma CLIENT surface; the bootstrap's own cast
// comment already acknowledged the missing structural slices.) Without this
// wrapper EVERY conversational turn whose Redis snapshot is cold rejects
// before the planner runs and the chat routes answer "Erro interno." —
// discovered by the first real chat turn driven against the SUT (T1a-5's
// live contract test).
//
// Failure semantics mirror fail-safe-grounding.ts: a memory outage DEGRADES
// (empty recall/search/recentActions, dropped observe — the turn simply runs
// without long-term memory), it never crashes a turn. The money path is
// untouched: memory is advisory context for the planner; every mutation
// still flows through the kernel.
//
// This is containment, not the fix. The product gap (domain Prisma schema
// lacks the claustrum_memory_* models the installed @claustrum/memory-postgres
// adapter consumes) is recorded in docs/agents/decisions.md (D-012); adding
// the models (or a pgPool-backed adapter) is a schema decision deliberately
// not made here.

import type { MemoryPort } from "@claustrum/core";

type MemoryOp = "recall" | "observe" | "search" | "recentActions";

export function failSafeMemory(
  inner: MemoryPort,
  opts: {
    readonly onError: (op: MemoryOp, err: unknown) => void;
  },
): MemoryPort {
  return {
    async recall(customerId, perception) {
      try {
        return await inner.recall(customerId, perception);
      } catch (err) {
        opts.onError("recall", err);
        // Empty snapshot — the cognitive loop proceeds memory-less.
        return {
          customerId,
          episodic: [],
          semantic: [],
          procedural: [],
          relational: [],
          assembledAt: new Date().toISOString(),
        };
      }
    },
    async observe(customerId, turn) {
      try {
        await inner.observe(customerId, turn);
      } catch (err) {
        // Losing a memory write degrades personalization only — the
        // governance trail lives in the kernel audit ledger, not here.
        opts.onError("observe", err);
      }
    },
    async search(customerId, query, k) {
      try {
        return await inner.search(customerId, query, k);
      } catch (err) {
        opts.onError("search", err);
        return [];
      }
    },
    async recentActions(customerId, since) {
      try {
        return await inner.recentActions(customerId, since);
      } catch (err) {
        opts.onError("recentActions", err);
        return [];
      }
    },
  };
}
