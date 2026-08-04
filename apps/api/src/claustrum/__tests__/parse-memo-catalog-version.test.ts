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
//
// F-2 — the catalog mock is now PARTIAL (`importOriginal`), and it has to be:
// `parse-memo` imports `ALIAS_CANONICALIZATION_VERSION`, whose module builds its
// surface index from the REAL `ALIAS_GAZETTEER` at load. A total mock that
// declared only `CATALOG_VERSION` would blow up at import rather than test
// anything, and — worse — silently emptying the gazetteer would make this file's
// subject disappear. Only the one component under test is overridden.

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
  vi.doMock("@ibatexas/catalog", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@ibatexas/catalog")>()),
    CATALOG_VERSION: version,
  }));
  const { buildParseCacheKey } = await import("../parse-memo.js");
  return buildParseCacheKey(INPUT).key;
}

/**
 * F-2 — the same experiment for the OTHER imported component. Same file because
 * it needs the same module-level re-import dance, and keeping the two side by
 * side is what makes "every version component is digested" readable as one claim.
 */
async function keyUnderAliasVersion(version: number): Promise<string> {
  vi.resetModules();
  vi.doMock("../alias-canonicalization.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../alias-canonicalization.js")>()),
    ALIAS_CANONICALIZATION_VERSION: version,
  }));
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

describe("F-2 — ALIAS_CANONICALIZATION_VERSION participates in the parse cache key", () => {
  it("produces the same key for the same canonicalizer revision", async () => {
    expect(await keyUnderAliasVersion(1)).toBe(await keyUnderAliasVersion(1));
  });

  it("INVALIDATES every entry when the canonicalizer revision is bumped", async () => {
    // THE F-2 MEMO PROOF, declared half. The canonicalized text IS the parse
    // input, so a rewrite-semantics change makes every parse cached under the
    // previous revision a parse of a string this deploy no longer produces.
    // Different key ⇒ unreachable, ages out on its TTL. Reverting the bump in
    // alias-canonicalization.ts reds this pair.
    expect(await keyUnderAliasVersion(1)).not.toBe(await keyUnderAliasVersion(2));
  });

  it("the SHIPPED revision is the one the key digests — not a default", async () => {
    // Without this the cases above only prove the *slot* varies. This proves the
    // slot is fed by the module the bump discipline lives in.
    //
    // BOTH halves are required. The equality alone is satisfied by a build that
    // digests the component NOT AT ALL — then every key is equal, including these
    // two, and the assertion passes with the wiring deleted. The inequality is the
    // control that makes it mean something.
    const { ALIAS_CANONICALIZATION_VERSION } = await import("../alias-canonicalization.js");
    vi.resetModules();
    const { buildParseCacheKey } = await import("../parse-memo.js");
    const live = buildParseCacheKey(INPUT).key;
    expect(live).toBe(await keyUnderAliasVersion(ALIAS_CANONICALIZATION_VERSION));
    expect(live).not.toBe(await keyUnderAliasVersion(ALIAS_CANONICALIZATION_VERSION + 1));
  });
});
