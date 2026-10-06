// F-21 (class rollout, site 2) — the trigger-dedup composition root's contract.
//
// Three things are pinned here, none of which need a Redis server:
//
//   1. The COMPILE contract. `TriggerDedupRedis.compareAndDelete` is REQUIRED,
//      so a composer that omits it is a `tsc` error rather than a runtime
//      TypeError on the first failed agent turn. Demonstrated with
//      `@ts-expect-error`, which is itself checked: if the omission ever
//      started compiling, the directive would become an "unused" error and
//      `tsc --noEmit` would red.
//   2. The WIRE. `compareAndDelete` issues the compare-and-delete script with
//      exactly the key and token it was handed — spy-delegate pins, so a
//      rename or an argument swap shows up here and not in production.
//   3. The SEAM that was actually broken: the object the pre-F-21 code passed
//      (a `RedisLedgerClient`-shaped `set`/`get`/`del` literal) does not
//      satisfy the source contract, so the `as unknown as` cast that hid that
//      cannot be written accidentally again.
//
// The ATOMICITY of the script is NOT a claim of this file — that is proven
// against a real server in `__tests__/agent-trigger-dedup-ownership.test.ts`.

import { describe, expect, it, vi } from "vitest";
import {
  createTriggerDedupRedis,
  TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT,
  type TriggerDedupRedisSource,
} from "../trigger-dedup-redis.js";
import type { TriggerDedupRedis } from "../agent-trigger-bridge.js";

function sourceSpy(evalResult: unknown = 1) {
  return {
    set: vi.fn(async () => "OK" as const),
    eval: vi.fn(async () => evalResult),
  } satisfies TriggerDedupRedisSource;
}

describe("createTriggerDedupRedis — the wire", () => {
  it("compareAndDelete issues the compare-and-delete script with the key and token", async () => {
    const client = sourceSpy(1);
    const redis = createTriggerDedupRedis(client);

    const result = await redis.compareAndDelete("k:seen", "tok-123");

    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledWith(
      TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT,
      { keys: ["k:seen"], arguments: ["tok-123"] },
    );
    expect(result).toBe(1);
  });

  it("compareAndDelete NUMBERs the reply (node-redis can answer a non-number)", async () => {
    // A guard against the shape that would make `=== 1` silently false: the
    // client's declared reply type is `unknown`, and a string "0" is truthy.
    const redis = createTriggerDedupRedis(sourceSpy("0"));
    expect(await redis.compareAndDelete("k", "t")).toBe(0);
  });

  it("the script compares GET against ARGV[1] and deletes only on a match", () => {
    // A byte-level pin on the one property the whole fix rests on. Reading the
    // script is the only way to see that it is a CONDITIONAL delete; a test
    // that only checked "eval was called" would pass with `return redis.call('DEL', KEYS[1])`.
    expect(TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT).toContain(
      "redis.call('GET', KEYS[1]) == ARGV[1]",
    );
    expect(TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT).toContain(
      "redis.call('DEL', KEYS[1])",
    );
    expect(TRIGGER_DEDUP_COMPARE_AND_DELETE_SCRIPT).toContain("return 0");
  });

  it("set forwards its options untouched (the NX claim and the promote both ride it)", async () => {
    const client = sourceSpy();
    const redis = createTriggerDedupRedis(client);

    await redis.set("k:seen", "tok", { EX: 300, NX: true });
    expect(client.set).toHaveBeenCalledWith("k:seen", "tok", {
      EX: 300,
      NX: true,
    });

    await redis.set("k:seen", "1", { EX: 604_800 });
    expect(client.set).toHaveBeenLastCalledWith("k:seen", "1", { EX: 604_800 });
  });

  it("exposes NO del — nothing on this path may delete unconditionally", () => {
    const redis = createTriggerDedupRedis(sourceSpy());
    expect((redis as unknown as Record<string, unknown>)["del"]).toBeUndefined();
  });
});

describe("TriggerDedupRedis — the COMPILE contract", () => {
  it("a composer that omits compareAndDelete does not type-check", () => {
    // THE DEMONSTRATION. `@ts-expect-error` asserts that the next line IS a
    // compile error; `tsc --noEmit` fails on this file if it ever stops being
    // one. That is what makes "REQUIRED, never optional" a checked claim rather
    // than a comment — the R5-S12 `DeferRedis` lesson, where three optional
    // members were silently skipped by a client that omitted them.
    // @ts-expect-error — compareAndDelete is REQUIRED on TriggerDedupRedis
    const incomplete: TriggerDedupRedis = {
      set: async () => "OK",
    };
    void incomplete;

    // The complete composer is accepted — a control, so the case above cannot
    // be passing because the type is broken in some other way.
    const complete: TriggerDedupRedis = {
      set: async () => "OK",
      compareAndDelete: async () => 1,
    };
    expect(typeof complete.compareAndDelete).toBe("function");
  });

  it("the pre-F-21 ledger-shaped client does not satisfy the SOURCE contract", () => {
    // `managed-agent-plane.ts:187` used to read
    // `deps.redis as unknown as TriggerDedupRedis`, where `deps.redis` was the
    // object literal `buildLedgerClient()` returns: set/get/del and nothing
    // else. The cast compiled and was false — no `eval` at runtime. Pinning the
    // rejection here means a future composer cannot re-introduce that shape
    // without the compiler objecting.
    const ledgerShaped = {
      set: async () => "OK" as const,
      get: async () => null,
      del: async () => 1,
    };
    // @ts-expect-error — a set/get/del client cannot serve the CAD (no `eval`)
    const composed = createTriggerDedupRedis(ledgerShaped);
    void composed;

    // Control: adding the missing command makes the SAME call compile, so the
    // rejection above is about `eval` specifically and not about the literal.
    const capable = { ...ledgerShaped, eval: async () => 1 };
    expect(createTriggerDedupRedis(capable)).toBeDefined();
  });
});
