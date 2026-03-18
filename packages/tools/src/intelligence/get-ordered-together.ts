// get_ordered_together tool
// "Você costuma pedir junto" — personalized affinity from this customer's order history.
// Queries Prisma CustomerOrderItem: which products appear in the same orders as productId?

import { GetOrderedTogetherInputSchema, type GetOrderedTogetherInput, type AgentContext } from "@ibatexas/types";
import { createCustomerService } from "@ibatexas/domain";
import { queryProductsByIds } from "./query-products-by-ids.js";

export async function getOrderedTogether(
  input: GetOrderedTogetherInput,
  ctx: AgentContext,
): Promise<{
  products: Array<{ id: string; title: string; price: number; imageUrl?: string; orderCount: number }>;
  label: string;
}> {
  const parsed = GetOrderedTogetherInputSchema.parse(input);

  if (!ctx.customerId) {
    // Guest: no personal history
    return { products: [], label: "Você costuma pedir junto" };
  }

  // Find co-purchased products via domain service
  const customerSvc = createCustomerService();
  const coItems = await customerSvc.getOrderedTogether(ctx.customerId, parsed.productId, 5);

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
