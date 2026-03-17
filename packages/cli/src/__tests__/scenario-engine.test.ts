// Tests for lib/scenario-engine.ts — scenario execution engine.
// Uses pure boundary mocking: all external I/O (fs, Redis, Medusa, etc.) is mocked.

import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup (vi.hoisted + vi.mock BEFORE imports) ─────────────────────────

const mockReaddir = vi.hoisted(() => vi.fn())
const mockReadFile = vi.hoisted(() => vi.fn())

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
}))

const mockReleaseLock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockAcquireScenarioLock = vi.hoisted(() => vi.fn().mockResolvedValue(mockReleaseLock))

vi.mock("../lib/lock.js", () => ({
  acquireScenarioLock: mockAcquireScenarioLock,
}))

const mockEmit = vi.hoisted(() => vi.fn())
const mockEmitScenarioStart = vi.hoisted(() => vi.fn())
const mockEmitScenarioFinish = vi.hoisted(() => vi.fn())

vi.mock("../lib/events.js", () => ({
  emit: mockEmit,
  emitScenarioStart: mockEmitScenarioStart,
  emitScenarioFinish: mockEmitScenarioFinish,
}))

const mockGetAdminToken = vi.hoisted(() => vi.fn().mockResolvedValue("test-token"))
const mockFindOrCreateTag = vi.hoisted(() => vi.fn().mockResolvedValue("tag_1"))
const mockFindProductByHandle = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const mockUpdateProductTags = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockRemoveAllTagsFromAllProducts = vi.hoisted(() => vi.fn().mockResolvedValue(0))
const mockFetchAllProductsWithTags = vi.hoisted(() => vi.fn().mockResolvedValue([]))

vi.mock("../lib/medusa.js", () => ({
  getAdminToken: mockGetAdminToken,
  findOrCreateTag: mockFindOrCreateTag,
  findProductByHandle: mockFindProductByHandle,
  updateProductTags: mockUpdateProductTags,
  removeAllTagsFromAllProducts: mockRemoveAllTagsFromAllProducts,
  fetchAllProductsWithTags: mockFetchAllProductsWithTags,
}))

const mockGetRedis = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    zCard: vi.fn().mockResolvedValue(0),
    zRangeWithScores: vi.fn().mockResolvedValue([]),
    zScore: vi.fn().mockResolvedValue(null),
  }),
)
const mockRk = vi.hoisted(() => vi.fn((key: string) => `test:${key}`))
const mockCloseRedis = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockScanDelete = vi.hoisted(() => vi.fn().mockResolvedValue(0))
const mockScanCount = vi.hoisted(() => vi.fn().mockResolvedValue(0))

vi.mock("../lib/redis.js", () => ({
  getRedis: mockGetRedis,
  rk: mockRk,
  closeRedis: mockCloseRedis,
  scanDelete: mockScanDelete,
  scanCount: mockScanCount,
}))

const mockStabilizeProducts = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("../lib/stabilize.js", () => ({
  stabilizeProducts: mockStabilizeProducts,
}))

const mockRunPipeline = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, steps: [], totalMs: 0 }),
)

vi.mock("../lib/pipeline.js", () => ({
  runPipeline: mockRunPipeline,
}))

const mockStepRegistry = vi.hoisted(() =>
  new Proxy({} as Record<string, { label: string; run: () => Promise<void> }>, {
    get: (_target, prop) => ({
      label: `Step: ${String(prop)}`,
      run: vi.fn().mockResolvedValue(undefined),
    }),
  }),
)

vi.mock("../lib/steps.js", () => ({
  StepRegistry: mockStepRegistry,
}))

// Mock chalk as passthrough
vi.mock("chalk", () => {
  const passthrough = (s: unknown) => String(s)
  const handler: ProxyHandler<typeof passthrough> = {
    get: () => new Proxy(passthrough, handler),
    apply: (_target, _thisArg, args) => String(args[0]),
  }
  return { default: new Proxy(passthrough, handler) }
})

// Mock ora
const mockSpinner = vi.hoisted(() => ({
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  stop: vi.fn().mockReturnThis(),
  stopAndPersist: vi.fn().mockReturnThis(),
  text: "",
}))

vi.mock("ora", () => ({
  default: vi.fn(() => mockSpinner),
}))

