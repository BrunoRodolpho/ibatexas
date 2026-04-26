import { describe, expect, it } from "vitest";
import {
  buildEnvelope,
  hasUnknownEnvelopeVersion,
  INTENT_ENVELOPE_VERSION,
  isIntentEnvelope,
} from "../src/envelope.js";

describe("IntentEnvelope — version gating", () => {
  const baseline = {
    kind: "order.tool.propose" as const,
    payload: { toolName: "add_item", input: { sku: "X" } },
    actor: { principal: "llm" as const, sessionId: "s-1" },
    taint: "UNTRUSTED" as const,
    createdAt: "2026-04-23T12:00:00.000Z",
  };

  it("buildEnvelope stamps the current version", () => {
    const env = buildEnvelope(baseline);
    expect(env.version).toBe(INTENT_ENVELOPE_VERSION);
  });

  it("isIntentEnvelope accepts a valid envelope", () => {
    const env = buildEnvelope(baseline);
    expect(isIntentEnvelope(env)).toBe(true);
  });

  it("isIntentEnvelope rejects arbitrary objects", () => {
    expect(isIntentEnvelope(null)).toBe(false);
    expect(isIntentEnvelope(undefined)).toBe(false);
    expect(isIntentEnvelope({})).toBe(false);
    expect(isIntentEnvelope({ version: 999 })).toBe(false);
    expect(isIntentEnvelope("string")).toBe(false);
    expect(isIntentEnvelope(42)).toBe(false);
  });

  it("isIntentEnvelope rejects an envelope-shaped object with unknown version", () => {
    const badVersion = {
      version: 999,
      kind: "order.tool.propose",
      payload: {},
      createdAt: "2026-04-23T12:00:00.000Z",
      actor: { principal: "llm", sessionId: "s-1" },
      taint: "UNTRUSTED",
      intentHash: "deadbeef".repeat(8),
    };
    expect(isIntentEnvelope(badVersion)).toBe(false);
  });

  it("isIntentEnvelope rejects an envelope with missing taint", () => {
    const env = buildEnvelope(baseline);
    const missingTaint = { ...env, taint: "ROGUE" };
    expect(isIntentEnvelope(missingTaint)).toBe(false);
  });

  it("hasUnknownEnvelopeVersion identifies version-shaped objects with wrong version", () => {
    expect(hasUnknownEnvelopeVersion({ version: 999 })).toBe(true);
    expect(hasUnknownEnvelopeVersion({ version: 2 })).toBe(true);
  });

  it("hasUnknownEnvelopeVersion returns false for current version", () => {
    expect(
      hasUnknownEnvelopeVersion({ version: INTENT_ENVELOPE_VERSION }),
    ).toBe(false);
  });

  it("hasUnknownEnvelopeVersion returns false for non-objects and missing versions", () => {
    expect(hasUnknownEnvelopeVersion(null)).toBe(false);
    expect(hasUnknownEnvelopeVersion(undefined)).toBe(false);
    expect(hasUnknownEnvelopeVersion({ kind: "x" })).toBe(false);
    expect(hasUnknownEnvelopeVersion({ version: "1" })).toBe(false);
  });
});
