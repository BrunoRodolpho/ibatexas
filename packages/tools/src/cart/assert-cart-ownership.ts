// Shared cart ownership verification helper.
// Ensures the cart belongs to the current customer or is an unowned (guest) cart.

import { NonRetryableError } from "@ibatexas/types";
import { medusaStoreFetch } from "./_shared.js";

interface MedusaCart {
  id: string;
  customer_id?: string | null;
}

/**
 * Fetches the cart from Medusa and verifies that the cart belongs to the given
 * customerId or is unowned (guest cart). Throws NonRetryableError on mismatch.
 *
 * @param cartId  - The Medusa cart ID to verify
 * @param customerId - The session customer ID (may be undefined for guests)
 * @returns The cart object from Medusa
 */
export async function assertCartOwnership(
  cartId: string,
  customerId: string | undefined,
): Promise<MedusaCart> {
  const data = await medusaStoreFetch(`/store/carts/${cartId}`) as { cart: MedusaCart };
  const cart = data.cart;

  if (!cart) {
    throw new NonRetryableError("Carrinho não encontrado.");
  }

  // Allow access if the cart is unowned (guest cart) or belongs to the current customer
  if (cart.customer_id && cart.customer_id !== customerId) {
    throw new NonRetryableError("Acesso negado: este carrinho pertence a outro cliente.");
  }

  return cart;
}
