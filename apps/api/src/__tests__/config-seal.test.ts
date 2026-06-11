/**
 * F5 — config integrity seal mechanics on a real money-pack.
 *
 * The boot gate (assertConfigSealOrThrow in claustrum-bootstrap.ts) verifies each
 * pinned pack's surface against verifyConfigSeal and fails boot CLOSED on a
 * mismatch. This test locks the underlying guarantee on the orders pack:
 * deterministic digest, verifies a matching seal, REJECTS a tampered one.
 * (The gate's NODE_ENV==='test' short-circuit makes it a no-op in tests, so the
 * mechanics are exercised directly here.)
 */

import { describe, expect, it } from "vitest";
import { ordersPack } from "@ibatexas/pack-orders";
import {
  computeConfigDigest,
  extractSealableSurface,
  verifyConfigSeal,
} from "@adjudicate/conformance";

const pack = ordersPack as unknown as Parameters<
  typeof extractSealableSurface
>[0];

describe("F5 config seal", () => {
  it("digest is deterministic + 64-hex", () => {
    const d1 = computeConfigDigest(extractSealableSurface(pack));
    const d2 = computeConfigDigest(extractSealableSurface(pack));
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a matching seal (boot would proceed)", () => {
    const digest = computeConfigDigest(extractSealableSurface(pack));
    const report = verifyConfigSeal(
      pack,
      { schemaVersion: 1, digest, packId: ordersPack.id },
      { policy: "require_digest" },
    );
    expect(report.verified).toBe(true);
    expect(report.digestMatch).toBe("match");
  });

  it("REJECTS a tampered seal (boot would refuse CLOSED)", () => {
    const report = verifyConfigSeal(
      pack,
      { schemaVersion: 1, digest: "0".repeat(64), packId: ordersPack.id },
      { policy: "require_digest" },
    );
    expect(report.verified).toBe(false);
    expect(report.digestMatch).toBe("mismatch");
  });
});
