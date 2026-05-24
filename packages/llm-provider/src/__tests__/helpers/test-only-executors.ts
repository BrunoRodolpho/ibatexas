// Test-only execution helpers (Task 06 — replaces `executeToolDirect`).
//
// Background: `executeToolDirect` used to be exported from
// `packages/llm-provider/src/tool-registry.ts` to give kernel-side callers a
// way to invoke a tool handler WITHOUT going through the Zero-Trust intent
// bridge. In practice the kernel never called it — only tests did. Per
// investigation 01 §"P2 #5" / task 06, it was a foot-gun: any future caller
// importing the symbol could trivially mutate state without policy review.
//
// Task 06 removed `executeToolDirect` from the public package surface. The
// existing tests in `tool-registry.test.ts` and `tool-registry-edge-cases.test.ts`
// still need a way to exercise the underlying handler bindings for
// `withCustomerId`-style auth checks. That responsibility now lives here, in a
// test-only module that lives under `__tests__/helpers/` so production
// imports cannot reach it.
//
// This helper deliberately re-imports the `@ibatexas/tools` handlers DIRECTLY
// (matching the original bindings in `tool-registry.ts:206-279`) instead of
// re-exporting `executeToolDirect`. The latter would require keeping the
// function alive on the tool-registry module, which is exactly what task 06
// removed. The duplication is intentional: it isolates the bypass to a single
// known-test scope.
//
// Coverage today is narrow — only the reservation tools the existing
// edge-case suite asserts on. Add more bindings here if you need them, but
// resist the urge to make this a general-purpose executor; that's what
// `executeTool` + the dispatcher + the kernel-executor are for.

import { z } from "zod"
import type { AgentContext } from "@ibatexas/types"
import {
  CreateReservationInputSchema,
  ModifyReservationInputSchema,
  CancelReservationInputSchema,
  GetMyReservationsInputSchema,
  JoinWaitlistInputSchema,
} from "@ibatexas/types"
import {
  createReservation,
  modifyReservation,
  cancelReservation,
  getMyReservations,
  joinWaitlist,
} from "@ibatexas/tools"

// ── withCustomerId clone (test-scoped) ───────────────────────────────────────

function withCustomerId<T extends { customerId?: string }>(
  fn: (input: T) => Promise<unknown>,
): (input: unknown, ctx: AgentContext) => Promise<unknown> {
  return (input, ctx) => {
    const i = input as T
    if (!ctx.customerId) {
      throw new Error(
        "Autenticação necessária. O cliente precisa se identificar para usar esta funcionalidade.",
      )
    }
    return fn({ ...i, customerId: ctx.customerId })
  }
}

// ── Handler table (mirrors tool-registry.ts entries for the 5 reservation tools) ──

type Handler = (input: unknown, ctx: AgentContext) => Promise<unknown>

const handlers = new Map<string, Handler>([
  ["create_reservation", withCustomerId(createReservation)],
  ["modify_reservation", withCustomerId(modifyReservation)],
  ["cancel_reservation", withCustomerId(cancelReservation)],
  ["get_my_reservations", withCustomerId(getMyReservations)],
  ["join_waitlist", withCustomerId(joinWaitlist)],
])

const schemas = new Map<string, z.ZodTypeAny>([
  ["create_reservation", CreateReservationInputSchema.partial({ customerId: true })],
  ["modify_reservation", ModifyReservationInputSchema.partial({ customerId: true })],
  ["cancel_reservation", CancelReservationInputSchema.partial({ customerId: true })],
  ["get_my_reservations", GetMyReservationsInputSchema.partial({ customerId: true })],
  ["join_waitlist", JoinWaitlistInputSchema.partial({ customerId: true })],
])

/**
 * @internal — TEST USE ONLY.
 *
 * Direct handler dispatch that bypasses the intent bridge. Replaces the
 * removed `executeToolDirect` export from `tool-registry.ts`. The narrow
 * surface (5 reservation tools) is the only thing existing tests still
 * exercise via this path; everything else flows through `executeTool` and
 * the kernel-direct envelope wrapping (kernel-executor.ts).
 *
 * If you find yourself wanting to call this from production code, you are
 * almost certainly looking for `executeTool` (the intent-bridge entry) or
 * `executeKernel` (the deterministic mutation path with adjudicate()).
 */
export async function executeToolForTest(
  name: string,
  input: unknown,
  ctx: AgentContext,
): Promise<unknown> {
  const handler = handlers.get(name)
  if (!handler) {
    throw new Error(`Ferramenta desconhecida: ${name}`)
  }
  const schema = schemas.get(name)
  if (schema) {
    schema.parse(input)
  }
  return handler(input, ctx)
}
