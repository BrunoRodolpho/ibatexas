/**
 * BKL-283 — embedder construction is an INJECTED SEAM, never ambient env.
 *
 * THE DEFECT. `bootstrapClaustrum` wired the funnel's LE2-008 L2 capability
 * retriever by calling `createOllamaEmbedder()`, which read `OLLAMA_EMBED_URL` /
 * `OLLAMA_EMBED_MODEL` straight off `process.env`. L2 narrows the tool roster the
 * planner advertises, so the ADVERTISED SURFACE of every composition in the
 * process was a property of whatever shell happened to start it — and the repo's
 * own `.env` carries the pair. Two consequences were measured:
 *
 *   1. LOUD — a content-keyed fixture suite recorded against the full-roster
 *      surface and replayed against a scoped one; 4/4 fixtures missed and
 *      `order.item.add` became `system.extraction_failure` (BKL-279 / PR #450).
 *   2. SILENT — the BKL-275 emission factorial varied the surface BETWEEN ARMS
 *      by this exact mechanism while reading rates across arms as fixed,
 *      corrupting a money-path measurement. Nothing failed at all.
 *
 * NOT A KEY PROBLEM. Both the L1 parse-cache key and the fixture digest already
 * cover the tool surface correctly — which is precisely why case 1 failed loudly.
 * Nothing CONTROLLED the surface. Absent seam, not absent key; the fix is a port,
 * not a new key component.
 *
 * THE CONDITION UNDER TEST. This entire file runs with BOTH variables exported
 * into `process.env` — the exact shell state that used to wire a retriever behind
 * every composition's back. Every assertion below therefore reads "…even with the
 * pair fully exported".
 *
 * WHAT IS PROVEN ELSEWHERE, deliberately not duplicated here:
 *   - a retriever-less composition really does advertise the FULL roster, read
 *     out of the CompletionRequest the model received: `l2-scoped-parse.e2e`
 *     (`noRetriever`), which also pins the scoped direction.
 *   - a REAL `bootstrapClaustrum` under a fully-exported shell keeps the
 *     full-roster surface: the scripted-pipeline suite, whose fixtures are keyed
 *     by a `{system, messages, tools}` digest and so fail loudly on any surface
 *     drift. See the PR body's hermeticity run.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./setup.js";

import { productionCapabilityEmbedderOptions } from "../claustrum-bootstrap.js";
import {
  createOllamaEmbedder,
  resolveOllamaEmbedderConfig,
} from "../claustrum/capability-retrieval.js";

// The ambient pair. Deliberately a `.invalid` host: if any assertion below ever
// reaches the network the request fails rather than quietly succeeding against a
// developer's real embedder box.
const AMBIENT_URL = "http://ambient-embedder.invalid:11434";
const AMBIENT_MODEL = "ambient-nomic-embed-text";

const SAVED = {
  url: process.env.OLLAMA_EMBED_URL,
  model: process.env.OLLAMA_EMBED_MODEL,
};

beforeAll(() => {
  process.env.OLLAMA_EMBED_URL = AMBIENT_URL;
  process.env.OLLAMA_EMBED_MODEL = AMBIENT_MODEL;
});

afterAll(() => {
  if (SAVED.url === undefined) delete process.env.OLLAMA_EMBED_URL;
  else process.env.OLLAMA_EMBED_URL = SAVED.url;
  if (SAVED.model === undefined) delete process.env.OLLAMA_EMBED_MODEL;
  else process.env.OLLAMA_EMBED_MODEL = SAVED.model;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch double that ANSWERS the ollama embeddings contract and records the call. */
function stubEmbeddingsFetch(vec: number[] = [0.1, 0.2, 0.3]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ embedding: vec }),
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) DEFAULT = NOT CONFIGURED. No ambient inheritance, pair exported.
// ─────────────────────────────────────────────────────────────────────────────

