// Tests for lib/simulator.ts — simulation engine.
//
// SKIP RATIONALE: The simulator module is too tightly coupled to infrastructure
// to mock cleanly in a pure unit test:
//   - runSimulation() does dynamic import("@ibatexas/domain") for Prisma
//   - generateCustomers() calls prisma.customer.upsert inside a loop
//   - writeOrdersToDB / writeReviewsToDB write directly to Prisma
//   - loadCatalog() calls medusaFetch in a paginated loop
//   - Uses ora spinners for console output throughout
//
// The helper functions (pickWeighted, normalRandom, clamp, buildOrder,
// maybeBuildReview, resolveSimConfig) are not exported, so they cannot
// be tested directly.
//
// To test this module properly, we would need:
//   1. Export the pure helpers and test them independently
//   2. Or extract an integration test that uses a real (or test) database
//
// For now, we test the exported data/config pieces indirectly via profiles.test.ts.

import { describe, it } from "vitest"

describe("simulator", () => {
  it.skip("SKIPPED — too tightly coupled to Prisma + Medusa; see rationale above", () => {})
})
