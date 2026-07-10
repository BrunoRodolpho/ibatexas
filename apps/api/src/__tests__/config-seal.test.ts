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
import { parseSealDigests } from "../claustrum-bootstrap.js";

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

// BKL-129 — CONFIG_SEAL_DIGESTS env parsing must fail CLOSED (not silently skip)
// on a comment-poisoned value. process-compose hands a trailing `# comment`
// through as the VALUE when the value is empty, which used to parse as a pinned
// pack id + bogus digest and surface a MISLEADING "pack config drift" boot error.
describe("F5 parseSealDigests (BKL-129 fail-closed)", () => {
  const HEX = "a".repeat(64);

  it("returns an empty map for unset / empty / whitespace-only (no enforcement)", () => {
    expect(parseSealDigests(undefined).size).toBe(0);
    expect(parseSealDigests("").size).toBe(0);
    expect(parseSealDigests("   ").size).toBe(0);
  });

  it("parses valid digests (single, multi, uppercase, trailing ';')", () => {
    const single = parseSealDigests(`ibatexas/pack-orders=${HEX}`);
    expect(single.get("ibatexas/pack-orders")).toBe(HEX);

    const multi = parseSealDigests(
      `ibatexas/pack-orders=${HEX};ibatexas/pack-payments=${"b".repeat(64)};`,
    );
    expect(multi.size).toBe(2);
    expect(multi.get("ibatexas/pack-payments")).toBe("b".repeat(64));

    // digest is canonicalised to lowercase
    expect(
      parseSealDigests(`ibatexas/pack-orders=${"A".repeat(64)}`).get(
        "ibatexas/pack-orders",
      ),
    ).toBe("a".repeat(64));
  });

  it("THROWS on a comment-poisoned value, naming the var + the inline-comment gotcha", () => {
    const poisoned =
      "# e.g. ibatexas/pack-orders=<64hex>;ibatexas/pack-payments=<64hex>";
    expect(() => parseSealDigests(poisoned)).toThrow(/CONFIG_SEAL_DIGESTS/);
    expect(() => parseSealDigests(poisoned)).toThrow(/inline comment/i);
  });

  it("THROWS on a non-64-hex digest instead of silently skipping it", () => {
    expect(() => parseSealDigests("ibatexas/pack-orders=deadbeef")).toThrow(
      /CONFIG_SEAL_DIGESTS/,
    );
    // a valid entry followed by a malformed one still fails CLOSED
    expect(() =>
      parseSealDigests(`ibatexas/pack-orders=${HEX};ibatexas/pack-payments=nope`),
    ).toThrow(/malformed/);
  });
});
