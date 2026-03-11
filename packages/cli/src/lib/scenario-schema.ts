// lib/scenario-schema.ts — Zod schema for YAML scenario validation.
// Validates the DSL structure: setup, cleanup, depends, tags, verify, rebuilds.

import { z } from "zod"

// ── Step names ───────────────────────────────────────────────────────────────

export const StepNameSchema = z.enum([
  "seed-products",
  "reindex",
  "seed-domain",
  "seed-homepage",
  "seed-delivery",
  "seed-orders",
  "sync-reviews",
  "intel-copurchase",
  "intel-global-score",
])

// ── Cleanup actions ──────────────────────────────────────────────────────────

export const CleanupActionSchema = z.enum([
  "reset-tags",
  "clear-reviews",
  "clear-orders",
  "clear-intel",
  "clear-all",
])

export type CleanupAction = z.infer<typeof CleanupActionSchema>

// ── Verify rules ─────────────────────────────────────────────────────────────

export const VerifyRuleSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  exists: z.boolean().optional(),
  contains: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
})

export type VerifyRule = z.infer<typeof VerifyRuleSchema>

// ── Simulate block ──────────────────────────────────────────────────────────

export const SimulateSchema = z.object({
  customers: z.number().default(40),
  days: z.number().default(30),
  ordersPerDay: z.number().default(15),
  seed: z.number().default(42),
  behavior: z.record(z.string(), z.number()).optional(),
  reviews: z.object({
    probability: z.number().default(0.3),
    ratingAvg: z.number().default(4.3),
  }).optional(),
})

export type SimulateBlock = z.infer<typeof SimulateSchema>

// ── Full scenario file schema ────────────────────────────────────────────────

export const ScenarioFileSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.enum(["ui", "intel", "customer"]).default("ui"),
  estimatedTime: z.number().optional(),

  // Scenario dependency graph (DAG)
  depends: z.array(z.string()).optional(),

  // Execution order: cleanup → setup → simulate → tags → rebuilds → verify
  cleanup: z.array(CleanupActionSchema).optional(),
  setup: z.array(StepNameSchema).default([]),
  simulate: SimulateSchema.optional(),
  tags: z.record(z.string(), z.array(z.string())).default({}),
  rebuilds: z.array(StepNameSchema).default([]),
  verify: z.record(z.string(), VerifyRuleSchema).default({}),
})

export type ScenarioFile = z.infer<typeof ScenarioFileSchema>
