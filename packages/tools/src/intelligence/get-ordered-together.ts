// get_ordered_together tool
// "Você costuma pedir junto" — personalized affinity from this customer's order history.
// Queries Prisma CustomerOrderItem: which products appear in the same orders as productId?

import type { AgentContext } from "@ibatexas/types";
import { prisma } from "@ibatexas/domain";
import { queryProductsByIds } from "./query-products-by-ids.js";

export async function getOrderedTogether(
  input: { productId: string },
  ctx: AgentContext,
): Promise<{
  products: Array<{ id: string; title: string; price: number; imageUrl?: string; orderCount: number }>;
  label: string;
}> {
  if (!ctx.customerId) {
    // Guest: no personal history
    return { products: [], label: "Você costuma pedir junto" };
  }

  // Find orders that contain this product
  const ordersWithProduct = await prisma.customerOrderItem.findMany({
    where: { customerId: ctx.customerId, productId: input.productId },
    select: { medusaOrderId: true },
    distinct: ["medusaOrderId"],
  });

  if (ordersWithProduct.length === 0) {
    return { products: [], label: "Você costuma pedir junto" };
  }

  const orderIds = ordersWithProduct.map((o) => o.medusaOrderId);

  // Find other products in those same orders, ranked by frequency
  const coItems = await prisma.customerOrderItem.groupBy({
    by: ["productId"],
    where: {
      customerId: ctx.customerId,
      medusaOrderId: { in: orderIds },
      productId: { not: input.productId },
    },
    _count: { productId: true },
    orderBy: { _count: { productId: "desc" } },
    take: 5,
  });

  if (coItems.length === 0) {
    return { products: [], label: "Você costuma pedir junto" };
  }

  const productIds = coItems.map((i) => i.productId);
  const summaries = await queryProductsByIds(productIds, 5);

  const countMap = new Map(coItems.map((i) => [i.productId, i._count.productId]));
  const products = summaries.map((p) => ({
    ...p,
    orderCount: countMap.get(p.id) ?? 1,
  }));

  return { products, label: "Você costuma pedir junto" };
}

export const GetOrderedTogetherTool = {
  name: "get_ordered_together",
  description:
    "Retorna produtos que este cliente específico costuma pedir junto com o produto informado, baseado no histórico de pedidos. Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {
      productId: { type: "string", description: "ID do produto principal" },
    },
    required: ["productId"],
  },
} as const;
