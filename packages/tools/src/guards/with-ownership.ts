// Composable ownership guard wrappers for tool handlers.
//
// Extracts the repeated SEC-002 boilerplate (assertOrderOwnership / assertReservationOwnership)
// into higher-order functions that wrap existing tool handlers.

import type { AgentContext } from "@ibatexas/types";
import { assertOrderOwnership, assertReservationOwnership } from "./ownership.js";

type OrderToolHandler<T, R> = (input: T, ctx: AgentContext) => Promise<R>;
type ReservationToolHandler<T, R> = (input: T) => Promise<R>;

/**
 * Wrap a tool handler with order ownership verification.
 * The handler must accept (input, ctx) where input has `orderId` and ctx has `customerId`.
 * The guard runs assertOrderOwnership BEFORE the handler executes.
 * If ctx.customerId is missing, the guard is skipped — the handler is responsible
 * for its own auth check (throwing NonRetryableError for unauthenticated access).
 */
export function withOrderOwnership<T extends { orderId: string }, R>(
  handler: OrderToolHandler<T, R>,
): OrderToolHandler<T, R> {
  return async (input, ctx) => {
    if (ctx.customerId) {
      await assertOrderOwnership(input.orderId, ctx.customerId);
    }
    return handler(input, ctx);
  };
}

/**
 * Wrap a tool handler with reservation ownership verification.
 * The handler must accept (input) where input has `reservationId` and `customerId`.
 * The guard runs assertReservationOwnership BEFORE the handler executes.
 */
export function withReservationOwnership<T extends { reservationId: string; customerId: string }, R>(
  handler: ReservationToolHandler<T, R>,
): ReservationToolHandler<T, R> {
  return async (input) => {
    await assertReservationOwnership(input.reservationId, input.customerId);
    return handler(input);
  };
}
