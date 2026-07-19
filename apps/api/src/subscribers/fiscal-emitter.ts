// NEW-014 PR2 — the fiscal-emitter subscriber. Listens on `order.status_changed`
// and, when an order reaches `delivered` (the fiscal-eligible terminal state),
// emits the fiscal document (NFC-e) through the governed chokepoint:
//
//   event → pre-checks (terminal-status skip) → SYSTEM envelope →
//   `emitFiscalFromEnvelope` (kernel: `requireFiscalEligibleState` +
//   `fiscalEmitRetryCapGuard` + SYSTEM-only taint) → EXECUTE ⇒ the executor
//   stamps the attempt (fiscal-document.service), calls the provider
//   (`createFiscalProvider` — MockFiscalProvider by default, FISCAL_PROVIDER
//   env-selected), and persists the outcome (provider name on EVERY record).
//
// IDEMPOTENCY (belt-and-suspenders, both order-keyed):
//   - Redis two-phase dedup `fiscal-emit:${orderId}` — a re-delivered
//     `delivered` event never double-emits (fail-CLOSED on Redis errors).
//   - the envelope nonce `fiscal_emit:${orderId}` → deterministic intentHash →
//     the kernel execution ledger dedups across the Redis TTL window too.
//
// TERMINAL RULES (NEW-014 gate): `approved` = done; `rejected` = SEFAZ said no —
// NEVER auto-retried (human review; TERMINAL_FISCAL_STATUSES). `timeout`/`error`
// stay retriable via a FUTURE re-poll trigger, bounded by the pack's
// FISCAL_EMIT_MAX_ATTEMPTS through `ctx.fiscalEmitAttempts` — the order-keyed
// dedup means a redelivered EVENT is not the retry path (documented follow-up).

import type { FastifyBaseLogger } from "fastify";
import { subscribeNatsEvent } from "@ibatexas/nats-client";
import type { OrderStatusChangedEvent } from "@ibatexas/types";
import { TERMINAL_FISCAL_STATUSES } from "@ibatexas/types";
import {
  createOrderCommandService,
  createOrderQueryService,
  createFiscalDocumentService,
  prisma,
  type FiscalDocumentRecord,
} from "@ibatexas/domain";
import {
  createFiscalProvider,
  type FiscalEmitInput,
  type FiscalEmitResult,
} from "@ibatexas/tools";
import type { OrderFiscalEmitPayload } from "@ibatexas/pack-orders";
import { getAuditSink } from "@ibatexas/audit-sink";
import { buildSystemEnvelope } from "./__shared__/system-actor-envelope.js";
import { withDedup } from "./dedup.js";
import { pushToDlq } from "./dlq.js";

/** Map a projection (+ optional customer CPF) onto the provider's emit input. */
function toFiscalEmitInput(
  projection: {
    id: string;
    displayId: number;
    totalInCentavos: number;
    itemsJson: unknown;
  },
  customerTaxId: string | undefined,
): FiscalEmitInput {
  const items = Array.isArray(projection.itemsJson) ? projection.itemsJson : [];
  return {
    orderId: projection.id,
    displayId: projection.displayId,
    totalCentavos: projection.totalInCentavos,
    items: items.map((it) => {
      const item = it as { title?: string; quantity?: number; priceInCentavos?: number };
      return {
        description: item.title ?? "item",
        quantity: item.quantity ?? 1,
        unitPriceCentavos: item.priceInCentavos ?? 0,
      };
    }),
    // "nota com CPF" only when the customer has one on file — PII, redacted in
    // audit (the port doc); omitted entirely for an anonymous note.
    ...(customerTaxId ? { customerTaxId } : {}),
  };
}

