// Tests for lib/snapshot.ts — Snapshot save/load/compare.
// Mocks filesystem; never touches real disk.
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup ───────────────────────────────────────────────────────────────

const mockReadFile = vi.hoisted(() => vi.fn())
const mockWriteFile = vi.hoisted(() => vi.fn())
const mockMkdir = vi.hoisted(() => vi.fn())

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}))

// Freeze time for deterministic savedAt
vi.useFakeTimers()
vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"))

// ── Import source after mocks ────────────────────────────────────────────────

import {
  saveSnapshot,
  saveSnapshots,
  loadSnapshot,
  compareSnapshot,
  verifySnapshots,
  type SnapshotEntry,
} from "../lib/snapshot.js"
import type { MatrixStateResult } from "../lib/matrix.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<MatrixStateResult> = {}): MatrixStateResult {
  return {
    stateIndex: 0,
    activeVars: ["reviews"],
    checks: [
      { section: "hero-banner", expected: "visible", actual: "pass", detail: "ok" },
      { section: "review-stars", expected: "visible", actual: "pass", detail: "4.5 avg" },
    ],
    ok: true,
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    stateIndex: 0,
    activeVars: ["reviews"],
    checks: [
      { section: "hero-banner", expected: "visible", actual: "pass", detail: "ok" },
      { section: "review-stars", expected: "visible", actual: "pass", detail: "4.5 avg" },
    ],
    ok: true,
    savedAt: "2025-06-01T12:00:00.000Z",
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("saveSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
  })

  it("creates directory and writes snapshot file", async () => {
    const result = makeResult()
    const filePath = await saveSnapshot("homepage-matrix", result)

    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining("snapshots/homepage-matrix"), {
      recursive: true,
    })
    expect(mockWriteFile).toHaveBeenCalledTimes(1)

    const [path, content] = mockWriteFile.mock.calls[0]
    expect(path).toContain("state-0.json")

    const written = JSON.parse(content.replace(/\n$/, ""))
    expect(written.stateIndex).toBe(0)
    expect(written.activeVars).toEqual(["reviews"])
    expect(written.ok).toBe(true)
    expect(written.savedAt).toBe("2025-06-01T12:00:00.000Z")
    expect(filePath).toContain("state-0.json")
  })
})

describe("saveSnapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
  })

  it("saves multiple results and returns count", async () => {
    const results = [makeResult({ stateIndex: 0 }), makeResult({ stateIndex: 1 })]
    const count = await saveSnapshots("matrix-a", results)
    expect(count).toBe(2)
    expect(mockWriteFile).toHaveBeenCalledTimes(2)
  })

  it("returns 0 for empty results array", async () => {
    const count = await saveSnapshots("matrix-a", [])
    expect(count).toBe(0)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

describe("loadSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns parsed snapshot when file exists", async () => {
    const snapshot = makeSnapshot()
    mockReadFile.mockResolvedValue(JSON.stringify(snapshot))

    const result = await loadSnapshot("homepage-matrix", 0)
    expect(result).toEqual(snapshot)
  })

  it("returns null when file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))

    const result = await loadSnapshot("homepage-matrix", 99)
    expect(result).toBeNull()
  })

  it("returns null when file contains invalid JSON", async () => {
    mockReadFile.mockResolvedValue("not-json")

    const result = await loadSnapshot("homepage-matrix", 0)
    expect(result).toBeNull()
  })
})

