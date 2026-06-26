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
 * By default an order with NO owner attribution is allowed (legacy/guest order
 * accessed by staff). For a `customer_scoped` claim — where Inv 2 requires
 * "no owner" ≠ "any owner" → REFUSED — pass `{ requireOwner: true }` so an
 * unowned order is rejected rather than leaked.
 *
 * @throws NonRetryableError if the order doesn't exist, belongs to another
 *   customer, or (when `requireOwner`) has no owner attribution at all.
 */
export async function assertOrderOwnership(
  orderId: string,
  customerId: string,
  opts?: { requireOwner?: boolean },
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
    if (opts?.requireOwner) {
      // Inv 2: a customer_scoped resource with no owner resolves REFUSED
      // ("no owner" ≠ "any owner") — never leak it to the caller.
      throw new NonRetryableError("Acesso negado: este pedido pertence a outro cliente.");
    }
    // Default: allow (legacy/guest order accessed by staff).
    return;
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