export async function startFiscalEmitSubscriber(log?: FastifyBaseLogger): Promise<void> {
  const orderCmdSvc = createOrderCommandService(log ?? undefined, {
    auditSink: getAuditSink(),
  });
  const orderQuerySvc = createOrderQueryService();
  const fiscalSvc = createFiscalDocumentService();
  const provider = createFiscalProvider();

  await subscribeNatsEvent(
    "order.status_changed",
    async (payload) => {
      const event = payload as unknown as OrderStatusChangedEvent;
      // Only the fiscal-eligible terminal state triggers an emission. (The
      // POLICY re-checks this — requireFiscalEligibleState — so a drifted
      // caller can never emit for an undelivered order; this filter is the
      // cheap fast path.)
      if (event.newStatus !== "delivered") return;
      const { orderId } = event;

      const processed = await withDedup(`fiscal-emit:${orderId}`, async () => {
        // TERMINAL pre-check: approved = already emitted; rejected = SEFAZ
        // rejection, NEVER auto-retried (NEW-014 gate — human review only).
        const existing = await fiscalSvc.getByOrderId(orderId);
        if (
          existing !== null &&
          (TERMINAL_FISCAL_STATUSES as readonly string[]).includes(existing.status)
        ) {
          log?.info(
            { orderId, status: existing.status },
            "[fiscal-emitter] terminal fiscal record — skipping (no auto-retry)",
          );
          return;
        }

        const projection = await orderQuerySvc.getById(orderId);
        if (projection === null) {
          log?.warn({ orderId }, "[fiscal-emitter] no projection for delivered order — skipping");
          return;
        }

        const envelope = buildSystemEnvelope<"order.fiscal.emit", OrderFiscalEmitPayload>({
          kind: "order.fiscal.emit",
          payload: { orderId },
          sourceSubject: "order.status_changed",
          // Deterministic per ORDER (not per event) → stable intentHash → the
          // execution ledger dedups replays even across the Redis TTL window.
          eventId: `fiscal_emit:${orderId}`,
        });

        // The pack's OrderState — the fiscal guards read ONLY fulfillmentStatus
        // + fiscalEmitAttempts; auth rides the SYSTEM taint gate (systemOnlyKinds)
        // + SYSTEM_OR_ANON_KINDS, so the base ctx fields are inert here. channel
        // "web" mirrors the ops note branch's stated convention (there is no
        // "system" member on the pack's closed channel union).
        const orderState = {
          ctx: {
            channel: "web" as const,
            customerId: projection.customerId,
            cartId: null,
            orderId,
            totalInCentavos: projection.totalInCentavos,
            fulfillmentStatus: projection.fulfillmentStatus,
            fiscalEmitAttempts: existing?.attempts ?? 0,
          },
        };

        const outcome = await orderCmdSvc.emitFiscalFromEnvelope(
          envelope,
          orderState,
          async (): Promise<FiscalDocumentRecord> => {
            // POST-adjudication executor: stamp the attempt (provider name on
            // the record — NEW-014 gate), call the provider, persist the outcome.
            await fiscalSvc.beginAttempt(orderId, provider.name);
            let result: FiscalEmitResult;
            try {
              result = await provider.emit(
                toFiscalEmitInput(projection, await lookupCpf(projection.customerId)),
              );
            } catch (err) {
              // A thrown provider (e.g. FocusNFe unconfigured) records an honest
              // `error` outcome — never a silent no-op, never a fake approval.
              await fiscalSvc.recordOutcome(orderId, {
                status: "error",
                rejectionReason: (err as Error).message,
              });
              throw err;
            }
            return fiscalSvc.recordOutcome(orderId, {
              status: result.status,
              ...(result.accessKey ? { accessKey: result.accessKey } : {}),
              ...(result.xmlUrl ? { xmlUrl: result.xmlUrl } : {}),
              ...(result.pdfUrl ? { pdfUrl: result.pdfUrl } : {}),
              ...(result.rejectionReason ? { rejectionReason: result.rejectionReason } : {}),
            });
          },
        );

        if (outcome.decision.kind !== "EXECUTE" && outcome.decision.kind !== "REWRITE") {
          const refusalCode =
            outcome.decision.kind === "REFUSE" ? outcome.decision.refusal.code : undefined;
          log?.warn(
            { orderId, decision: outcome.decision.kind, refusalCode },
            "[fiscal-emitter] kernel did not authorize the fiscal emit",
          );
          if (outcome.decision.kind === "REFUSE") {
            await pushToDlq(
              "order.status_changed",
              payload as Record<string, unknown>,
              `fiscal-emit kernel REFUSE: ${refusalCode}`,
              log,
            );
          }
          return;
        }

        log?.info(
          { orderId, status: outcome.result?.status, provider: provider.name },
          "[fiscal-emitter] fiscal emission recorded",
        );
      });

      if (!processed) {
        log?.info({ orderId }, "[fiscal-emitter] duplicate delivered event — skipping");
      }
    },
    { queueGroup: "fiscal-emitter" },
  );

  log?.info("[fiscal-emitter] subscribed to order.status_changed (delivered → NFC-e)");
}

/** CPF lookup for a "nota com CPF" — the projection does not carry it (survey
 *  §6); Customer.cpf, PII — omitted for an anonymous note. Read-only prisma use
 *  in apps/api follows the audit-consumer/retention-cleaner precedent. */
async function lookupCpf(customerId: string | null): Promise<string | undefined> {
  if (customerId === null) return undefined;
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { cpf: true },
  });
  return customer?.cpf ?? undefined;
}
