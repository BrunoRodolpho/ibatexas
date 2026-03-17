// Tests for lib/scenario-schema.ts — Zod schema validation.
// Pure logic; no mocks needed.

import { describe, it, expect } from "vitest"

import {
  StepNameSchema,
  CleanupActionSchema,
  VerifyRuleSchema,
  SimulateSchema,
  ScenarioFileSchema,
} from "../lib/scenario-schema.js"

// ── StepNameSchema ───────────────────────────────────────────────────────────

describe("StepNameSchema", () => {
  const validSteps = [
    "seed-products",
    "reindex",
    "seed-domain",
    "seed-homepage",
    "seed-delivery",
    "seed-orders",
    "sync-reviews",
    "intel-copurchase",
    "intel-global-score",
  ]

  for (const step of validSteps) {
    it(`accepts valid step: ${step}`, () => {
      expect(StepNameSchema.parse(step)).toBe(step)
    })
  }

  it("rejects unknown step names", () => {
    expect(() => StepNameSchema.parse("invalid-step")).toThrow()
    expect(() => StepNameSchema.parse("")).toThrow()
    expect(() => StepNameSchema.parse(123)).toThrow()
  })
})

// ── CleanupActionSchema ──────────────────────────────────────────────────────

describe("CleanupActionSchema", () => {
  const validActions = [
    "reset-tags",
    "clear-reviews",
    "clear-orders",
    "clear-intel",
    "clear-all",
  ]

  for (const action of validActions) {
    it(`accepts valid action: ${action}`, () => {
      expect(CleanupActionSchema.parse(action)).toBe(action)
    })
  }

  it("rejects unknown cleanup actions", () => {
    expect(() => CleanupActionSchema.parse("delete-everything")).toThrow()
    expect(() => CleanupActionSchema.parse("")).toThrow()
  })
})

// ── VerifyRuleSchema ─────────────────────────────────────────────────────────

describe("VerifyRuleSchema", () => {
  it("parses a rule with min/max", () => {
    const result = VerifyRuleSchema.parse({ min: 5, max: 100 })
    expect(result.min).toBe(5)
    expect(result.max).toBe(100)
  })

  it("parses a rule with exists", () => {
    const result = VerifyRuleSchema.parse({ exists: true })
    expect(result.exists).toBe(true)
  })

  it("parses a rule with contains", () => {
    const result = VerifyRuleSchema.parse({ contains: ["brisket", "pulled-pork"] })
    expect(result.contains).toEqual(["brisket", "pulled-pork"])
  })

  it("parses a rule with order", () => {
    const result = VerifyRuleSchema.parse({ order: ["brisket", "costela"] })
    expect(result.order).toEqual(["brisket", "costela"])
  })

  it("allows empty object (all fields optional)", () => {
    const result = VerifyRuleSchema.parse({})
    expect(result).toEqual({})
  })

  it("rejects non-number min", () => {
    expect(() => VerifyRuleSchema.parse({ min: "five" })).toThrow()
  })

  it("rejects non-boolean exists", () => {
    expect(() => VerifyRuleSchema.parse({ exists: "yes" })).toThrow()
  })

  it("rejects non-array contains", () => {
    expect(() => VerifyRuleSchema.parse({ contains: "brisket" })).toThrow()
  })
})

// ── SimulateSchema ───────────────────────────────────────────────────────────

describe("SimulateSchema", () => {
  it("uses defaults when no values provided", () => {
    const result = SimulateSchema.parse({})
    expect(result.customers).toBe(40)
    expect(result.days).toBe(30)
    expect(result.ordersPerDay).toBe(15)
    expect(result.seed).toBe(42)
  })

  it("overrides defaults with provided values", () => {
    const result = SimulateSchema.parse({
      customers: 100,
      days: 60,
      ordersPerDay: 30,
      seed: 7,
    })
    expect(result.customers).toBe(100)
    expect(result.days).toBe(60)
    expect(result.ordersPerDay).toBe(30)
    expect(result.seed).toBe(7)
  })

  it("parses behavior distribution", () => {
    const result = SimulateSchema.parse({
      behavior: { pitmaster: 0.5, family: 0.5 },
    })
    expect(result.behavior).toEqual({ pitmaster: 0.5, family: 0.5 })
  })

  it("parses review configuration with defaults", () => {
    const result = SimulateSchema.parse({
      reviews: {},
    })
    expect(result.reviews?.probability).toBe(0.3)
    expect(result.reviews?.ratingAvg).toBe(4.3)
  })

  it("parses review configuration with custom values", () => {
    const result = SimulateSchema.parse({
      reviews: { probability: 0.5, ratingAvg: 4.0 },
    })
    expect(result.reviews?.probability).toBe(0.5)
    expect(result.reviews?.ratingAvg).toBe(4.0)
  })

  it("behavior is optional", () => {
    const result = SimulateSchema.parse({})
    expect(result.behavior).toBeUndefined()
  })
})

