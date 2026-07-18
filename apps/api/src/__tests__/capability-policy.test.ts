/**
 * RC-A1 Stage 2 (Phase A.2) — capability PolicyBundle resolution.
 *
 * Proves the resolver/router that lets ONE kernel `adjudicate(envelope, state,
 * policy)` call serve the multi-pack ibatexas surface:
 *   - `resolveCapabilityPolicy` returns the owning pack's bundle by kind.
 *   - `composePolicyRouter` builds a single kind-dispatching bundle that, run
 *     through the REAL kernel, routes each kind to its owning pack's guards,
 *     applies that pack's taint floor, and fails CLOSED for unowned kinds.
 *
 * Pure fixtures (hand-built packs) — no `@ibatexas/pack-*` import, mirroring the
 * dependency-injected design of the module under test and the bridge-audit test.
 */

import { describe, expect, it, vi } from "vitest";
import { buildEnvelope, decisionExecute } from "@adjudicate/core";
import type { Decision, IntentEnvelope, Taint } from "@adjudicate/core";
import { adjudicate } from "@adjudicate/core/kernel";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";
import {
  composePolicyRouter,
  resolveCapabilityPolicy,
  type CapabilityPolicyPack,
} from "../claustrum/capability-policy.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EXECUTE: Decision = decisionExecute([]);

interface PackOverrides {
  stateGuards?: Guard<string, unknown, unknown>[];
  authGuards?: Guard<string, unknown, unknown>[];
  business?: Guard<string, unknown, unknown>[];
  minimumFor?: (kind: string) => Taint;
  default?: "REFUSE" | "EXECUTE";
}

/** Build a hand-rolled pack with configurable guards / taint / default. */
function mkPack(
  id: string,
  intents: string[],
  opts: PackOverrides = {},
): CapabilityPolicyPack {
  const policy: PolicyBundle<string, unknown, unknown> = {
    stateGuards: opts.stateGuards ?? [],
    authGuards: opts.authGuards ?? [],
    business: opts.business ?? [],
    taint: { minimumFor: opts.minimumFor ?? (() => "UNTRUSTED") },
    default: opts.default ?? "REFUSE",
  };
  return { id, intents, policy };
}

function envelope(
  kind: string,
  taint: Taint = "UNTRUSTED",
): IntentEnvelope<string, unknown> {
  return buildEnvelope({
    kind,
    payload: { ok: true },
    actor: { principal: "llm", sessionId: "web:cust-1" },
    taint,
    nonce: `n-${kind}`,
    createdAt: "2026-05-29T00:00:00.000Z",
  });
}

const ordersPack = (overrides: PackOverrides = {}) =>
  mkPack("fixture/orders", ["order.item.add", "order.checkout.create"], overrides);
const paymentsPack = (overrides: PackOverrides = {}) =>
  mkPack("fixture/payments", ["payment.create"], overrides);

// ── resolveCapabilityPolicy ─────────────────────────────────────────────────

describe("resolveCapabilityPolicy", () => {
  it("returns the owning pack's bundle for a known kind", () => {
    const orders = ordersPack();
    const payments = paymentsPack();
    expect(
      resolveCapabilityPolicy([orders, payments], "order.item.add"),
    ).toBe(orders.policy);
    expect(
      resolveCapabilityPolicy([orders, payments], "payment.create"),
    ).toBe(payments.policy);
  });

  it("returns null for a kind no pack owns", () => {
    expect(resolveCapabilityPolicy([ordersPack()], "reservation.book")).toBeNull();
  });

  it("throws when two packs claim the same intent kind", () => {
    const a = mkPack("fixture/a", ["order.item.add"]);
    const b = mkPack("fixture/b", ["order.item.add"]);
    expect(() => resolveCapabilityPolicy([a, b], "order.item.add")).toThrow(
      /claimed by both/,
    );
  });
});

// ── composePolicyRouter — structure + guards ─────────────────────────────────

describe("composePolicyRouter — well-formedness", () => {
  it("produces a structurally well-formed PolicyBundle (matches the bridge's check)", () => {
    const router = composePolicyRouter([ordersPack(), paymentsPack()]);
    expect(Array.isArray(router.stateGuards)).toBe(true);
    expect(Array.isArray(router.authGuards)).toBe(true);
    expect(Array.isArray(router.business)).toBe(true);
    expect(typeof router.taint).toBe("object");
    expect(typeof router.taint.minimumFor).toBe("function");
    expect(router.default).toBe("REFUSE");
  });

  it("fails loudly if any pack defaults EXECUTE (router assumes all REFUSE)", () => {
    expect(() =>
      composePolicyRouter([ordersPack({ default: "EXECUTE" })]),
    ).toThrow(/default.*EXECUTE/s);
  });

  it("propagates the kind-collision guard", () => {
    const a = mkPack("fixture/a", ["order.item.add"]);
    const b = mkPack("fixture/b", ["order.item.add"]);
    expect(() => composePolicyRouter([a, b])).toThrow(/claimed by both/);
  });
});

