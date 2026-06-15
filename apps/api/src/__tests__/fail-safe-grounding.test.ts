import { describe, expect, it, vi } from "vitest";
import type { GroundingPort } from "@claustrum/core";
import { failSafeGrounding } from "../claustrum/fail-safe-grounding.js";

const PERCEPTION = {
  text: "quero uma costela defumada",
  channel: "web",
  externalId: "ext-1",
  receivedAt: new Date().toISOString(),
} as Parameters<GroundingPort["retrieve"]>[0];

const DOCS = {
  docs: [
    {
      id: "doc-1",
      source: "external" as const,
      recordId: "rec-1",
      recordVersion: "1",
      chunkText: "costela bovina defumada",
      score: 0.9,
    },
  ],
  retrievedAt: new Date().toISOString(),
  modelId: "test-embed",
};

function throwingPort(): GroundingPort {
  return {
    retrieve: vi.fn().mockRejectedValue(new Error("not_implemented")),
    attestGrounding: vi.fn().mockRejectedValue(new Error("not_implemented")),
  };
}

describe("failSafeGrounding", () => {
  it("passes through a healthy inner port untouched", async () => {
    const inner: GroundingPort = {
      retrieve: vi.fn().mockResolvedValue(DOCS),
      attestGrounding: vi.fn().mockResolvedValue([]),
    };
    const onError = vi.fn();
    const port = failSafeGrounding(inner, { modelId: "m", onError });

    await expect(port.retrieve(PERCEPTION)).resolves.toBe(DOCS);
    await expect(port.attestGrounding(DOCS, ["claim"])).resolves.toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("degrades retrieve() to an empty RetrievedDocs instead of rejecting (turn survives)", async () => {
    const onError = vi.fn();
    const port = failSafeGrounding(throwingPort(), { modelId: "m", onError });

    const result = await port.retrieve(PERCEPTION);
    expect(result.docs).toEqual([]);
    expect(result.modelId).toBe("m");
    expect(typeof result.retrievedAt).toBe("string");
    expect(onError).toHaveBeenCalledWith("retrieve", expect.any(Error));
  });

  it("degrades attestGrounding() to zero proofs (kernel refuses grounding-required envelopes — fail-closed)", async () => {
    const onError = vi.fn();
    const port = failSafeGrounding(throwingPort(), { modelId: "m", onError });

    await expect(port.attestGrounding(DOCS, ["claim"])).resolves.toEqual([]);
    expect(onError).toHaveBeenCalledWith("attestGrounding", expect.any(Error));
  });
});