describe("compareSnapshot", () => {
  it("returns null when snapshot and current match exactly", () => {
    const snapshot = makeSnapshot()
    const current = makeResult()
    const diff = compareSnapshot(snapshot, current)
    expect(diff).toBeNull()
  })

  it("detects a section that changed from pass to fail", () => {
    const snapshot = makeSnapshot()
    const current = makeResult({
      checks: [
        { section: "hero-banner", expected: "visible", actual: "pass", detail: "ok" },
        { section: "review-stars", expected: "visible", actual: "fail", detail: "0 avg" },
      ],
    })

    const diff = compareSnapshot(snapshot, current)
    expect(diff).not.toBeNull()
    expect(diff!.diffs).toHaveLength(1)
    expect(diff!.diffs[0]).toEqual({
      section: "review-stars",
      expected: "visible",
      snapshotActual: "pass",
      currentActual: "fail",
    })
  })

  it("detects a section missing from current results", () => {
    const snapshot = makeSnapshot()
    const current = makeResult({
      checks: [
        { section: "hero-banner", expected: "visible", actual: "pass", detail: "ok" },
        // review-stars is missing
      ],
    })

    const diff = compareSnapshot(snapshot, current)
    expect(diff).not.toBeNull()
    expect(diff!.diffs).toHaveLength(1)
    expect(diff!.diffs[0].currentActual).toBe("missing")
  })

  it("detects a section added in current that was not in snapshot", () => {
    const snapshot = makeSnapshot({
      checks: [
        { section: "hero-banner", expected: "visible", actual: "pass", detail: "ok" },
      ],
    })
    const current = makeResult({
      checks: [
        { section: "hero-banner", expected: "visible", actual: "pass", detail: "ok" },
        { section: "new-section", expected: "hidden", actual: "pass", detail: "new" },
      ],
    })

    const diff = compareSnapshot(snapshot, current)
    expect(diff).not.toBeNull()
    expect(diff!.diffs).toHaveLength(1)
    expect(diff!.diffs[0].snapshotActual).toBe("missing")
    expect(diff!.diffs[0].section).toBe("new-section")
  })

  it("returns correct stateIndex in diff", () => {
    const snapshot = makeSnapshot({ stateIndex: 5 })
    const current = makeResult({
      stateIndex: 5,
      checks: [
        { section: "hero-banner", expected: "visible", actual: "fail", detail: "gone" },
      ],
    })

    const diff = compareSnapshot(snapshot, current)
    expect(diff).not.toBeNull()
    expect(diff!.stateIndex).toBe(5)
  })
})

describe("verifySnapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reports all matched when snapshots match", async () => {
    const snapshot = makeSnapshot()
    mockReadFile.mockResolvedValue(JSON.stringify(snapshot))

    const results = [makeResult()]
    const verification = await verifySnapshots("matrix-a", results)

    expect(verification.matched).toBe(1)
    expect(verification.drifted).toBe(0)
    expect(verification.missing).toBe(0)
    expect(verification.diffs).toHaveLength(0)
  })

  it("reports missing when no snapshot exists", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))

    const results = [makeResult()]
    const verification = await verifySnapshots("matrix-a", results)

    expect(verification.matched).toBe(0)
    expect(verification.drifted).toBe(0)
    expect(verification.missing).toBe(1)
  })

  it("reports drifted when snapshot does not match", async () => {
    const snapshot = makeSnapshot()
    mockReadFile.mockResolvedValue(JSON.stringify(snapshot))

    const results = [
      makeResult({
        checks: [
          { section: "hero-banner", expected: "visible", actual: "fail", detail: "gone" },
          { section: "review-stars", expected: "visible", actual: "pass", detail: "4.5" },
        ],
      }),
    ]
    const verification = await verifySnapshots("matrix-a", results)

    expect(verification.matched).toBe(0)
    expect(verification.drifted).toBe(1)
    expect(verification.diffs).toHaveLength(1)
  })

  it("handles mix of matched, drifted, and missing", async () => {
    const snapshot0 = makeSnapshot({ stateIndex: 0 })
    const snapshot1 = makeSnapshot({ stateIndex: 1 })

    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(snapshot0)) // match
      .mockResolvedValueOnce(JSON.stringify(snapshot1)) // drift
      .mockRejectedValueOnce(new Error("ENOENT")) // missing

    const results = [
      makeResult({ stateIndex: 0 }),
      makeResult({
        stateIndex: 1,
        checks: [
          { section: "hero-banner", expected: "visible", actual: "fail", detail: "gone" },
          { section: "review-stars", expected: "visible", actual: "pass", detail: "4.5" },
        ],
      }),
      makeResult({ stateIndex: 2 }),
    ]

    const verification = await verifySnapshots("matrix-a", results)
    expect(verification.matched).toBe(1)
    expect(verification.drifted).toBe(1)
    expect(verification.missing).toBe(1)
  })
})