// ── ScenarioFileSchema ───────────────────────────────────────────────────────

describe("ScenarioFileSchema", () => {
  const minimalValid = {
    name: "homepage",
    description: "Homepage scenario",
  }

  it("parses a minimal scenario with defaults", () => {
    const result = ScenarioFileSchema.parse(minimalValid)
    expect(result.name).toBe("homepage")
    expect(result.description).toBe("Homepage scenario")
    expect(result.category).toBe("ui")
    expect(result.setup).toEqual([])
    expect(result.tags).toEqual({})
    expect(result.rebuilds).toEqual([])
    expect(result.verify).toEqual({})
    expect(result.depends).toBeUndefined()
    expect(result.cleanup).toBeUndefined()
    expect(result.simulate).toBeUndefined()
    expect(result.estimatedTime).toBeUndefined()
  })

  it("parses a full scenario", () => {
    const full = {
      name: "intel-test",
      description: "Intelligence scenario",
      category: "intel",
      estimatedTime: 120,
      depends: ["homepage"],
      cleanup: ["clear-all"],
      setup: ["seed-products", "reindex", "seed-domain"],
      simulate: {
        customers: 50,
        days: 14,
        ordersPerDay: 10,
        seed: 99,
      },
      tags: {
        "brisket-americano": ["popular", "chef_choice"],
      },
      rebuilds: ["intel-copurchase", "intel-global-score"],
      verify: {
        products: { min: 20 },
        reviews: { min: 10 },
        "global-score": { exists: true },
      },
    }

    const result = ScenarioFileSchema.parse(full)
    expect(result.name).toBe("intel-test")
    expect(result.category).toBe("intel")
    expect(result.estimatedTime).toBe(120)
    expect(result.depends).toEqual(["homepage"])
    expect(result.cleanup).toEqual(["clear-all"])
    expect(result.setup).toEqual(["seed-products", "reindex", "seed-domain"])
    expect(result.simulate?.customers).toBe(50)
    expect(result.tags["brisket-americano"]).toEqual(["popular", "chef_choice"])
    expect(result.rebuilds).toEqual(["intel-copurchase", "intel-global-score"])
    expect(result.verify.products).toEqual({ min: 20 })
  })

  it("rejects missing name", () => {
    expect(() =>
      ScenarioFileSchema.parse({ description: "No name" }),
    ).toThrow()
  })

  it("rejects missing description", () => {
    expect(() =>
      ScenarioFileSchema.parse({ name: "no-desc" }),
    ).toThrow()
  })

  it("rejects invalid category", () => {
    expect(() =>
      ScenarioFileSchema.parse({ ...minimalValid, category: "invalid" }),
    ).toThrow()
  })

  it("accepts all valid categories", () => {
    for (const cat of ["ui", "intel", "customer"]) {
      const result = ScenarioFileSchema.parse({ ...minimalValid, category: cat })
      expect(result.category).toBe(cat)
    }
  })

  it("rejects invalid step names in setup", () => {
    expect(() =>
      ScenarioFileSchema.parse({ ...minimalValid, setup: ["fake-step"] }),
    ).toThrow()
  })

  it("rejects invalid cleanup actions", () => {
    expect(() =>
      ScenarioFileSchema.parse({ ...minimalValid, cleanup: ["destroy-all"] }),
    ).toThrow()
  })

  it("rejects invalid step names in rebuilds", () => {
    expect(() =>
      ScenarioFileSchema.parse({ ...minimalValid, rebuilds: ["bad-step"] }),
    ).toThrow()
  })
})
