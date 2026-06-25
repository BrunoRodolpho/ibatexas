// DEF-005 capability detection: the boot probe must classify a working embedder
// as capable and a non-embedding provider (throws / empty vector) as incapable,
// never throwing itself.

import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@claustrum/core";
import { providerCanEmbed } from "../provider-embed-capability.js";

function provider(embed: ModelProvider["embed"]): ModelProvider {
  return { embed } as unknown as ModelProvider;
}

describe("providerCanEmbed", () => {
  it("true when the provider returns a non-empty vector", async () => {
    await expect(providerCanEmbed(provider(async () => [0.1, 0.2, 0.3]))).resolves.toBe(true);
  });

  it("false when embed() throws not_implemented (no embedding capability)", async () => {
    await expect(
      providerCanEmbed(
        provider(async () => {
          throw new Error("not_implemented");
        }),
      ),
    ).resolves.toBe(false);
  });

  it("false on an empty vector (degenerate embedder)", async () => {
    await expect(providerCanEmbed(provider(async () => []))).resolves.toBe(false);
  });
});
