// SEC-002: Ownership guards for tool parameters.
//
// Defense-in-depth: validates that the resource (order, reservation) belongs
// to the authenticated customer BEFORE any business logic executes.
// Prevents prompt injection attacks where the LLM supplies another customer's
// resource IDs as tool parameters.

import { NonRetryableError } from "@ibatexas/types";
import { prisma } from "@ibatexas/domain";
import { medusaAdminFetch } from "../cart/_shared.js";

/**
 * Assert that a Medusa order belongs to the given customer.
 * Checks `customer_id` on the order and falls back to `metadata.customerId`.
 *
 * STRICT BY DEFAULT (SDD Inv 2 — ownership is a property of the
 * `customer_scoped` claim TYPE, not a per-call flag): an order with NO owner
 * attribution is a "no owner" resource and resolves REFUSED ("no owner" ≠
 * "any owner"), so it THROWS unless the caller opens the explicit
 * `{ allowUnowned: true }` escape hatch — granted only on a genuine
 * staff/legacy path. Omitting it fails CLOSED.
 *
 * @throws NonRetryableError if the order doesn't exist, belongs to another
 *   customer, or (unless `allowUnowned`) has no owner attribution at all.
 */
export async function assertOrderOwnership(
  orderId: string,
  customerId: string,
  opts?: { allowUnowned?: boolean },
): Promise<void> {
  const data = await medusaAdminFetch(`/admin/orders/${orderId}`) as {
    order?: {
      customer_id?: string;
      metadata?: Record<string, string>;
    };
  };

  if (!data.order) {
    throw new NonRetryableError("Pedido não encontrado.");
  }

  const orderCustomerId = data.order.customer_id ?? data.order.metadata?.["customerId"];
  if (!orderCustomerId) {
    // Order has no customer attribution.
    if (opts?.allowUnowned) {
      // Explicit escape hatch: a genuine staff/legacy path operating on an
      // unowned/guest order. This is the ONLY way an unowned order passes.
      return;
    }
    // Inv 2 (strict default): a customer_scoped resource with no owner resolves
    // REFUSED ("no owner" ≠ "any owner") — fail CLOSED, never leak it.
    throw new NonRetryableError("Acesso negado: este pedido pertence a outro cliente.");
  }
  if (orderCustomerId !== customerId) {
    throw new NonRetryableError("Acesso negado: este pedido pertence a outro cliente.");
  }
}

/**
 * Assert that a reservation belongs to the given customer.
 * Queries Prisma directly for a lightweight ownership check.
 *
 * @throws NonRetryableError if the reservation doesn't exist or belongs to another customer
 */
export async function assertReservationOwnership(
  reservationId: string,
  customerId: string,
): Promise<void> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { customerId: true },
  });

  if (!reservation) {
    throw new NonRetryableError("Reserva não encontrada.");
  }

  if (reservation.customerId !== customerId) {
    throw new NonRetryableError("Acesso negado: esta reserva pertence a outro cliente.");
  }
}