describe("composePolicyRouter — taint dispatch", () => {
  it("delegates minimumFor to the owning pack and floors unknown kinds at SYSTEM", () => {
    const orders = ordersPack({
      minimumFor: (k) => (k === "order.checkout.create" ? "TRUSTED" : "UNTRUSTED"),
    });
    const router = composePolicyRouter([orders, paymentsPack()]);
    expect(router.taint.minimumFor("order.checkout.create")).toBe("TRUSTED");
    expect(router.taint.minimumFor("order.item.add")).toBe("UNTRUSTED");
    expect(router.taint.minimumFor("payment.create")).toBe("UNTRUSTED");
    // Unowned kind → most restrictive floor (nothing can propose it).
    expect(router.taint.minimumFor("totally.unknown")).toBe("SYSTEM");
  });
});

describe("composePolicyRouter — guard routing (delegation by kind)", () => {
  it("runs ONLY the owning pack's guards for an envelope's kind", () => {
    const ordersBiz = vi.fn<Guard<string, unknown, unknown>>(() => EXECUTE);
    const paymentsBiz = vi.fn<Guard<string, unknown, unknown>>(() => EXECUTE);
    const router = composePolicyRouter([
      ordersPack({ business: [ordersBiz] }),
      paymentsPack({ business: [paymentsBiz] }),
    ]);

    // Invoke the composed business guard directly with an order envelope.
    router.business[0]!(envelope("order.item.add"), { channel: "web" });

    expect(ordersBiz).toHaveBeenCalledTimes(1);
    expect(paymentsBiz).not.toHaveBeenCalled();
  });

  it("returns the first non-null decision and short-circuits later guards", () => {
    const first = vi.fn<Guard<string, unknown, unknown>>(() => null);
    const second = vi.fn<Guard<string, unknown, unknown>>(() => EXECUTE);
    const third = vi.fn<Guard<string, unknown, unknown>>(() => null);
    const router = composePolicyRouter([
      ordersPack({ business: [first, second, third] }),
    ]);

    const decision = router.business[0]!(envelope("order.item.add"), {});

    expect(decision).toBe(EXECUTE);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled(); // short-circuited
  });

  it("returns null for an unowned kind (→ kernel applies the router default)", () => {
    const router = composePolicyRouter([ordersPack()]);
    expect(router.business[0]!(envelope("nope.unknown"), {})).toBeNull();
  });
});

// ── Real-kernel integration — the router IS a valid kernel policy ────────────

describe("composePolicyRouter — through the real kernel adjudicate()", () => {
  it("reaches EXECUTE for an owned kind whose owning pack authorizes it", () => {
    const router = composePolicyRouter([
      ordersPack({ business: [() => EXECUTE] }),
      paymentsPack(),
    ]);
    const decision = adjudicate(envelope("order.item.add"), { channel: "web" }, router);
    expect(decision.kind).toBe("EXECUTE");
  });

  it("REFUSEs an unowned kind (fail-closed default)", () => {
    const router = composePolicyRouter([ordersPack({ business: [() => EXECUTE] })]);
    const decision = adjudicate(
      envelope("reservation.book"),
      { channel: "web" },
      router,
    );
    expect(decision.kind).toBe("REFUSE");
  });

  it("REFUSEs at the taint gate when the kind requires more trust than the envelope carries", () => {
    const router = composePolicyRouter([
      ordersPack({
        business: [() => EXECUTE],
        minimumFor: (k) =>
          k === "order.checkout.create" ? "TRUSTED" : "UNTRUSTED",
      }),
    ]);
    // UNTRUSTED (rank 1) cannot satisfy a TRUSTED (rank 2) floor → REFUSE,
    // and the business guard must never run (taint gate precedes it).
    const decision = adjudicate(
      envelope("order.checkout.create", "UNTRUSTED"),
      { channel: "web" },
      router,
    );
    expect(decision.kind).toBe("REFUSE");
  });

  it("REFUSEs an owned kind when no guard authorizes it (pack default REFUSE)", () => {
    const router = composePolicyRouter([ordersPack({ business: [() => null] })]);
    const decision = adjudicate(envelope("order.item.add"), { channel: "web" }, router);
    expect(decision.kind).toBe("REFUSE");
  });
});
