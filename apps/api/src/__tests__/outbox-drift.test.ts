// Drift guard for outbox durability (P0-PAY-4).
//
// OUTBOX_EVENTS (@ibatexas/nats-client) is the set actually persisted to the Redis
// outbox; CRITICAL_EVENTS (outbox-retry) is the set the retry job re-publishes. An
// event in the retry set but not the persisted set has an always-empty LRANGE —
// nothing recoverable — so a transient publish failure silently loses it (exactly
// how payment.status_changed regressed). CRITICAL_EVENTS now derives from
// OUTBOX_EVENTS; this test pins that invariant.

import { describe, it, expect, vi } from "vitest";

// outbox-retry imports @ibatexas/tools (getRedisClient/rk), whose dist pulls the
// @adjudicate/domain chain; mock it so this test collects.
vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(),
  rk: vi.fn((k: string) => k),
}));

import { OUTBOX_EVENTS } from "@ibatexas/nats-client";
import { CRITICAL_EVENTS } from "../jobs/outbox-retry.js";

describe("outbox durability set drift guard (P0-PAY-4)", () => {
  it("retried CRITICAL_EVENTS equals persisted OUTBOX_EVENTS", () => {
    expect([...CRITICAL_EVENTS].sort()).toEqual([...OUTBOX_EVENTS].sort());
  });

  it("includes payment.status_changed (the regressed event)", () => {
    expect(OUTBOX_EVENTS.has("payment.status_changed")).toBe(true);
    expect(CRITICAL_EVENTS).toContain("payment.status_changed");
  });
});
