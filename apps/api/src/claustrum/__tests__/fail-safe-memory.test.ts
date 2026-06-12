// fail-safe-memory.ts — degraded-not-crashed semantics (D-012).
//
// The wrapper exists because the domain PrismaClient has no
// claustrum_memory_* delegates: the postgres memory adapter's cold path is a
// TypeError on every cache-cold turn, and handleTurn awaits recall() with no
// catch. These tests pin BOTH directions: pass-through when the inner port
// works, empty-shape degradation (never a rejection) when it throws.
import { describe, it, expect, vi } from "vitest";
import type { MemoryPort } from "@claustrum/core";
import { failSafeMemory } from "../fail-safe-memory.js";

const PERCEPTION = {
  text: "oi",
  channel: "web",
  receivedAt: "2026-06-12T12:00:00.000Z",
} as Parameters<MemoryPort["recall"]>[1];

function throwingPort(): MemoryPort {
  const boom = new TypeError("Cannot read properties of undefined (reading 'findMany')");
  return {
    recall: () => Promise.reject(boom),
    observe: () => Promise.reject(boom),
    search: () => Promise.reject(boom),
    recentActions: () => Promise.reject(boom),
  };
}

describe("failSafeMemory", () => {
  it("passes through when the inner port succeeds (no behavioral change)", async () => {
    const snapshot = {
      customerId: "cust-1",
      episodic: [],
      semantic: [],
      procedural: [],
      relational: [],
      assembledAt: "2026-06-12T12:00:00.000Z",
    };
    const observe = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const port = failSafeMemory(
      {
        recall: vi.fn().mockResolvedValue(snapshot),
        observe,
        search: vi.fn().mockResolvedValue([]),
        recentActions: vi.fn().mockResolvedValue([]),
      },
      { onError },
    );

    await expect(port.recall("cust-1", PERCEPTION)).resolves.toBe(snapshot);
    await port.observe("cust-1", {
      turnId: "t1",
      conversationId: "c1",
      at: "2026-06-12T12:00:00.000Z",
    });
    expect(observe).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("recall degrades to an EMPTY snapshot instead of rejecting the turn", async () => {
    const onError = vi.fn();
    const port = failSafeMemory(throwingPort(), { onError });

    const snapshot = await port.recall("cust-1", PERCEPTION);
    expect(snapshot.customerId).toBe("cust-1");
    expect(snapshot.episodic).toEqual([]);
    expect(snapshot.semantic).toEqual([]);
    expect(snapshot.procedural).toEqual([]);
    expect(snapshot.relational).toEqual([]);
    expect(typeof snapshot.assembledAt).toBe("string");
    expect(onError).toHaveBeenCalledWith("recall", expect.any(TypeError));
  });

  it("observe/search/recentActions degrade (no-op / empty) and report the op", async () => {
    const onError = vi.fn();
    const port = failSafeMemory(throwingPort(), { onError });

    await expect(
      port.observe("cust-1", {
        turnId: "t1",
        conversationId: "c1",
        at: "2026-06-12T12:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    await expect(port.search("cust-1", { semantic: "x" }, 3)).resolves.toEqual([]);
    await expect(port.recentActions("cust-1", new Date(0))).resolves.toEqual([]);

    expect(onError.mock.calls.map((c) => c[0])).toEqual([
      "observe",
      "search",
      "recentActions",
    ]);
  });
});
