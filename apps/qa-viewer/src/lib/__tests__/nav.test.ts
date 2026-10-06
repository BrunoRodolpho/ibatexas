// Hash route grammar — the deep-link contract every cross-surface jump
// (run trace → RCA, LLM call → Prompts) and every shareable investigation
// URL depends on. Pure parse/build pins; no DOM.

import { describe, expect, it } from "vitest"
import { buildHash, parseHash, type HashRoute } from "../nav"

describe("parseHash", () => {
  it("parses the three sections bare", () => {
    expect(parseHash("#qa")).toEqual({ section: "qa" })
    expect(parseHash("#rca")).toEqual({ section: "rca" })
    expect(parseHash("#prompts")).toEqual({ section: "prompts" })
  })

  it("parses a qa tab", () => {
    expect(parseHash("#qa/run-explorer")).toEqual({ section: "qa", tab: "run-explorer" })
  })

  it("parses rca conv + turn in either combination", () => {
    expect(parseHash("#rca/conv/abc/turn/xyz")).toEqual({ section: "rca", conv: "abc", turn: "xyz" })
    expect(parseHash("#rca/turn/xyz")).toEqual({ section: "rca", turn: "xyz" })
    expect(parseHash("#rca/conv/abc")).toEqual({ section: "rca", conv: "abc" })
  })

  it("keeps colons in ops-plane conversation ids (admin:<staffId>)", () => {
    expect(parseHash("#rca/conv/admin:staff1")).toEqual({ section: "rca", conv: "admin:staff1" })
  })

  it("treats everything after prompts/ as the prompt id (ids contain slashes)", () => {
    expect(parseHash("#prompts/ibatexas/planner.persona")).toEqual({
      section: "prompts",
      promptId: "ibatexas/planner.persona",
    })
  })

  it("returns null for empty or unknown hashes", () => {
    expect(parseHash("")).toBeNull()
    expect(parseHash("#")).toBeNull()
    expect(parseHash("#bogus/whatever")).toBeNull()
  })

  it("still addresses SESSIONS after LE2-031 grouping — a group is never an address", () => {
    // The rail now renders customers above sessions, but the shared address
    // space did not move: every existing link, bookmark and cross-surface jump
    // still names conv/<sessionId>[/turn/<turnId>]. A group key
    // (customer:… / ops:… / unidentified) is a VIEW concern; it never appears
    // in the hash, so grouping cannot break a link that already worked.
    expect(parseHash("#rca/conv/sess-uuid/turn/turn-9")).toEqual({
      section: "rca",
      conv: "sess-uuid",
      turn: "turn-9",
    })
    expect(buildHash({ section: "rca", conv: "sess-uuid" })).toBe("#rca/conv/sess-uuid")
  })
})

describe("buildHash", () => {
  it("round-trips every route shape", () => {
    const routes: HashRoute[] = [
      { section: "qa" },
      { section: "qa", tab: "coverage" },
      { section: "rca" },
      { section: "rca", conv: "admin:staff1" },
      { section: "rca", conv: "conv-1", turn: "turn-9" },
      { section: "prompts" },
      { section: "prompts", promptId: "ops/responder.grounded" },
    ]
    for (const r of routes) {
      expect(parseHash(buildHash(r))).toEqual(r)
    }
  })
})
