// get_payment_history tool — list the authenticated customer's payment history.
// READ_ONLY tool: the billing counterpart of get_order_history. Returns every
// payment attempt across the customer's orders (ALL statuses — settled,
// refunded, failed included), owner-scoped, most-recent first.

import {
  GetPaymentHistoryInputSchema,
  NonRetryableError,
  PAYMENT_STATUS_LABELS_PT,
  type AgentContext,
  type GetPaymentHistoryInput,
  type PaymentStatus,
} from "@ibatexas/types";
import { createPaymentQueryService } from "@ibatexas/domain";

interface PaymentHistoryEntry {
  id: string;
  orderId: string;
  method: string;
  status: string;
  statusLabel: string;
  amountInCentavos: number;
  refundedAmountCentavos: number;
  pixExpiresAt: string | null;
  createdAt: string;
}

interface PaymentHistoryResult {
  // `totalCount`/`count` are serialized FIRST on purpose. This result is fed
  // back into the planner's one-hop enrichment loop, where capEnrichmentResults
  // (ibatexas-planner.ts, MAX_READ_RESULT_CHARS=1500) truncates any single
  // result's JSON mid-string. A worst-case projected entry is ~305 chars, so a
  // full PAGE_SIZE page can exceed the cap — putting the totals first guarantees
  // the model always reads the honest "showing K of N" even if the trailing
  // payment detail is truncated, instead of losing the totals (the pre-fix bug
  // that let it read a partial page as the whole history).
  totalCount: number;
  count: number;
  payments: PaymentHistoryEntry[];
}

// Bounded page: the enrichment loop feeds this back to the 4B, so cap the rows
// (recent-first) rather than dumping the whole history. `totalCount` carries the
// honest total so the render stays truthful — "os N mais recentes de M".
const PAGE_SIZE = 6;

export async function getPaymentHistory(
  input: GetPaymentHistoryInput,
  ctx: AgentContext,
): Promise<PaymentHistoryResult> {
  GetPaymentHistoryInputSchema.parse(input);

  // LOAD-BEARING IDOR GUARD (BKL-071). Payment ownership is the parent order's
  // customerId; listByCustomer AND countByCustomer both scope via
  // `where: { order: { customerId } }`. A `customerId: undefined` is a NO-OP
  // filter in Prisma — the join would match EVERY customer's payments and leak
  // the whole table. Refuse BEFORE any query when the session is unauthenticated
  // (Inv 2: "no owner" ≠ "any owner").
  if (!ctx.customerId) {
    throw new NonRetryableError("Autenticação necessária para ver histórico de pagamentos.");
  }

  const querySvc = createPaymentQueryService();
  // Same owner scope on both; run concurrently (one round-trip of latency).
  const [payments, totalCount] = await Promise.all([
    querySvc.listByCustomer(ctx.customerId, { limit: PAGE_SIZE }),
    querySvc.countByCustomer(ctx.customerId),
  ]);

  // Owner-scoped projection. NEVER include stripePaymentIntentId or raw rows —
  // only the customer-facing billing fields (id/orderId enable grouping; the
  // pt-BR statusLabel is the rendered display term).
  const projected: PaymentHistoryEntry[] = payments.map((p) => ({
    id: p.id,
    orderId: p.orderId,
    method: p.method,
    status: p.status,
    statusLabel: PAYMENT_STATUS_LABELS_PT[p.status as PaymentStatus] ?? p.status,
    amountInCentavos: p.amountInCentavos,
    refundedAmountCentavos: p.refundedAmountCentavos,
    pixExpiresAt: p.pixExpiresAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  }));

  return { totalCount, count: projected.length, payments: projected };
}

export const GetPaymentHistoryTool = {
  name: "get_payment_history",
  description:
    "Lista o histórico de pagamentos do cliente — todas as tentativas, pagamentos e reembolsos, do mais recente ao mais antigo. Requer autenticação.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
} as const;
