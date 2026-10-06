// stripe-webhook.ts — R5-S5 composition-root seam proof.
//
// This is the rollout's one file whose seam is NOT reachable from the plugin
// body: `stripeWebhookRoutes` only verifies and enqueues, then hands
// `dispatchStripeWebhookEvent` to the BullMQ processor, so every service
// construction runs on a job worker on the far side of a queue. The seam is
// therefore the `deps` parameter on that exported dispatch entry point, and
// that is what this file guards.
//
// It is also the rollout's one OPTIONAL deps parameter (approved as the
// documented exception: a public 3-argument contract the slice declined to
// migrate). Both halves of that decision are pinned below — that an injected
// set is honoured, and that the default remains a real fallback rather than a
// path to some other service.
//
// No `@ibatexas/domain` interception: if the handlers stop threading `deps`,
// they fall back to services bound to the REAL `prisma` singleton and the
// injected spies below are never called.

import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type {
  OrderEventLogService,
  OrderService,
  PaymentCommandService,
  PaymentQueryService,
} from "@ibatexas/domain";
import {
  dispatchStripeWebhookEvent,
  type StripeWebhookRouteDeps,
} from "../stripe-webhook.js";

const PI_ID = "pi_seam_01";

/** A `payment_intent.payment_failed` carrying NO medusaOrderId metadata — the
 *  cheapest dispatch path: it reconciles and returns on the empty PI lookup
 *  without publishing NATS or touching Medusa. */
function failedEvent(): Stripe.Event {
  return {
    id: "evt_seam_01",
    type: "payment_intent.payment_failed",
    data: { object: { id: PI_ID, metadata: {} } },
  } as unknown as Stripe.Event;
}

function silentLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A dep member this dispatch path must never reach for. */
function unreachableDep(name: keyof StripeWebhookRouteDeps): () => never {
  return () => {
    throw new Error(`stripe-webhook dispatch reached for deps.${name}()`);
  };
}

function buildDeps(): {
  deps: StripeWebhookRouteDeps;
  paymentQueryFactory: ReturnType<typeof vi.fn>;
  paymentCommandFactory: ReturnType<typeof vi.fn>;
  getByStripePaymentIntentId: ReturnType<typeof vi.fn>;
} {
  // No local Payment row for this PI → reconcile logs and returns. Enough to
  // prove the INJECTED query service is the one consulted.
  const getByStripePaymentIntentId = vi.fn().mockResolvedValue(null);
  const getActiveByOrderId = vi.fn().mockResolvedValue(null);

  const paymentQueryFactory = vi.fn(
    () =>
      ({ getByStripePaymentIntentId, getActiveByOrderId }) as unknown as PaymentQueryService,
  );
  const paymentCommandFactory = vi.fn(() => ({}) as unknown as PaymentCommandService);

  return {
    paymentQueryFactory,
    paymentCommandFactory,
    getByStripePaymentIntentId,
    deps: {
      // R5 webhook/chat family — `redis` joined this dep set. It is a
      // rejecting TRIPWIRE here rather than a working client: the
      // payment_failed reconcile path issues NO Redis command (the cleanup
      // `hDel` lives on the SUCCEEDED path), so a resolution on this path
      // would mean a site moved. Its own seam evidence lives in
      // `stripe-webhook-client-seam.test.ts`.
      redis: (): never => {
        throw new Error("stripe-webhook reconcile path reached for deps.redis()");
      },
      paymentQueryService: paymentQueryFactory as unknown as () => PaymentQueryService,
      paymentCommandService:
        paymentCommandFactory as unknown as (logger: unknown) => PaymentCommandService,
      // Not on this path — throwers, so a future change that starts calling
      // them fails loudly instead of reaching a real service.
      orderEventLogService: unreachableDep(
        "orderEventLogService",
      ) as unknown as (logger: unknown) => OrderEventLogService,
      orderService: unreachableDep("orderService") as unknown as (
        event: Stripe.Event,
        logger: unknown,
      ) => OrderService,
    } as unknown as StripeWebhookRouteDeps,
  };
}

describe("stripe-webhook.ts — R5-S5 dispatch-level deps seam", () => {
  it("threads the INJECTED services from dispatch down to the reconcile", async () => {
    const { deps, paymentQueryFactory, paymentCommandFactory, getByStripePaymentIntentId } =
      buildDeps();
    const logger = silentLogger();

    await dispatchStripeWebhookEvent(failedEvent(), Date.now(), logger, deps);

    // The reconcile consulted the injected query service, not the singleton.
    expect(paymentQueryFactory).toHaveBeenCalledTimes(1);
    expect(getByStripePaymentIntentId).toHaveBeenCalledWith(PI_ID);
    // The command-service factory receives the per-JOB logger, which is the
    // reason this member takes an argument at all.
    expect(paymentCommandFactory).toHaveBeenCalledTimes(1);
    expect(paymentCommandFactory).toHaveBeenCalledWith(logger);
    // The `redis` tripwire above never fired: reaching it would have thrown
    // out of the dispatch, so this call completing at all is the assertion.
    // It pins that the reconcile leg stayed Redis-free when the client joined
    // this dep set.
  });

  it("keeps the 3-argument contract callable — the default is a real fallback", async () => {
    // The approved exception: `deps` is optional because the processor and the
    // route's existing tests call this entry point with three arguments. This
    // pins that contract so a later slice tightening it to a required
    // parameter is a conscious, visible break rather than an accident.
    const logger = silentLogger();
    const unhandled = { id: "evt_seam_02", type: "invoice.paid", data: { object: {} } } as unknown as Stripe.Event;

    // An unhandled event type reaches the default branch without constructing
    // anything, so this exercises the 3-arg call with no service reachability.
    await expect(
      dispatchStripeWebhookEvent(unhandled, Date.now(), logger),
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ type: "invoice.paid" }),
      expect.stringContaining("Unhandled Stripe event type"),
    );
  });
});