// Mock @ibatexas/domain (dynamic import in scenario-engine)
vi.mock("@ibatexas/domain", () => ({
  prisma: {
    review: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    customerOrderItem: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), count: vi.fn().mockResolvedValue(0) },
    customer: { count: vi.fn().mockResolvedValue(0) },
    address: { count: vi.fn().mockResolvedValue(0) },
    customerPreferences: { count: vi.fn().mockResolvedValue(0) },
    reservation: { count: vi.fn().mockResolvedValue(0) },
    table: { count: vi.fn().mockResolvedValue(0) },
    deliveryZone: { count: vi.fn().mockResolvedValue(0) },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}))

// ── Import source after mocks ────────────────────────────────────────────────

import { discoverScenarios, runScenario, type ScenarioOptions } from "../lib/scenario-engine.js"

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_SCENARIO_YAML = `
name: test-scenario
description: A test scenario
category: ui
setup:
  - seed-products
  - reindex
tags:
  brisket-americano:
    - destaque
    - premium
rebuilds: []
verify:
  products:
    min: 1
`

const MINIMAL_SCENARIO_YAML = `
name: minimal
description: Minimal scenario
setup: []
tags: {}
rebuilds: []
verify: {}
`

const INVALID_YAML = `
completely invalid: [{{not yaml}}}
`

const MISSING_NAME_YAML = `
description: Missing name field
setup: []
`

// ── Tests ────────────────────────────────────────────────────────────────────

describe("discoverScenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("returns scenario names from valid yaml files", async () => {
    mockReaddir.mockResolvedValue(["homepage.yml", "intel-test.yaml", "readme.md"])
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes("homepage.yml")) {
        return Promise.resolve(`name: homepage\ndescription: Homepage scenario\nsetup: []\ntags: {}\nrebuilds: []\nverify: {}`)
      }
      if (filePath.includes("intel-test.yaml")) {
        return Promise.resolve(`name: intel-test\ndescription: Intel test\nsetup: []\ntags: {}\nrebuilds: []\nverify: {}`)
      }
      return Promise.reject(new Error("not found"))
    })

    const scenarios = await discoverScenarios()
    expect(scenarios).toHaveLength(2)
    expect(scenarios[0].name).toBe("homepage")
    expect(scenarios[1].name).toBe("intel-test")
  })

  it("skips non-yaml files", async () => {
    mockReaddir.mockResolvedValue(["readme.md", "config.json"])
    const scenarios = await discoverScenarios()
    expect(scenarios).toHaveLength(0)
  })

  it("skips invalid yaml files gracefully", async () => {
    mockReaddir.mockResolvedValue(["broken.yml"])
    mockReadFile.mockResolvedValue(INVALID_YAML)
    const scenarios = await discoverScenarios()
    expect(scenarios).toHaveLength(0)
  })

  it("returns empty array when scenarios directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"))
    const scenarios = await discoverScenarios()
    expect(scenarios).toEqual([])
  })

  it("sorts scenarios alphabetically by filename", async () => {
    mockReaddir.mockResolvedValue(["z-scenario.yml", "a-scenario.yml"])
    mockReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes("z-scenario.yml")) {
        return Promise.resolve(`name: z-scenario\ndescription: Z\nsetup: []\ntags: {}\nrebuilds: []\nverify: {}`)
      }
      if (filePath.includes("a-scenario.yml")) {
        return Promise.resolve(`name: a-scenario\ndescription: A\nsetup: []\ntags: {}\nrebuilds: []\nverify: {}`)
      }
      return Promise.reject(new Error("not found"))
    })

    const scenarios = await discoverScenarios()
    expect(scenarios[0].name).toBe("a-scenario")
    expect(scenarios[1].name).toBe("z-scenario")
  })
})

describe("runScenario — dry-run mode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockReadFile.mockResolvedValue(VALID_SCENARIO_YAML)
  })

  it("returns true without acquiring lock", async () => {
    const result = await runScenario("test-scenario", { dryRun: true })

    expect(result).toBe(true)
    expect(mockAcquireScenarioLock).not.toHaveBeenCalled()
  })

  it("does not call runPipeline or emit scenario events", async () => {
    await runScenario("test-scenario", { dryRun: true })

    expect(mockRunPipeline).not.toHaveBeenCalled()
    expect(mockEmitScenarioStart).not.toHaveBeenCalled()
    expect(mockEmitScenarioFinish).not.toHaveBeenCalled()
  })

  it("prints scenario name from YAML", async () => {
    const logSpy = vi.spyOn(console, "log")
    await runScenario("test-scenario", { dryRun: true })

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(allOutput).toContain("test-scenario")
  })
})

