// parse-memo.test.ts — LE2-009 L1's pure core, its store's fail-open contract,
// and the repeat-miss telemetry that is decision 10's evidence gate.
//
// The e2e proof (identical repeat ⇒ no extraction call ⇒ same envelope
// adjudicated, plus the stale-answer proof) lives at the TURN SEAM in
// `apps/api/src/__tests__/chat-l1-parse-memo.e2e.test.ts`. This file covers what
// a turn-level test cannot isolate: key composition, invalidation, and the
// degradation paths of an unreachable cache.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisGet, redisSetEx } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: async () => ({ get: redisGet, setEx: redisSetEx }),
  rk: (key: string) => `test:${key}`,
}));

const {
  buildParseCacheKey,
  canonicalizeUtterance,
  createParseCacheTelemetry,
  createRedisParseCacheStore,
  isCacheableParse,
  isSilentParse,
  FULL_ROSTER_SURFACE_VERSION,
  KEY_SCHEMA_VERSION,
  PARSE_CACHE_TTL_SECONDS,
} = await import("../parse-memo.js");

type MemoizedParse = Awaited<
  ReturnType<ReturnType<typeof createRedisParseCacheStore>["get"]>
>;

const BASE = {
  utterance: "quero uma coca",
  modelId: "nemotron-3-nano:4b",
  system: "Você é o atendente.",
  toolSurface: [{ name: "express_intent", enum: ["order.item.add"] }],
};

