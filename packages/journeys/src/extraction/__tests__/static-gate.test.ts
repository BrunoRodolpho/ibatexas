// extraction/static-gate.test.ts — the CERTIFYING, per-commit, MODEL-FREE
// extraction gate (FE-T08). TDD per the ticket's own instruction: every
// check here is scripted-fixture only — no live model, no HTTP, no DB, no
// filesystem. Red/green pairs prove the gate actually catches the drift it
// claims to (FE-T08 AC1: "regresses an extraction schema -> the gate
// fails"), not merely that it exists.

import { describe, expect, it } from "vitest"
import {
  checkBaselineAgainstCorpus,
  checkSchemaBinding,
  checkSchemaBindingCompleteness,
  recomputeSchemaBinding,
  sha256Hex,
  ExtractionSchemaBindingSchema,
  type ExtractionSchemaBinding,
} from "../static-gate.js"
import type { ExtractionCorpusFile } from "../schema.js"

function corpusOf(capability: string, caseIds: string[]): ExtractionCorpusFile {
  return {
    capability,
    source: "test-fixture",
    cases: caseIds.map((id) => ({
      id,
      utterance: `utterance for ${id}`,
      expectPayload: { extractionIR: { payload: { newStatus: "ready" } } },
    })),
  }
}

describe("checkBaselineAgainstCorpus", () => {
  it("GREEN: every baseline-claimed case exists in the corpus", () => {
    const corpus = [corpusOf("order.status.transition", ["a", "b", "c"])]
    const baseline = { passing: ["order.status.transition:a", "order.status.transition:b"] }
    const result = checkBaselineAgainstCorpus(baseline, corpus)
    expect(result).toEqual({ ok: true, orphanedBaselineClaims: [] })
  })

  it("RED: a baseline-claimed case that no longer exists in the corpus (renamed/removed/typo) is an orphaned claim", () => {
    const corpus = [corpusOf("order.status.transition", ["a", "b"])]
    const baseline = {
      passing: [
        "order.status.transition:a",
        "order.status.transition:renamed-away", // simulates a case-id rename that forgot the baseline
      ],
    }
    const result = checkBaselineAgainstCorpus(baseline, corpus)
    expect(result.ok).toBe(false)
    expect(result.orphanedBaselineClaims).toEqual(["order.status.transition:renamed-away"])
  })

  it("RED: an entire capability removed from the corpus orphans every one of its baseline claims", () => {
    const corpus: ExtractionCorpusFile[] = [] // the capability's corpus file was deleted entirely
    const baseline = { passing: ["order.status.transition:a", "order.status.transition:b"] }
    const result = checkBaselineAgainstCorpus(baseline, corpus)
    expect(result.ok).toBe(false)
    expect(result.orphanedBaselineClaims).toHaveLength(2)
  })

  it("an empty baseline (nothing claimed yet) is trivially consistent with any corpus", () => {
    const corpus = [corpusOf("order.status.transition", ["a"])]
    const result = checkBaselineAgainstCorpus({ passing: [] }, corpus)
    expect(result).toEqual({ ok: true, orphanedBaselineClaims: [] })
  })
})