describe("runScenario — full execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockReadFile.mockResolvedValue(VALID_SCENARIO_YAML)
  })

  it("acquires lock, emits events, then releases lock", async () => {
    await runScenario("test-scenario")

    expect(mockAcquireScenarioLock).toHaveBeenCalledWith("test-scenario", { force: undefined })
    expect(mockEmitScenarioStart).toHaveBeenCalledWith("test-scenario")
    expect(mockReleaseLock).toHaveBeenCalled()
    expect(mockEmitScenarioFinish).toHaveBeenCalledWith("test-scenario", expect.any(Number))
  })

  it("passes setup steps to runPipeline", async () => {
    await runScenario("test-scenario")

    expect(mockRunPipeline).toHaveBeenCalled()
    const tasks = mockRunPipeline.mock.calls[0][0]
    expect(tasks).toHaveLength(2)
    expect(tasks[0].name).toBe("seed-products")
    expect(tasks[1].name).toBe("reindex")
  })

  it("releases lock even when pipeline fails", async () => {
    mockRunPipeline.mockResolvedValueOnce({ ok: false, steps: [], totalMs: 0 })
    const result = await runScenario("test-scenario")

    expect(result).toBe(false)
    expect(mockReleaseLock).toHaveBeenCalled()
    expect(mockEmitScenarioFinish).toHaveBeenCalled()
  })

  it("returns false when lock acquisition fails", async () => {
    mockAcquireScenarioLock.mockRejectedValueOnce(new Error("Lock held by another scenario"))
    const result = await runScenario("test-scenario")

    expect(result).toBe(false)
    expect(mockRunPipeline).not.toHaveBeenCalled()
  })

  it("closes Redis in finally block", async () => {
    await runScenario("test-scenario")
    expect(mockCloseRedis).toHaveBeenCalled()
  })

  it("uses opts.file path when provided", async () => {
    await runScenario("ignored-name", { file: "/custom/path/scenario.yml" })
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining("/custom/path/scenario.yml"),
      "utf-8",
    )
  })

  it("passes force option to acquireScenarioLock", async () => {
    await runScenario("test-scenario", { force: true })
    expect(mockAcquireScenarioLock).toHaveBeenCalledWith("test-scenario", { force: true })
  })
})

describe("runScenario — verifyOnly mode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("runs verify checks without acquiring lock or running setup", async () => {
    mockReadFile.mockResolvedValue(VALID_SCENARIO_YAML)
    const result = await runScenario("test-scenario", { verifyOnly: true })

    // verifyOnly does not acquire the lock
    expect(mockAcquireScenarioLock).not.toHaveBeenCalled()
    // verifyOnly does not run pipeline
    expect(mockRunPipeline).not.toHaveBeenCalled()
    // Still closes resources
    expect(mockCloseRedis).toHaveBeenCalled()
    expect(typeof result).toBe("boolean")
  })

  it("returns true when no verify rules are defined", async () => {
    mockReadFile.mockResolvedValue(MINIMAL_SCENARIO_YAML)
    const result = await runScenario("minimal", { verifyOnly: true })
    expect(result).toBe(true)
  })
})

describe("runScenario — YAML loading errors", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("throws when YAML file does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"))
    await expect(runScenario("nonexistent")).rejects.toThrow()
  })

  it("throws when YAML fails Zod validation (missing name)", async () => {
    mockReadFile.mockResolvedValue(MISSING_NAME_YAML)
    await expect(runScenario("bad-schema")).rejects.toThrow()
  })
})

describe("runScenario — minimal scenario (no steps)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockReadFile.mockResolvedValue(MINIMAL_SCENARIO_YAML)
  })

  it("succeeds with empty setup, tags, rebuilds, and verify", async () => {
    const result = await runScenario("minimal")
    expect(result).toBe(true)
  })
})