describe("BKL-283 (a) — a composition that declares nothing gets NOT-CONFIGURED", () => {
  it("the config decoder reads ONLY the bag it is handed, never the ambient env", () => {
    // The pair IS exported (see beforeAll) — a decoder that fell back to
    // `process.env` would hand back a live config here.
    expect(resolveOllamaEmbedderConfig({})).toBeUndefined();
  });

  it("an env bag holding only ONE of the pair is still not-configured", () => {
    expect(resolveOllamaEmbedderConfig({ OLLAMA_EMBED_URL: AMBIENT_URL })).toBeUndefined();
    expect(resolveOllamaEmbedderConfig({ OLLAMA_EMBED_MODEL: AMBIENT_MODEL })).toBeUndefined();
  });

  it("empty string stays the DECLARED not-configured value (unchanged from LE2-008)", () => {
    expect(
      resolveOllamaEmbedderConfig({ OLLAMA_EMBED_URL: "", OLLAMA_EMBED_MODEL: AMBIENT_MODEL }),
    ).toBeUndefined();
    expect(
      resolveOllamaEmbedderConfig({ OLLAMA_EMBED_URL: AMBIENT_URL, OLLAMA_EMBED_MODEL: "" }),
    ).toBeUndefined();
  });

  it("the bootstrap options a non-production composition gets carry NO embedder", () => {
    // `productionCapabilityEmbedderOptions` is the ONLY producer of the option,
    // and handed an empty bag it produces the empty object — so a suite that
    // does not state a surface passes `{}` and `options.capabilityEmbedder` is
    // absent, whatever the shell exports.
    const options = productionCapabilityEmbedderOptions({});
    expect(options).toEqual({});
    expect(options.capabilityEmbedder).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) EXPLICIT INJECTION WIRES A WORKING EMBEDDER — and the DECLARATION wins.
// ─────────────────────────────────────────────────────────────────────────────

describe("BKL-283 (b) — the declared config is what reaches the wire", () => {
  it("a declared config produces a port that POSTs to the DECLARED host, not the ambient one", async () => {
    const spy = stubEmbeddingsFetch();
    const embedder = createOllamaEmbedder({
      baseUrl: "http://declared-embedder.invalid:9999",
      model: "declared-model",
    });

    const vec = await embedder.embed("quero costela");

    expect(vec).toEqual([0.1, 0.2, 0.3]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    // The ambient pair is exported and is NOT what was used.
    expect(url).toBe("http://declared-embedder.invalid:9999/api/embeddings");
    expect(url).not.toContain("ambient-embedder");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "declared-model",
      prompt: "quero costela",
    });
  });

  it("a trailing slash on the declared base URL is normalized exactly as before", async () => {
    const spy = stubEmbeddingsFetch();
    await createOllamaEmbedder({ baseUrl: "http://x.invalid:1/", model: "m" }).embed("oi");
    expect(spy.mock.calls[0]?.[0]).toBe("http://x.invalid:1/api/embeddings");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) THE PRODUCTION ROOT PASSES THE ENV-DERIVED CONFIG THROUGH THE PORT.
//     Production behaviour must be preserved byte-identically.
// ─────────────────────────────────────────────────────────────────────────────

describe("BKL-283 (c) — the production composition root reads env ONCE and passes it in", () => {
  it("hands bootstrapClaustrum an embedder built from ITS env bag", () => {
    // `apps/api/src/index.ts` calls exactly this, with `process.env`.
    const options = productionCapabilityEmbedderOptions(process.env);
    expect(options.capabilityEmbedder).toBeDefined();
  });

  it("the wired port hits the SAME url + model + body as the pre-seam client", async () => {
    const spy = stubEmbeddingsFetch([1, 2, 3]);
    const options = productionCapabilityEmbedderOptions(process.env);

    const vec = await options.capabilityEmbedder!.embed("qual o horário?");

    expect(vec).toEqual([1, 2, 3]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${AMBIENT_URL}/api/embeddings`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: AMBIENT_MODEL,
      prompt: "qual o horário?",
    });
  });

  it("yields not-configured when production's own env lacks the pair", () => {
    expect(
      productionCapabilityEmbedderOptions({ NODE_ENV: "production" }),
    ).toEqual({});
  });

  it("still surfaces embedder failures as throws (the retriever's fail-safe input)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const options = productionCapabilityEmbedderOptions(process.env);
    await expect(options.capabilityEmbedder!.embed("oi")).rejects.toThrow("503");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CLASS GUARD. What stops the next re-derivation.
// ─────────────────────────────────────────────────────────────────────────────

const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** An ambient READ of the embedder pair: `process.env.OLLAMA_EMBED*` in any spelling. */
const AMBIENT_READ = /process\s*\.\s*env\s*(?:\.\s*OLLAMA_EMBED|\[\s*["'`]OLLAMA_EMBED)/;

describe("BKL-283 class guard — nothing under apps/api/src reads the pair from ambient env", () => {
  it("no production source file reads process.env.OLLAMA_EMBED_*", () => {
    const offenders = collectSourceFiles(API_SRC)
      .filter((f) => AMBIENT_READ.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(API_SRC, f));
    // The production composition root passes `process.env` WHOLESALE into
    // `productionCapabilityEmbedderOptions`; it never names these variables. So
    // the correct count is zero — any name appearing here is a library or
    // harness that has started inheriting a shell again.
    expect(offenders).toEqual([]);
  });

  it("the L2 embedder module is env-free in CODE — its config is an argument", () => {
    const src = readFileSync(path.join(API_SRC, "claustrum/capability-retrieval.ts"), "utf8");
    expect(AMBIENT_READ.test(src)).toBe(false);
    // The decoder must keep `env` REQUIRED. A `= process.env` default would
    // restore BKL-283 while every test above still passed, because each one
    // passes its bag explicitly.
    expect(src).toContain("env: NodeJS.ProcessEnv,");
    expect(src).not.toMatch(/env\s*:\s*NodeJS\.ProcessEnv\s*=/);
  });

  it("the conductor composition root wires L2 from its OPTIONS, not from env", () => {
    const src = readFileSync(path.join(API_SRC, "claustrum-bootstrap.ts"), "utf8");
    expect(AMBIENT_READ.test(src)).toBe(false);
    expect(src).toContain("const l2Embedder = options.capabilityEmbedder;");
  });

  it("index.ts is the one place that hands ambient env to the seam", () => {
    const src = readFileSync(path.join(API_SRC, "index.ts"), "utf8");
    expect(src).toContain("productionCapabilityEmbedderOptions(process.env)");
  });
});