const VALID_ENTRY = {
  proposals: [{ kind: "order.item.add", payload: { item: "coca", quantity: 1 } }],
  readToolCalls: [],
  dropped: [],
  keyVersion: KEY_SCHEMA_VERSION,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("canonicalizeUtterance", () => {
  it("folds case, trims, and collapses inner whitespace", () => {
    expect(canonicalizeUtterance("  Quero   UMA   Coca  ")).toBe("quero uma coca");
  });

  it("normalizes to NFC so a decomposed accent joins its composed twin", () => {
    // "Ibaté" spelled with a combining acute vs. the precomposed character.
    const decomposed = "Ibaté";
    const composed = "Ibaté";
    expect(decomposed).not.toBe(composed);
    expect(canonicalizeUtterance(decomposed)).toBe(canonicalizeUtterance(composed));
  });

  it("PRESERVES diacritics — 'Ibaté' and 'Ibate' are different utterances", () => {
    // The load-bearing non-fold. Stripping accents would let two utterances that
    // can extract DIFFERENT payload slots share one cache entry, which is the
    // single false-hit class exact-match memoization exists to make impossible.
    expect(canonicalizeUtterance("Ibaté")).not.toBe(canonicalizeUtterance("Ibate"));
  });
});

describe("buildParseCacheKey", () => {
  it("is deterministic and namespaces through rk() with the schema version", () => {
    const a = buildParseCacheKey(BASE);
    const b = buildParseCacheKey(BASE);
    expect(a.key).toBe(b.key);
    expect(a.digest).toBe(b.digest);
    expect(a.keyVersion).toBe(KEY_SCHEMA_VERSION);
    expect(a.key.startsWith(`test:funnel:l1:parse:v${KEY_SCHEMA_VERSION}:`)).toBe(true);
  });

  it("collapses utterances that differ only by canonicalizable noise", () => {
    expect(buildParseCacheKey(BASE).key).toBe(
      buildParseCacheKey({ ...BASE, utterance: "  QUERO uma   coca " }).key,
    );
  });

  // Each of these is an input the parse is genuinely a function of; a shared key
  // across any of them would serve a parse produced under different conditions.
  it.each([
    ["utterance", { utterance: "quero duas cocas" }],
    ["model", { modelId: "some-other-model" }],
    ["system prompt", { system: "Você é o atendente. A loja está FECHADA." }],
    ["tool surface", { toolSurface: [{ name: "express_intent", enum: ["order.cancel"] }] }],
    ["surface version (L2's additive slot)", { surfaceVersion: "l2-scoped-v1" }],
  ])("changes when the %s changes", (_label, override) => {
    expect(buildParseCacheKey({ ...BASE, ...override }).key).not.toBe(
      buildParseCacheKey(BASE).key,
    );
  });

  it("defaults surfaceVersion to the full-roster label, so declaring it explicitly is a no-op", () => {
    // Pins the additive contract the L2 reorder depends on: pre-L2 entries are
    // written under the default label, so L2 naming its own version purges them
    // wholesale rather than colliding with them.
    expect(
      buildParseCacheKey({ ...BASE, surfaceVersion: FULL_ROSTER_SURFACE_VERSION }).key,
    ).toBe(buildParseCacheKey(BASE).key);
  });

  it("is insensitive to tool-surface key ORDER but sensitive to array order", () => {
    // Object key order is JSON noise; array order is meaningful (it is the order
    // capabilities are advertised in, which the model can be sensitive to).
    const keyOrder = buildParseCacheKey({
      ...BASE,
      toolSurface: [{ enum: ["order.item.add"], name: "express_intent" }],
    });
    expect(keyOrder.key).toBe(buildParseCacheKey(BASE).key);

    const arrayOrder = buildParseCacheKey({
      ...BASE,
      toolSurface: [{ name: "express_intent", enum: ["order.item.add", "order.cancel"] }],
    });
    const reversed = buildParseCacheKey({
      ...BASE,
      toolSurface: [{ name: "express_intent", enum: ["order.cancel", "order.item.add"] }],
    });
    expect(arrayOrder.key).not.toBe(reversed.key);
  });
});

describe("isCacheableParse — the three deliberate refusals", () => {
  it("caches an ordinary single-pass parse", () => {
    expect(
      isCacheableParse({ readEnriched: false, extractionFailed: false, silent: false }),
    ).toBe(true);
  });

  it("REFUSES a read-enriched parse (live store state is baked into it)", () => {
    expect(
      isCacheableParse({ readEnriched: true, extractionFailed: false, silent: false }),
    ).toBe(false);
  });

  it("REFUSES an extraction failure (a transient wire fault must not be pinned)", () => {
    expect(
      isCacheableParse({ readEnriched: false, extractionFailed: true, silent: false }),
    ).toBe(false);
  });

  it("BKL-274 — REFUSES a silent parse (a 200 that selected nothing must not be pinned)", () => {
    expect(
      isCacheableParse({ readEnriched: false, extractionFailed: false, silent: true }),
    ).toBe(false);
  });
});

describe("isSilentParse — zero ARTIFACT, deliberately not zero PROPOSALS (BKL-274)", () => {
  const EMPTY = { proposals: [], readToolCalls: [], dropped: [] };

  it("is SILENT when the parse emitted nothing at all", () => {
    expect(isSilentParse(EMPTY)).toBe(true);
  });

  it("is NOT silent when the model proposed a capability", () => {
    expect(
      isSilentParse({ ...EMPTY, proposals: [{ kind: "order.item.add", payload: {} }] }),
    ).toBe(false);
  });

  // The three narrowing terms. Each of these has ZERO proposals and each must
  // stay cacheable — which is the whole reason the predicate is not
  // `proposals.length === 0`. Drop any clause below and the fix starts refusing
  // legitimate entries.
  it("is NOT silent when the model selected a READ tool (zero proposals, real determination)", () => {
    expect(
      isSilentParse({ ...EMPTY, readToolCalls: [{ name: "get_menu", input: {} }] }),
    ).toBe(false);
  });

  it("is NOT silent when the constrained-generation wall DROPPED the selection", () => {
    expect(isSilentParse({ ...EMPTY, dropped: ["staff.only.kind"] })).toBe(false);
  });
});

describe("createRedisParseCacheStore — fail-open in every direction", () => {
  it("round-trips a valid entry and writes it with the bounded TTL", async () => {
    const store = createRedisParseCacheStore();
    await store.set("k", VALID_ENTRY as NonNullable<MemoizedParse>, PARSE_CACHE_TTL_SECONDS);
    expect(redisSetEx).toHaveBeenCalledWith("k", PARSE_CACHE_TTL_SECONDS, JSON.stringify(VALID_ENTRY));

    redisGet.mockResolvedValueOnce(JSON.stringify(VALID_ENTRY));
    await expect(store.get("k")).resolves.toEqual(VALID_ENTRY);
  });

  it("reports a MISS (never throws) when Redis is unreachable on read", async () => {
    redisGet.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(createRedisParseCacheStore().get("k")).resolves.toBeUndefined();
  });

  it("swallows a write fault — a cache outage can never fail a turn", async () => {
    redisSetEx.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      createRedisParseCacheStore().set("k", VALID_ENTRY as NonNullable<MemoizedParse>, 60),
    ).resolves.toBeUndefined();
  });

  it("ignores a malformed entry rather than trusting it", async () => {
    redisGet.mockResolvedValueOnce("{not json");
    await expect(createRedisParseCacheStore().get("k")).resolves.toBeUndefined();

    redisGet.mockResolvedValueOnce(JSON.stringify({ proposals: "nope" }));
    await expect(createRedisParseCacheStore().get("k")).resolves.toBeUndefined();
  });

  it("ignores an entry written under an older stored-shape schema", async () => {
    redisGet.mockResolvedValueOnce(
      JSON.stringify({ ...VALID_ENTRY, keyVersion: KEY_SCHEMA_VERSION - 1 }),
    );
    await expect(createRedisParseCacheStore().get("k")).resolves.toBeUndefined();
  });

  it("treats an absent key as a miss", async () => {
    redisGet.mockResolvedValueOnce(null);
    await expect(createRedisParseCacheStore().get("k")).resolves.toBeUndefined();
  });
});

