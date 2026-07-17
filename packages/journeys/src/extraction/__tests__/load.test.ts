// extraction/load.test.ts — YAML loader roundtrip over a temp corpus dir,
// plus a load of the REAL committed corpus (FE-T06).

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  loadExtractionCorpus,
  parseExtractionCorpusYaml,
  ExtractionCorpusLoadError,
  DEFAULT_EXTRACTION_CORPUS_DIR,
} from "../load.js"

const VALID_YAML = `
capability: order.status.transition
source: tickets/language-engine/issues/05-first-tracer.md
plane: ops
cases:
  - id: most-recent-order-to-ready
    utterance: muda o status do meu último pedido para pronto
    expectPayload:
      extractionIR:
        payload:
          newStatus: ready
        provenanceTrust:
          newStatus: untrusted
`

describe("parseExtractionCorpusYaml", () => {
  it("roundtrips a valid YAML document into a typed ExtractionCorpusFile", () => {
    const file = parseExtractionCorpusYaml(VALID_YAML, "order.status.transition.yaml")
    expect(file.capability).toBe("order.status.transition")
    expect(file.cases).toHaveLength(1)
    expect(file.cases[0]!.expectPayload.extractionIR.payload).toEqual({ newStatus: "ready" })
  })

  it("throws ExtractionCorpusLoadError with named errors on an invalid document", () => {
    expect(() => parseExtractionCorpusYaml("capability: NOT_VALID\ncases: []", "bad.yaml")).toThrow(
      ExtractionCorpusLoadError,
    )
    try {
      parseExtractionCorpusYaml("capability: NOT_VALID\ncases: []", "bad.yaml")
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionCorpusLoadError)
      expect((err as ExtractionCorpusLoadError).errors.map((e) => e.code)).toContain(
        "invalid_capability",
      )
    }
  })

  it("throws ExtractionCorpusLoadError on malformed YAML syntax", () => {
    expect(() => parseExtractionCorpusYaml("capability: [unterminated", "broken.yaml")).toThrow(
      ExtractionCorpusLoadError,
    )
  })
})

describe("loadExtractionCorpus", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ibx-extraction-corpus-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("loads every *.yaml sorted by filename", async () => {
    const second = VALID_YAML.replace("order.status.transition", "order.note.add").replace(
      "most-recent-order-to-ready",
      "add-a-note",
    )
    await writeFile(join(dir, "order.status.transition.yaml"), VALID_YAML)
    await writeFile(join(dir, "order.note.add.yaml"), second)

    const corpus = await loadExtractionCorpus(dir)
    expect(corpus.map((f) => f.capability)).toEqual(["order.note.add", "order.status.transition"])
  })

  it("rejects two files declaring the same capability", async () => {
    await writeFile(join(dir, "a.yaml"), VALID_YAML)
    await writeFile(join(dir, "b.yaml"), VALID_YAML)
    await expect(loadExtractionCorpus(dir)).rejects.toThrow(ExtractionCorpusLoadError)
    await expect(loadExtractionCorpus(dir)).rejects.toThrow(/duplicate_capability/)
  })

  it("DEFAULT_EXTRACTION_CORPUS_DIR resolves to packages/journeys/extraction-corpus", () => {
    expect(
      DEFAULT_EXTRACTION_CORPUS_DIR.replace(/\/$/, "").endsWith(
        "packages/journeys/extraction-corpus",
      ),
    ).toBe(true)
  })

  it("loads the REAL committed corpus (order.status.transition) without errors", async () => {
    const corpus = await loadExtractionCorpus()
    expect(corpus.map((f) => f.capability)).toContain("order.status.transition")
    const orderStatus = corpus.find((f) => f.capability === "order.status.transition")!
    expect(orderStatus.cases.map((c) => c.id)).toContain("most-recent-order-to-ready")
  })
})
