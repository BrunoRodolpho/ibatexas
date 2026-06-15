// Real-money safety rails (P1 blast-radius callout): the fail-closed boot
// assertion + the proactive refund circuit breaker.

import { describe, it, expect, vi } from "vitest";
import type { AgentDefinition } from "@ibatexas/agents";
import {
  REAL_MONEY_KINDS,
  isRealMoneyKind,
  assertRealMoneyConfirmGuards,
  createRefundCircuitBreaker,
  type BreakerRedis,
} from "../claustrum/agent-realmoney-safety.js";

function agent(declaredIntentKinds: string[]): AgentDefinition {
  return {
    id: "pix-payment-failure-remediation",
    version: "0.1.0",
    displayName: "x",
    declaredIntentKinds: declaredIntentKinds as AgentDefinition["declaredIntentKinds"],
    trigger: { subjects: ["payment.status_changed"], eventKinds: ["payment.failed"] },
    budgets: {
      maxModelCallsPerTrigger: 1,
      wallClockMsPerTrigger: 1_000,
      tokensPerDay: 1_000,
      cooldownSeconds: 0,
    },
    killSwitchKey: "agent:pix-payment-failure-remediation",
    owner: "o@e.com",
    sessionIdPrefix: "agent:pix-payment-failure-remediation@0.1.0",
  } as AgentDefinition;
}

describe("isRealMoneyKind / REAL_MONEY_KINDS", () => {
  it("pix.charge.refund is a real-money kind", () => {
    expect(isRealMoneyKind("pix.charge.refund")).toBe(true);
    expect(REAL_MONEY_KINDS.has("pix.charge.refund")).toBe(true);
  });
  it("a regenerate kind is not real money", () => {
    expect(isRealMoneyKind("payment.pix.regenerate")).toBe(false);
  });
});

describe("assertRealMoneyConfirmGuards (fail-closed boot assertion)", () => {
  const registry = [agent(["payment.pix.regenerate", "pix.charge.refund"])];

  it("passes when every declared real-money kind is confirm-gated", () => {
    expect(() =>
      assertRealMoneyConfirmGuards(registry, new Set(["pix.charge.refund"])),
    ).not.toThrow();
  });

  it("THROWS (crashes the boot) when a declared real-money kind has no confirm guard", () => {
    expect(() => assertRealMoneyConfirmGuards(registry, new Set())).toThrow(
      /real-money safety conformance failed/,
    );
  });

  it("passes for an agent that declares no real-money kinds", () => {
    expect(() =>
      assertRealMoneyConfirmGuards([agent(["payment.pix.regenerate"])], new Set()),
    ).not.toThrow();
  });
});

describe("createRefundCircuitBreaker", () => {
  function fakeRedis(): BreakerRedis & { counts: Map<string, number> } {
    const counts = new Map<string, number>();
    return {
      counts,
      async incr(key) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n;
      },
      async expire() {
        return 1;
      },
    };
  }

  it("allows up to maxPerWindow then trips", async () => {
    const redis = fakeRedis();
    const breaker = createRefundCircuitBreaker({ redis, maxPerWindow: 2, windowSeconds: 60 });
    expect(await breaker.tryConsume("a")).toBe(true); // 1
    expect(await breaker.tryConsume("a")).toBe(true); // 2
    expect(await breaker.tryConsume("a")).toBe(false); // 3 — tripped
    expect(await breaker.tryConsume("a")).toBe(false); // stays tripped
  });

  it("sets the window TTL exactly once (on the first attempt)", async () => {
    const redis = fakeRedis();
    const expireSpy = vi.spyOn(redis, "expire");
    const breaker = createRefundCircuitBreaker({ redis, maxPerWindow: 5, windowSeconds: 30 });
    await breaker.tryConsume("a");
    await breaker.tryConsume("a");
    expect(expireSpy).toHaveBeenCalledTimes(1);
    expect(expireSpy).toHaveBeenCalledWith(expect.any(String), 30);
  });

  it("tracks each agent independently", async () => {
    const redis = fakeRedis();
    const breaker = createRefundCircuitBreaker({ redis, maxPerWindow: 1, windowSeconds: 60 });
    expect(await breaker.tryConsume("a")).toBe(true);
    expect(await breaker.tryConsume("b")).toBe(true); // different agent, own budget
    expect(await breaker.tryConsume("a")).toBe(false); // a is now over
  });

  it("FAILS CLOSED on a Redis error (a money breaker must never open on an outage)", async () => {
    const breaker = createRefundCircuitBreaker({
      redis: {
        async incr() {
          throw new Error("redis down");
        },
        async expire() {
          return 1;
        },
      },
      maxPerWindow: 5,
    });
    expect(await breaker.tryConsume("a")).toBe(false);
  });
});
