/**
 * Adopter guard factory — proves `createPixPendingDeferGuard` works
 * when an adopter dispatches PIX-pending decisions through their own
 * intent kind, not the Pack's `pix.charge.confirm`.
 *
 * IbateXas is the canonical example: the LLM proposes `order.confirm`
 * with `paymentMethod=pix`, and the inline DEFER guard previously
 * lived in `packages/llm-provider/src/order-policy-bundle.ts`. After
 * migration, that adopter calls `createPixPendingDeferGuard` with its
 * own state-shape readers. This test pins that contract.
 */

import { describe, expect, it } from "vitest";
import { adjudicate } from "@adjudicate/core/kernel";
import { buildEnvelope } from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";
import {
  createPixPendingDeferGuard,
  PIX_CONFIRMATION_SIGNAL,
  PIX_DEFAULT_DEFER_TIMEOUT_MS,
} from "../src/index.js";

interface AdopterState {
  readonly ctx: {
    readonly paymentMethod: string | null;
    readonly paymentStatus: string | null;
  };
}

const adopterDeferGuard: Guard<string, unknown, AdopterState> =
  createPixPendingDeferGuard<AdopterState>({
    readPaymentMethod: (s) => s.ctx.paymentMethod,
    readPaymentStatus: (s) => s.ctx.paymentStatus,
    matchesIntent: (kind) => kind === "order.confirm",
  });

const adopterBundle: PolicyBundle<string, unknown, AdopterState> = {
  stateGuards: [adopterDeferGuard],
  authGuards: [],
  taint: { minimumFor: () => "UNTRUSTED" },
  business: [],
  default: "EXECUTE",
};

function envelope(payload: Record<string, unknown> = {}) {
  return buildEnvelope({
    kind: "order.confirm",
    payload,
    actor: { principal: "llm", sessionId: "s-1" },
    taint: "UNTRUSTED",
    createdAt: "2026-04-26T12:00:00.000Z",
  });
}

describe("createPixPendingDeferGuard — adopter intent kind", () => {
  it("DEFERs adopter's order.confirm when paymentMethod=pix and unsettled", () => {
    const decision = adjudicate(
      envelope(),
      { ctx: { paymentMethod: "pix", paymentStatus: "pending" } },
      adopterBundle,
    );
    expect(decision.kind).toBe("DEFER");
    if (decision.kind !== "DEFER") return;
    expect(decision.signal).toBe(PIX_CONFIRMATION_SIGNAL);
    expect(decision.timeoutMs).toBe(PIX_DEFAULT_DEFER_TIMEOUT_MS);
  });

  it("does NOT DEFER when paymentMethod is not PIX", () => {
    const decision = adjudicate(
      envelope(),
      { ctx: { paymentMethod: "card", paymentStatus: "pending" } },
      adopterBundle,
    );
    expect(decision.kind).toBe("EXECUTE"); // default
  });

  it("does NOT DEFER once paymentStatus is captured (resume path)", () => {
    const decision = adjudicate(
      envelope(),
      { ctx: { paymentMethod: "pix", paymentStatus: "captured" } },
      adopterBundle,
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("treats paid as a settled status by default", () => {
    const decision = adjudicate(
      envelope(),
      { ctx: { paymentMethod: "pix", paymentStatus: "paid" } },
      adopterBundle,
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("respects a custom signal override", () => {
    const customGuard = createPixPendingDeferGuard<AdopterState>({
      readPaymentMethod: (s) => s.ctx.paymentMethod,
      readPaymentStatus: (s) => s.ctx.paymentStatus,
      matchesIntent: (kind) => kind === "order.confirm",
      signal: "my.custom.signal",
      timeoutMs: 1000,
    });
    const customBundle: PolicyBundle<string, unknown, AdopterState> = {
      ...adopterBundle,
      stateGuards: [customGuard],
    };
    const decision = adjudicate(
      envelope(),
      { ctx: { paymentMethod: "pix", paymentStatus: "pending" } },
      customBundle,
    );
    expect(decision.kind).toBe("DEFER");
    if (decision.kind !== "DEFER") return;
    expect(decision.signal).toBe("my.custom.signal");
    expect(decision.timeoutMs).toBe(1000);
  });
});
