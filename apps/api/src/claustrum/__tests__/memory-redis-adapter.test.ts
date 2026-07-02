// Verifies the node-redis v4 → ioredis-shaped RedisClientLike shim the @claustrum
// memory provider consumes. The provider calls `setex` / `pipeline().del().exec()`
// (ioredis names); node-redis v4 exposes `setEx` / `multi`. The shim must bridge
// them — the original recall fail-safe degrade was a `setex is not a function`
// throw that this adapter eliminates.

import { describe, expect, it, vi } from "vitest";
import { toMemoryRedisClient } from "../memory-redis-adapter.js";

function fakeNodeRedis() {
  return {
    get: vi.fn(async (_k: string) => "v"),
    setEx: vi.fn(async (_k: string, _s: number, _v: string) => "OK"),
    del: vi.fn(async (_keys: string[]) => 1),
    // present so a careless map onto `multi` would be observable; the shim must
    // NOT use it (it coalesces DELs through `del`).
    multi: vi.fn(),
  };
}

describe("toMemoryRedisClient", () => {
  it("maps ioredis `setex` onto node-redis `setEx`", async () => {
    const r = fakeNodeRedis();
    const client = toMemoryRedisClient(r as never);
    await client.setex("k", 30, "val");
    expect(r.setEx).toHaveBeenCalledWith("k", 30, "val");
  });

  it("delegates get and returns the value", async () => {
    const r = fakeNodeRedis();
    const client = toMemoryRedisClient(r as never);
    expect(await client.get("k")).toBe("v");
    expect(r.get).toHaveBeenCalledWith("k");
  });

  it("del passes the spread keys as a single array to node-redis", async () => {
    const r = fakeNodeRedis();
    const client = toMemoryRedisClient(r as never);
    await client.del("a", "b");
    expect(r.del).toHaveBeenCalledWith(["a", "b"]);
  });

  it("del with no keys is a no-op (no node-redis call, returns 0)", async () => {
    const r = fakeNodeRedis();
    const client = toMemoryRedisClient(r as never);
    expect(await client.del()).toBe(0);
    expect(r.del).not.toHaveBeenCalled();
  });

  it("pipeline().del().exec() coalesces into one node-redis del, never multi", async () => {
    const r = fakeNodeRedis();
    const client = toMemoryRedisClient(r as never);
    await client.pipeline().del("a").del("b", "c").exec();
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.del).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(r.multi).not.toHaveBeenCalled();
  });

  it("an empty pipeline exec issues no del", async () => {
    const r = fakeNodeRedis();
    const client = toMemoryRedisClient(r as never);
    await client.pipeline().exec();
    expect(r.del).not.toHaveBeenCalled();
  });
});
