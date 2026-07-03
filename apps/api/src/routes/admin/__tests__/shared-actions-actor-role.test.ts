// Unit tests for the WS7 / BKL-069 staff-role → `actor.role` seam in
// `_shared-actions.ts`: `resolveActorRole`, `principalFor`, and `actorFor`.
//
// These prove the three load-bearing properties of Part B:
//   1. Role DERIVATION — JWT staff role wins; else the API-key registry
//      role; else ABSENT (a bare unmapped key fabricates nothing).
//   2. Absent role stays ABSENT (undefined) — never surfaced as `""`, and
//      the `role` key is omitted entirely (canonical-drop-safe shape).
//   3. Canonical-drop-safety at the HASH level (@adjudicate/core 1.9.0):
//      an envelope built WITHOUT role hashes byte-identically to a plain
//      role-free envelope, while a PRESENT role changes the intentHash
//      (hash-bound → tamper-evident).

import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import {
  actorFor,
  principalFor,
  resolveActorRole,
} from "../_shared-actions.js";

describe("resolveActorRole (WS7 / BKL-069)", () => {
  it("returns the JWT staff role when present", () => {
    expect(resolveActorRole({ staffRole: "ATTENDANT" })).toBe("ATTENDANT");
  });

  it("returns the API-key registry role when there is no JWT staff role", () => {
    expect(resolveActorRole({ adminApiKeyRole: "MANAGER" })).toBe("MANAGER");
  });

  it("returns undefined for a bare, unmapped API key (no role fabricated)", () => {
    expect(resolveActorRole({})).toBeUndefined();
  });

  it("prefers the JWT staff role over an API-key role if both are set", () => {
    expect(
      resolveActorRole({ staffRole: "OWNER", adminApiKeyRole: "MANAGER" }),
    ).toBe("OWNER");
  });
});

describe("principalFor role derivation (WS7 / BKL-069)", () => {
  it("JWT staff → user/TRUSTED principal carrying the staff role", () => {
    const p = principalFor("staff_own_01", "OWNER");
    expect(p).toEqual({
      actorPrincipal: "user",
      taint: "TRUSTED",
      sessionId: "admin:staff_own_01",
      actorRole: "OWNER",
    });
  });

  it("API-key with a registry role → system/SYSTEM principal STILL carries the role", () => {
    const p = principalFor(null, "MANAGER");
    expect(p).toEqual({
      actorPrincipal: "system",
      taint: "SYSTEM",
      sessionId: "admin:api-key",
      actorRole: "MANAGER",
    });
  });

  it("bare key (no role) → no actorRole key at all (absent stays absent)", () => {
    const p = principalFor(null);
    expect(p).toEqual({
      actorPrincipal: "system",
      taint: "SYSTEM",
      sessionId: "admin:api-key",
    });
    expect("actorRole" in p).toBe(false);
  });

  it("normalizes an empty-string role to ABSENT (never actorRole: \"\")", () => {
    const p = principalFor("staff_1", "" as unknown as "OWNER");
    expect("actorRole" in p).toBe(false);
  });
});

describe("actorFor canonical-drop-safe role spread", () => {
  it("omits the role key entirely when role is absent", () => {
    const actor = actorFor({ principal: "user", sessionId: "admin:staff_1" });
    expect(actor).toEqual({ principal: "user", sessionId: "admin:staff_1" });
    expect("role" in actor).toBe(false);
  });

  it("includes role when present", () => {
    const actor = actorFor({
      principal: "user",
      sessionId: "admin:staff_1",
      role: "MANAGER",
    });
    expect(actor).toEqual({
      principal: "user",
      sessionId: "admin:staff_1",
      role: "MANAGER",
    });
  });

  it("a role-absent actor produces an intentHash byte-identical to a plain role-free envelope", () => {
    const common = {
      kind: "order.status.transition" as const,
      payload: { orderId: "order_1", newStatus: "canceled" },
      nonce: "fixed-nonce-abc",
      taint: "TRUSTED" as const,
    };
    const viaHelper = buildEnvelope({
      ...common,
      actor: actorFor({ principal: "user", sessionId: "admin:staff_1" }),
    });
    const plain = buildEnvelope({
      ...common,
      actor: { principal: "user", sessionId: "admin:staff_1" },
    });
    expect(viaHelper.intentHash).toBe(plain.intentHash);
    expect("role" in viaHelper.actor).toBe(false);
  });

  it("a PRESENT role is hash-bound (changes the intentHash → tamper-evident)", () => {
    const common = {
      kind: "order.status.transition" as const,
      payload: { orderId: "order_1", newStatus: "canceled" },
      nonce: "fixed-nonce-abc",
      taint: "TRUSTED" as const,
    };
    const roleless = buildEnvelope({
      ...common,
      actor: actorFor({ principal: "user", sessionId: "admin:staff_1" }),
    });
    const withRole = buildEnvelope({
      ...common,
      actor: actorFor({
        principal: "user",
        sessionId: "admin:staff_1",
        role: "MANAGER",
      }),
    });
    expect(withRole.actor.role).toBe("MANAGER");
    expect(withRole.intentHash).not.toBe(roleless.intentHash);
  });
});
