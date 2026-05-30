/**
 * Gateway tamper-evidence (RC-A1 hardening, cycle-5 continuation).
 *
 * `detectForgery` previously require()'d a kernel export that never existed and
 * fell through to "not forged" — a silent no-op. It now re-derives the canonical
 * `intentHash` via `deriveIntentHash` and compares, so a legit envelope passes
 * and any post-signing tamper is caught at the gateway (defense-in-depth; the
 * kernel re-verifies at adjudicate-time regardless).
 *
 * The bootstrap module is mocked so importing the gateway doesn't pull in the
 * full conductor composition (Anthropic SDK, pg, packs) — detectForgery depends
 * only on `@adjudicate/core`.
 */

import { describe, expect, it, vi } from "vitest";
import { buildEnvelope } from "@adjudicate/core";

vi.mock("../claustrum-bootstrap.js", () => ({
  getConductor: () => null,
  tryGetConductor: () => null,
  policyForKind: () => null,
}));

const { detectForgery } = await import(
  "../routes/__shared__/customer-intent-gateway.js"
);

const good = buildEnvelope({
  kind: "order.item.add",
  payload: { sku: "costela", qty: 2 },
  actor: { principal: "user", sessionId: "web:c1" },
  taint: "UNTRUSTED",
  nonce: "nonce-1",
});

describe("detectForgery — tamper evidence", () => {
  it("a freshly built envelope is NOT forged (round-trips)", () => {
    expect(detectForgery(good)).toBe(false);
  });

  it("a tampered payload IS forged", () => {
    expect(detectForgery({ ...good, payload: { sku: "costela", qty: 999 } })).toBe(
      true,
    );
  });

  it("a tampered actor IS forged", () => {
    expect(
      detectForgery({
        ...good,
        actor: { ...good.actor, principal: "system" },
      } as never),
    ).toBe(true);
  });

  it("a tampered kind IS forged", () => {
    expect(detectForgery({ ...good, kind: "order.cancel" })).toBe(true);
  });

  it("a missing intentHash IS forged", () => {
    expect(detectForgery({ ...good, intentHash: "" })).toBe(true);
  });

  it("a swapped-in wrong hash IS forged", () => {
    expect(detectForgery({ ...good, intentHash: "deadbeef" })).toBe(true);
  });
});
