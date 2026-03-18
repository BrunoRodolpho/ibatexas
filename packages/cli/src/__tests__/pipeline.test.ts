// Tests for lib/pipeline.ts — pipeline step execution.
// Mocks ora/chalk output; tests pure execution logic.

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock ora (spinner) ──────────────────────────────────────────────────────

const mockSpinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  stopAndPersist: vi.fn().mockReturnThis(),
  text: "",
}))

vi.mock("ora", () => ({
  default: vi.fn(() => mockSpinner),
}))

// Freeze time for deterministic duration calculations
vi.useFakeTimers()
vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"))

// ── Import source after mocks ────────────────────────────────────────────────

import { runPipeline, type PipelineTask } from "../lib/pipeline.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeTask(
  name: string,
  opts: { fail?: boolean; delay?: number } = {},
): PipelineTask {
  return {
    name,
    label: `Task: ${name}`,
    run: async () => {
      if (opts.delay) {
        vi.advanceTimersByTime(opts.delay)
      }
      if (opts.fail) throw new Error(`${name} failed`)
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runPipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Suppress console output from pipeline
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("runs all tasks and returns ok=true on success", async () => {
    const tasks = [makeTask("step-a"), makeTask("step-b"), makeTask("step-c")]
    const result = await runPipeline(tasks)

    expect(result.ok).toBe(true)
    expect(result.steps).toHaveLength(3)
    expect(result.steps.every((s) => s.status === "ok")).toBe(true)
  })

  it("stops on first failure and returns ok=false", async () => {
    const tasks = [
      makeTask("step-a"),
      makeTask("step-b", { fail: true }),
      makeTask("step-c"),
    ]
    const result = await runPipeline(tasks)

    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].status).toBe("ok")
    expect(result.steps[1].status).toBe("failed")
    expect(result.steps[1].error).toBe("step-b failed")
  })

  it("records step names and labels", async () => {
    const tasks = [makeTask("seed"), makeTask("reindex")]
    const result = await runPipeline(tasks)

    expect(result.steps[0].name).toBe("seed")
    expect(result.steps[0].label).toBe("Task: seed")
    expect(result.steps[1].name).toBe("reindex")
  })

  it("empty pipeline returns ok=true with no steps", async () => {
    const result = await runPipeline([])
    expect(result.ok).toBe(true)
    expect(result.steps).toHaveLength(0)
  })
})

describe("runPipeline — skip option", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("skips tasks matching skip patterns", async () => {
    const tasks = [
      makeTask("seed-products"),
      makeTask("reindex"),
      makeTask("seed-domain"),
    ]
    const result = await runPipeline(tasks, { skip: ["seed"] })

    expect(result.ok).toBe(true)
    const statuses = result.steps.map((s) => ({ name: s.name, status: s.status }))
    expect(statuses).toEqual([
      { name: "seed-products", status: "skipped" },
      { name: "reindex", status: "ok" },
      { name: "seed-domain", status: "skipped" },
    ])
  })

  it("skip uses substring matching", async () => {
    const tasks = [makeTask("intel-copurchase"), makeTask("intel-global-score")]
    const result = await runPipeline(tasks, { skip: ["intel"] })

    expect(result.steps.every((s) => s.status === "skipped")).toBe(true)
  })
})

describe("runPipeline — dryRun option", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  it("returns ok=true with empty steps and does not run tasks", async () => {
    let ran = false
    const tasks: PipelineTask[] = [
      {
        name: "expensive",
        label: "Expensive task",
        run: async () => {
          ran = true
        },
      },
    ]
    const result = await runPipeline(tasks, { dryRun: true })

    expect(result.ok).toBe(true)
    expect(result.steps).toHaveLength(0)
    expect(result.totalMs).toBe(0)
    expect(ran).toBe(false)
  })
})

describe("runPipeline — from option", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("skips tasks before the 'from' task", async () => {
    const tasks = [
      makeTask("step-a"),
      makeTask("step-b"),
      makeTask("step-c"),
    ]
    const result = await runPipeline(tasks, { from: "step-b" })

    expect(result.ok).toBe(true)
    expect(result.steps[0].status).toBe("skipped")
    expect(result.steps[1].status).toBe("ok")
    expect(result.steps[2].status).toBe("ok")
  })
})
