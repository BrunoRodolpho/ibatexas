// parse-memo-catalog-version.test.ts — LE2-009 AC "any surface-version change
// invalidates the cache (proven)", for the component that cannot be varied
// through the public argument list: `CATALOG_VERSION`.
//
// Its own file because it must mock `@ibatexas/catalog` at MODULE level and
// re-import `parse-memo` twice under two different catalog versions —
// `vi.resetModules()` between them. Doing that inside parse-memo.test.ts would
// force every other case in that file to live under a mocked catalog.
//
// The mechanism this pins is the purge itself: the version is a DIGESTED KEY
// COMPONENT, so a bump makes every prior entry unreachable in the same move.
// There is no separate invalidation path that could be forgotten, and no
// "purge on boot" step that could fail halfway.

import { describe, expect, it, vi } from "vitest";

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: async () => ({ get: vi.fn(), setEx: vi.fn() }),
  rk: (key: string) => `test:${key}`,
}));

const INPUT = {
  utterance: "quero uma coca",
  modelId: "nemotron-3-nano:4b",
  system: "Você é o atendente.",
  toolSurface: [{ name: "express_intent" }],
};

async function keyUnderCatalogVersion(version: number): Promise<string> {
  vi.resetModules();
  vi.doMock("@ibatexas/catalog", () => ({ CATALOG_VERSION: version }));
  const { buildParseCacheKey } = await import("../parse-memo.js");
  return buildParseCacheKey(INPUT).key;
}

describe("CATALOG_VERSION participates in the parse cache key", () => {
  it("produces the same key for the same catalog version", async () => {
    expect(await keyUnderCatalogVersion(2)).toBe(await keyUnderCatalogVersion(2));
  });

  it("INVALIDATES every entry when the catalog version is bumped", async () => {
    // A catalog bump changes the capability definitions the tool surface is built
    // from, so a parse made against the old roster must never be replayed against
    // the new one. Different key ⇒ the old entry is unreachable and ages out.
    expect(await keyUnderCatalogVersion(2)).not.toBe(await keyUnderCatalogVersion(3));
  });
});