describe("parse-cache telemetry — the residual repeat-miss rate", () => {
  it("counts a second miss on the SAME utterance as a REPEAT miss", () => {
    // The evidence gate for a future semantic tier: a repeat miss means the
    // utterance came back while some other keyed input had moved, which is
    // exactly the population a similarity tier would have to beat.
    const t = createParseCacheTelemetry();
    t.recordMiss("quero uma coca");
    expect(t.snapshot()).toMatchObject({ misses: 1, repeatMisses: 0 });
    t.recordMiss("quero uma coca");
    expect(t.snapshot()).toMatchObject({ misses: 2, repeatMisses: 1 });
  });

  it("does not count a first miss on a different utterance as a repeat", () => {
    const t = createParseCacheTelemetry();
    t.recordMiss("quero uma coca");
    t.recordMiss("cancela meu pedido");
    expect(t.snapshot()).toMatchObject({ misses: 2, repeatMisses: 0 });
  });

  it("tracks hits, stores and bypasses independently", () => {
    const t = createParseCacheTelemetry();
    t.recordHit();
    t.recordHit();
    t.recordStore();
    t.recordBypass();
    expect(t.snapshot()).toEqual({
      hits: 2,
      misses: 0,
      repeatMisses: 0,
      stores: 1,
      bypasses: 1,
      silentEntriesIgnored: 0,
    });
  });

  // BKL-274 — the residue-drain counter. It is deliberately NOT folded into
  // `misses`: a silent-entry refusal is a miss to the planner (so it re-parses)
  // but an entirely different operational fact, and it is the only signal that
  // shows pre-fix entries aging out. Both must move.
  it("counts a refused silent ENTRY separately from an ordinary miss", () => {
    const t = createParseCacheTelemetry();
    t.recordSilentEntryIgnored();
    t.recordMiss("me vê um brisket e uma batata");
    expect(t.snapshot()).toEqual({
      hits: 0,
      misses: 1,
      repeatMisses: 0,
      stores: 0,
      bypasses: 0,
      silentEntriesIgnored: 1,
    });
  });
});