describe("sha256Hex", () => {
  it("is deterministic and content-sensitive", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"))
    expect(sha256Hex("hello")).not.toBe(sha256Hex("hello!"))
    expect(sha256Hex("hello")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("checkSchemaBinding", () => {
  const GOLDEN_PATH =
    "apps/api/src/claustrum/language-engine/__tests__/__golden__/order-status-transition.extraction-prompt-fragment.json"
  const ORIGINAL_CONTENT = '{"expressIntentTool":{"newStatus":["ready","confirmed"]}}\n'

  function bindingFor(hash: string): ExtractionSchemaBinding {
    return {
      bindings: [
        {
          capability: "order.status.transition",
          goldenFragmentPath: GOLDEN_PATH,
          goldenFragmentSha256: hash,
        },
      ],
    }
  }

  it("GREEN: the binding's recorded hash matches the golden fragment's CURRENT bytes", () => {
    const binding = bindingFor(sha256Hex(ORIGINAL_CONTENT))
    const result = checkSchemaBinding(binding, new Map([[GOLDEN_PATH, ORIGINAL_CONTENT]]))
    expect(result).toEqual({ ok: true, drift: [] })
  })

  it("RED: a schema change (the golden fragment's bytes changed — e.g. a widened enum) drifts the recorded hash — the AC1 proof", () => {
    const binding = bindingFor(sha256Hex(ORIGINAL_CONTENT))
    // Simulates exactly what a live schema edit produces: the golden fixture
    // is correctly regenerated (so FE-T06's OWN golden gate stays green),
    // but nobody reviewed/re-committed the accuracy binding — this is the
    // gap the ticket's AC1 targets.
    const mutatedContent = '{"expressIntentTool":{"newStatus":["ready","confirmed","archived"]}}\n'
    const result = checkSchemaBinding(binding, new Map([[GOLDEN_PATH, mutatedContent]]))
    expect(result.ok).toBe(false)
    expect(result.drift).toEqual([
      {
        capability: "order.status.transition",
        goldenFragmentPath: GOLDEN_PATH,
        expectedSha256: sha256Hex(ORIGINAL_CONTENT),
        actualSha256: sha256Hex(mutatedContent),
      },
    ])
  })

  it("REVERT: reverting the golden fragment's bytes back to the bound content is green again (the gate is not permanently red)", () => {
    const binding = bindingFor(sha256Hex(ORIGINAL_CONTENT))
    const mutated = checkSchemaBinding(
      binding,
      new Map([[GOLDEN_PATH, '{"expressIntentTool":{"newStatus":["ready","confirmed","archived"]}}\n']]),
    )
    expect(mutated.ok).toBe(false)
    const reverted = checkSchemaBinding(binding, new Map([[GOLDEN_PATH, ORIGINAL_CONTENT]]))
    expect(reverted).toEqual({ ok: true, drift: [] })
  })

  it("a golden fragment file missing from the content map is skipped (a DIFFERENT problem — the caller's file-read failure), never silently treated as matching or as drift", () => {
    const binding = bindingFor(sha256Hex(ORIGINAL_CONTENT))
    const result = checkSchemaBinding(binding, new Map())
    expect(result).toEqual({ ok: true, drift: [] }) // no drift recorded — but also nothing was actually verified
  })

  it("multiple bound capabilities are each checked independently", () => {
    const contentA = "fragment-a"
    const contentB = "fragment-b"
    const binding: ExtractionSchemaBinding = {
      bindings: [
        { capability: "cap.a", goldenFragmentPath: "path/a.json", goldenFragmentSha256: sha256Hex(contentA) },
        { capability: "cap.b", goldenFragmentPath: "path/b.json", goldenFragmentSha256: sha256Hex(contentB) },
      ],
    }
    const result = checkSchemaBinding(
      binding,
      new Map([
        ["path/a.json", contentA],
        ["path/b.json", "DRIFTED"],
      ]),
    )
    expect(result.ok).toBe(false)
    expect(result.drift).toHaveLength(1)
    expect(result.drift[0]?.capability).toBe("cap.b")
  })
})

describe("checkSchemaBindingCompleteness (review MINOR follow-up, #266)", () => {
  it("GREEN: every committed golden fragment has a binding entry", () => {
    const binding: ExtractionSchemaBinding = {
      bindings: [
        { capability: "order.status.transition", goldenFragmentPath: "a.json", goldenFragmentSha256: "a".repeat(64) },
      ],
    }
    const result = checkSchemaBindingCompleteness(binding, ["a.json"])
    expect(result).toEqual({ ok: true, unboundGoldenFragments: [] })
  })

  it("RED: a NEW capability's golden fragment with NO binding entry at all silently escaping the acknowledgment layer — the AC1 gap checkSchemaBinding alone cannot catch (there's nothing to drift FROM)", () => {
    const binding: ExtractionSchemaBinding = {
      bindings: [
        { capability: "order.status.transition", goldenFragmentPath: "a.json", goldenFragmentSha256: "a".repeat(64) },
      ],
    }
    // Simulates exactly the scenario the review named: a parallel workstream
    // authors a brand-new capability's extraction schema + golden fragment,
    // but never adds a binding entry for it.
    const result = checkSchemaBindingCompleteness(binding, ["a.json", "some-new-capability.json"])
    expect(result.ok).toBe(false)
    expect(result.unboundGoldenFragments).toEqual(["some-new-capability.json"])
  })

  it("REVERT: adding the missing binding entry makes the SAME committed-fragment set green again", () => {
    const before: ExtractionSchemaBinding = {
      bindings: [
        { capability: "order.status.transition", goldenFragmentPath: "a.json", goldenFragmentSha256: "a".repeat(64) },
      ],
    }
    expect(checkSchemaBindingCompleteness(before, ["a.json", "b.json"]).ok).toBe(false)
    const after: ExtractionSchemaBinding = {
      bindings: [
        ...before.bindings,
        { capability: "some.new.capability", goldenFragmentPath: "b.json", goldenFragmentSha256: "b".repeat(64) },
      ],
    }
    expect(checkSchemaBindingCompleteness(after, ["a.json", "b.json"])).toEqual({
      ok: true,
      unboundGoldenFragments: [],
    })
  })

  it("an empty binding with no committed golden fragments at all is trivially complete", () => {
    const result = checkSchemaBindingCompleteness({ bindings: [] }, [])
    expect(result).toEqual({ ok: true, unboundGoldenFragments: [] })
  })

  it("multiple unbound fragments are ALL named, never just the first", () => {
    const result = checkSchemaBindingCompleteness({ bindings: [] }, ["x.json", "y.json", "z.json"])
    expect(result.ok).toBe(false)
    expect(result.unboundGoldenFragments).toEqual(["x.json", "y.json", "z.json"])
  })
})

describe("recomputeSchemaBinding", () => {
  it("rewrites the recorded hash to match the CURRENT golden fragment bytes (the --update-binding capture path)", () => {
    const path = "some/golden.json"
    const staleBinding: ExtractionSchemaBinding = {
      bindings: [{ capability: "order.status.transition", goldenFragmentPath: path, goldenFragmentSha256: sha256Hex("old") }],
    }
    const fresh = recomputeSchemaBinding(staleBinding, new Map([[path, "new"]]))
    expect(fresh.bindings[0]?.goldenFragmentSha256).toBe(sha256Hex("new"))
    // Round-trips: checking the recomputed binding against the SAME content is now green.
    expect(checkSchemaBinding(fresh, new Map([[path, "new"]])).ok).toBe(true)
  })

  it("leaves an entry untouched when its content is absent from the map (never silently zeroes a hash)", () => {
    const staleBinding: ExtractionSchemaBinding = {
      bindings: [{ capability: "x", goldenFragmentPath: "missing.json", goldenFragmentSha256: sha256Hex("old") }],
    }
    const result = recomputeSchemaBinding(staleBinding, new Map())
    expect(result).toEqual(staleBinding)
  })
})

describe("ExtractionSchemaBindingSchema", () => {
  it("accepts a well-formed binding file", () => {
    const parsed = ExtractionSchemaBindingSchema.safeParse({
      bindings: [
        {
          capability: "order.status.transition",
          goldenFragmentPath: "apps/api/x.json",
          goldenFragmentSha256: "a".repeat(64),
        },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a non-hex or wrong-length hash (a hand-edited typo)", () => {
    const parsed = ExtractionSchemaBindingSchema.safeParse({
      bindings: [
        { capability: "x", goldenFragmentPath: "y.json", goldenFragmentSha256: "not-a-hash" },
      ],
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects an unrecognized top-level key (strict schema)", () => {
    const parsed = ExtractionSchemaBindingSchema.safeParse({ bindings: [], extra: true })
    expect(parsed.success).toBe(false)
  })
})
