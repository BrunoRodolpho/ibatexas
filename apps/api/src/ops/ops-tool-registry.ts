// ops-tool-registry.ts — the OPS-plane tool registry (NEW-032 slice B).
//
// A SEPARATE @claustrum/core ToolRegistry from the chat one (register-ibatexas-
// tool-packs.ts) so the chat roster/drift gates are untouched. It holds the
// governed OPS MUTATING verbs the conductor dispatches on a kernel EXECUTE —
// `capability === intentKind` for each, so `dispatchDecision` resolves the tool
// by `envelope.kind`:
//
//   - product.availability.set → the SAME `medusaAdjudicated` PATCH the admin
//     products route uses (`metadata.inStock` ← payload.available). The egress
//     wrapper is a DISTINCT governance layer by design (D10) — NOT a second
//     intent adjudication of the ops verb. riskLevel "medium".
//   - product.price.set → the SAME `medusaAdjudicated` admin egress
//     (`medusa.admin.product.update`), re-reading the product's BRL-priced
//     variant ids and setting each to the confirmed price (payload centavos →
//     Medusa reais) in ONE call. The composed router already CONFIRM-gated the
//     UNTRUSTED price at SUBMIT; this executor performs NO adjudication (D10).
//     riskLevel "medium". NEW-004.
//   - order.note.add → `orderCmdSvc.writeAdjudicatedNote` (the POST-adjudication
//     write; the composed-router Decision was already produced by the conductor
//     SUBMIT stage — this executor performs NO adjudication). Staff notes are
//     internal by default. riskLevel "low".
//   - order.status.transition → `orderCmdSvc.writeAdjudicatedStatusTransition`
//     (BKL-090 kitchen-advance; the POST-adjudication write). The composed router
//     already ran the BKL-090 legality guard + staffRoleGuard at SUBMIT; this
//     executor performs NO adjudication and forces actor=admin + Capsule staffId.
//     After the committed write it emits `order.status_changed` (the SAME event
//     the admin advance route publishes) so the cart-intelligence subscriber runs
//     the event-log/reconcile/customer-notify side effects. riskLevel "medium".
//   - payment.refund.issue → `paymentCmdSvc.writeAdjudicatedRefund` (BKL-085
//     refunds-by-message; the POST-adjudication ledger write). The composed router
//     already ran the refund magnitude ladder + the BKL-085 UNTRUSTED-taint
//     CONFIRM overlay + staffRoleGuard {OWNER,MANAGER} at SUBMIT (a REQUEST_CONFIRMATION
//     parks and resumes via the ops matchToParked driver); this executor performs
//     NO adjudication and forces actor=admin + Capsule staffId. The refund WRITE is
//     ledger-only (no Stripe/PIX egress in-repo); after the committed write it emits
//     `payment.status_changed` (the SAME event the admin refund route publishes —
//     drives auto-cancel-on-full-refund) + an `ops.refund.executed` audit event.
//     riskLevel "high".
//   - ops.alert.resolve.staff → `opsAlertSvc.resolveAlertFromEnvelope` (BKL-088;
//     the D10 SECOND governed layer). The executor BUILDS a SYSTEM
//     `ops.alert.resolve` envelope (staff identity on the payload: `resolvedBy:
//     "staff:<id>"`, `resolutionType: STAFF`, FORCED from the Capsule) and calls
//     the SAME service the admin ops-alerts resolve route calls (which
//     adjudicates + audits that SYSTEM kind internally). No route-layer NATS/
//     event-log side effect exists to reproduce. riskLevel "low".
//   - incident.ticket.close.staff → `incidentSvc.closeIncidentFromEnvelope`
//     (BKL-088; same D10 posture over the SYSTEM `incident.ticket.close` kind,
//     the admin incidents resolve route's path). riskLevel "low".
//   - schedule.override.set → `scheduleSvc.upsertOverride` (SCN-127; the SAME
//     domain-service call the admin schedule override route uses — NO Medusa
//     egress, NO second adjudication). The resolver already stamped a concrete
//     ISO date; after the committed write it invalidates the Redis schedule cache
//     (exactly like the admin route) so the customer-facing hours/closed-notice
//     reads pick the override up immediately. riskLevel "low" (reversible).
//
// `staffId` (audit sourceSubject / note authorId) is read from the per-turn
// `Capsule.actor.staffId` — the AUTHORITATIVE identity the ops route stamps from
// the JWT at `openCapsule`, NEVER from the model-parsed payload. The registry is
// built ONCE at boot and reused per request (the Capsule is the per-request
// context); the injected side-effect deps make it unit-testable with spies.

import { randomUUID } from "node:crypto";
import type { IntentEnvelope } from "@adjudicate/core";
import {
  createToolRegistry,
  type CapabilityId,
  type IntentKind,
  type ToolDefinition,
  type ToolRegistry,
} from "@claustrum/core";
import type { AuditSink } from "@ibatexas/audit-sink";
import type { MedusaAdjudicatedArgs } from "@ibatexas/tools";
import type {
  AddNoteResult,
  IncidentClosePayload,
  IncidentState,
  OpsAlertResolvePayload,
  OpsAlertState,
  PaymentRefundIssuePayload,
} from "@ibatexas/domain";
import type {
  OrderNoteAddPayload,
  OrderStatusTransitionPayload,
} from "@ibatexas/pack-orders";
import type {
  IncidentCloseStaffPayload,
  MenuSpecialSetPayload,
  OpsAlertResolveStaffPayload,
  ProductAvailabilitySetPayload,
  ProductPriceSetPayload,
  ScheduleOverrideSetPayload,
} from "@ibatexas/pack-ops";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";
import type {
  OrderFulfillmentStatus,
  OrderStatusChangedEvent,
  PaymentStatusChangedEvent,
  TimeBlock,
} from "@ibatexas/types";

/** The injected `medusaAdjudicated` shape (typeof `@ibatexas/tools`'s export). */
export type MedusaAdjudicatedFn = <P, R = unknown>(
  args: MedusaAdjudicatedArgs<P>,
) => Promise<R>;

/** Author attribution for a note write — structural mirror of the domain
 *  `NoteAuthorExtras` (not re-exported from @ibatexas/domain). */
export interface OpsNoteAuthorExtras {
  readonly author: "customer" | "staff" | "system" | "llm";
  readonly authorId?: string;
}

/** The single note-write method the ops registry needs (structural subset of
 *  `OrderCommandService`). */
export interface OpsNoteWriter {
  writeAdjudicatedNote(
    payload: OrderNoteAddPayload,
    extras: OpsNoteAuthorExtras,
  ): Promise<AddNoteResult>;
}

/** Authoritative provenance for a status-transition write — structural mirror
 *  of the domain `StatusTransitionAttribution` (not re-exported here). On the
 *  ops plane the executor stamps `actor: "admin"` + the Capsule staffId. */
export interface OpsStatusTransitionAttribution {
  readonly actor: "admin" | "system" | "customer";
  readonly actorId?: string;
  readonly reason?: string;
}

/** The result of a committed status-transition write (structural mirror of the
 *  domain `StatusTransitionResult`). Carries `displayId`/`customerId` from the
 *  projection row so the ops emit path never trusts the model for them. */
export interface OpsStatusTransitionResult {
  readonly version: number;
  readonly previousStatus: string;
  readonly newStatus: string;
  readonly displayId: number;
  readonly customerId: string | null;
}

/** The single status-transition-write method the ops registry needs (structural
 *  subset of `OrderCommandService.writeAdjudicatedStatusTransition`, BKL-090). */
export interface OpsStatusWriter {
  writeAdjudicatedStatusTransition(
    payload: { orderId: string; newStatus: string; expectedVersion?: number },
    extras: OpsStatusTransitionAttribution,
  ): Promise<OpsStatusTransitionResult>;
}

/** The committed refund write result (structural mirror of
 *  `PaymentCommandService.writeAdjudicatedRefund`, BKL-085). `orderId`/`method`
 *  are read from the DB row inside the tx so the ops emit path never trusts the
 *  model for them. */
export interface OpsRefundResult {
  readonly version: number;
  readonly previousStatus: string;
  readonly newStatus: string;
  readonly totalRefundedCentavos: number;
  readonly refundAmountCentavos: number;
  readonly orderId: string;
  readonly method: string;
}

/** The single refund-write method the ops registry needs (structural subset of
 *  `PaymentCommandService.writeAdjudicatedRefund`, BKL-085). The caller MUST hold
 *  a positive composed-router Decision; this performs NO adjudication. */
export interface OpsRefundWriter {
  writeAdjudicatedRefund(
    payload: PaymentRefundIssuePayload,
  ): Promise<OpsRefundResult>;
}

/** A best-effort refund audit-event append (structural subset of the order
 *  event-log service). Mirrors the admin route's `admin.refund.executed` row so
 *  an ops-plane refund leaves the same audit trail; a failure never fails the
 *  turn (the ledger write already committed). */
export interface OpsRefundEventLogEntry {
  readonly orderId: string;
  readonly eventType: string;
  readonly discriminator: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: Date;
}

/**
 * BKL-088 — the SYSTEM-write layer the `ops.alert.resolve.staff` executor
 * drives (the D10 second governed layer). Structural subset of `OpsAlertService`
 * — the SAME method the admin ops-alerts resolve route calls. It adjudicates a
 * SYSTEM `ops.alert.resolve` envelope internally (`withAdjudicate`), so the
 * executor performs NO adjudication of the SYSTEM kind itself; it only BUILDS
 * the SYSTEM envelope (staff identity on the payload) and calls this.
 */
export interface OpsAlertResolveWriter {
  resolveAlertFromEnvelope(
    envelope: IntentEnvelope<"ops.alert.resolve", OpsAlertResolvePayload>,
    state: OpsAlertState,
  ): Promise<{ readonly result?: { readonly status: string } | null }>;
}

/**
 * BKL-088 — the SYSTEM-write layer the `incident.ticket.close.staff` executor
 * drives. Structural subset of `IncidentService.closeIncidentFromEnvelope` (the
 * SAME method the admin incidents resolve route calls).
 */
export interface IncidentCloseWriter {
  closeIncidentFromEnvelope(
    envelope: IntentEnvelope<"incident.ticket.close", IncidentClosePayload>,
    state: IncidentState,
  ): Promise<{ readonly result?: { readonly status: string } | null }>;
}

/**
 * SCN-127 — the single schedule-override write method the ops registry needs
 * (structural subset of `ScheduleService.upsertOverride`, `@ibatexas/domain`).
 * The `schedule.override.set` executor calls the SAME method the admin schedule
 * override route (PUT /api/admin/schedule/overrides/:date) uses — a domain-service
 * verb, NO Medusa egress. The caller MUST hold a positive composed-router
 * Decision; this performs NO adjudication.
 */
export interface OpsScheduleOverrideWriter {
  upsertOverride(
    date: string,
    data: { isOpen: boolean; blocks: TimeBlock[]; note?: string | null },
  ): Promise<{ readonly date: string; readonly isOpen: boolean }>;
}

/**
 * SCN-114 — the structural subset of `DailySpecialService` the `menu.special.set`
 * executor drives. `list` finds an existing row for the (product, business-day)
 * so the upsert can UPDATE rather than hit the `@@unique([medusaProductId,date])`
 * on a re-run; `create`/`update` write the row. This is the SAME domain service
 * the NEW-005 admin route (`routes/admin/specials.ts`) uses — NO Medusa egress
 * (BKL-088 domain-service pattern). The composed router already produced the
 * Decision at SUBMIT; this performs NO adjudication.
 */
export interface OpsDailySpecialWriter {
  list(params: {
    date?: string;
    activeOnly?: boolean;
  }): Promise<ReadonlyArray<{ id: string; medusaProductId: string }>>;
  create(input: {
    medusaProductId: string;
    date: string;
    promoPriceCentavos?: number | null;
  }): Promise<{ id: string }>;
  update(
    id: string,
    patch: { promoPriceCentavos?: number | null; active?: boolean },
  ): Promise<{ id: string } | null>;
}

export interface OpsToolRegistryDeps {
  /** `medusaAdjudicated` (injected for testability). */
  readonly medusaAdjudicated: MedusaAdjudicatedFn;
  /** Audit sink threaded into the egress call (getAuditSink() at boot). */
  readonly auditSink: AuditSink;
  /**
   * NEW-004 — read the variant ids that currently carry a BRL price for a
   * product, so the `product.price.set` executor knows which variants to
   * re-price (prices live per-variant in Medusa v2). The composed router already
   * REFUSEd a missing / per-variation product at SUBMIT (the resolver's
   * pricing snapshot), so at EXECUTE the product is a uniform-price one; the
   * executor sets EVERY BRL-priced variant to the confirmed price (the confirmed
   * intent is "this product now costs X"). Returns null / empty for a product
   * with no BRL-priced variant (the executor throws — a should-never-happen
   * post-adjudication). Injected for testability; bootstrap wires it to a
   * medusaAdmin catalog read.
   */
  readonly readProductBrlVariantIds: (
    productId: string,
  ) => Promise<readonly string[] | null>;
  /** The order command service's POST-adjudication writers (note + transition). */
  readonly orderCmdSvc: OpsNoteWriter & OpsStatusWriter;
  /** SCN-114 — the daily-special upsert service (the SAME service the NEW-005
   *  admin route uses). The `menu.special.set` executor upserts through it. */
  readonly dailySpecialSvc: OpsDailySpecialWriter;
  /** BKL-085 — the payment command service's POST-adjudication refund writer. */
  readonly paymentCmdSvc: OpsRefundWriter;
  /**
   * BKL-088 — the ops-alert resolve SYSTEM-write layer (the SAME service the
   * admin ops-alerts resolve route calls). Bootstrap wires it to
   * `createOpsAlertService({ auditSink })` so the SYSTEM adjudication is audited.
   */
  readonly opsAlertSvc: OpsAlertResolveWriter;
  /**
   * BKL-088 — the incident close SYSTEM-write layer (the SAME service the admin
   * incidents resolve route calls). Bootstrap wires it to
   * `createIncidentService({ auditSink })`.
   */
  readonly incidentSvc: IncidentCloseWriter;
  /**
   * SCN-127 — the schedule-override write layer (the SAME service the admin
   * schedule override route calls). Bootstrap wires it to
   * `createScheduleService()`. The executor performs NO adjudication (the
   * composed router already produced the Decision at SUBMIT).
   */
  readonly scheduleSvc: OpsScheduleOverrideWriter;
  /**
   * SCN-127 — invalidate the Redis schedule cache after a committed override
   * write, EXACTLY like the admin schedule route (invalidateScheduleOrWarn). The
   * customer-facing hours/closed-notice reads go through the read-through cache
   * (`loadSchedule`, TTL SCHEDULE_CACHE_TTL_SECONDS default 300s), so without this
   * an override could take up to the TTL to propagate. Returns `{ ok }` — `false`
   * when the DEL was swallowed (circuit-open) even after a retry, so the executor
   * can WARN that propagation may lag up to the TTL. Never throws (a failed
   * invalidation must not fail the write — the TTL bounds staleness). Bootstrap
   * wires it to `@ibatexas/tools`' `invalidateScheduleCache`.
   */
  readonly invalidateScheduleCache: () => Promise<{ readonly ok: boolean }>;
  /**
   * BKL-085 — publish `payment.status_changed` after a committed refund write,
   * exactly like the admin refund route (payments.ts:523-532). Its subscriber
   * (payment-lifecycle.ts) auto-cancels the order on a FULL refund; omitting it
   * would make an ops-plane refund skip that downstream side effect an identical
   * admin-HTTP refund triggers. The refund write is ledger-only (no Stripe/PIX
   * egress in this path), so this event IS the full downstream chain. Injected
   * for testability; bootstrap wires it to `publishNatsEvent`.
   */
  readonly publishPaymentStatusChanged: (
    event: PaymentStatusChangedEvent,
  ) => Promise<void>;
  /** BKL-085 — best-effort refund audit-event append (parity with the admin
   *  route's `admin.refund.executed` row). Bootstrap wires it to the order
   *  event-log service; a failure is swallowed (the write already committed). */
  readonly appendRefundEventLog: (
    entry: OpsRefundEventLogEntry,
  ) => Promise<void>;
  /**
   * Publish `order.status_changed` after a committed kitchen-advance write —
   * the SAME NATS event the admin advance route emits (order-actions.ts:570 /
   * admin/orders.ts:300). Its subscriber (cart-intelligence.ts) appends the
   * event log, reconciles the projection, and sends the CUSTOMER notification;
   * omitting it would make an ops-plane advance skip the customer-facing side
   * effects an identical admin-HTTP advance triggers. Injected for testability;
   * bootstrap wires it to `publishNatsEvent("order.status_changed", …)`.
   */
  readonly publishOrderStatusChanged: (
    event: OrderStatusChangedEvent,
  ) => Promise<void>;
  /** Best-effort logger forwarded to the egress wrapper. */
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void;
    readonly error?: (...args: unknown[]) => void;
  };
}

function asCapability(s: string): CapabilityId {
  return s as CapabilityId;
}
function asIntentKind(s: string): IntentKind {
  return s as IntentKind;
}

/**
 * The AUTHORITATIVE staff id for this turn, read from the Capsule actor the ops
 * route stamped from the JWT at `openCapsule` (`{ ..., staffId }`). Returns
 * `null` when absent (never the model payload) so callers fail-safe rather than
 * fabricate an author.
 */
export function staffIdFromCapsule(ctx: unknown): string | null {
  const actor = (ctx as { actor?: { staffId?: unknown } } | null)?.actor;
  const staffId = actor?.staffId;
  return typeof staffId === "string" && staffId.length > 0 ? staffId : null;
}

/**
 * Executor for `product.availability.set` — mirrors the admin products PATCH
 * route egress EXACTLY: a `medusaAdjudicated` admin POST that updates
 * `metadata.inStock` from `payload.available` (does NOT touch status/published).
 * The egress wrapper (SYSTEM-tainted `medusa.admin.product.update`) is a
 * separate governance layer (D10) — the ops verb was already adjudicated by the
 * composed router before this runs.
 */
async function executeAvailability(
  deps: OpsToolRegistryDeps,
  payload: ProductAvailabilitySetPayload,
  staffId: string | null,
): Promise<{ productId: string; available: boolean }> {
  // Same body shape a client PATCH sends (products.ts:142-152): metadata only.
  const body = { metadata: { inStock: payload.available } };
  await deps.medusaAdjudicated<typeof body, Record<string, unknown>>({
    scope: "admin",
    method: "POST",
    path: `/admin/products/${payload.productId}`,
    payload: body,
    intentKind: "medusa.admin.product.update",
    idempotencyKey: randomUUID(),
    sourceSubject: `ops:product.availability.set:admin:${staffId ?? "unknown"}`,
    auditSink: deps.auditSink,
    ...(deps.log ? { log: deps.log } : {}),
  });
  return { productId: payload.productId, available: payload.available };
}

/**
 * Executor for `product.price.set` (NEW-004) — re-prices a product via the SAME
 * `medusaAdjudicated` admin egress the availability verb uses. Prices live
 * PER-VARIANT in Medusa v2, so the executor re-reads the product's BRL-priced
 * variant ids (`readProductBrlVariantIds`) and sets EVERY one to the confirmed
 * price in ONE admin call (`medusa.admin.product.update` — the update endpoint
 * accepts a `variants[].prices[]` array; verified against the installed v2.13.5
 * validator). Hard Rule #2: the payload carries INTEGER centavos; Medusa v2
 * stores amounts in REAIS, so the egress converts `priceCentavos / 100` (mirrors
 * the seed's `amount / 100` + the admin read's `amount * 100`).
 *
 * The composed router already produced the Decision at SUBMIT (carrying
 * `adminSessionOnlyGuard` + `staffRoleGuard` {OWNER,MANAGER} + the payload /
 * existence / uniform-variant / sanity guards + the UNTRUSTED-taint CONFIRM
 * overlay — a REQUEST_CONFIRMATION parks and resumes via the ops matchToParked
 * driver); this executor performs NO adjudication of the ops verb. The egress
 * wrapper (SYSTEM-tainted `medusa.admin.product.update`) is a separate
 * governance layer (D10). No route-layer side effect exists to reproduce — the
 * admin products PATCH route only touches status/metadata; a price edit has no
 * NATS/event-log emission today (verified).
 */
async function executePriceSet(
  deps: OpsToolRegistryDeps,
  payload: ProductPriceSetPayload,
  staffId: string | null,
): Promise<{
  productId: string;
  priceCentavos: number;
  variantsUpdated: number;
}> {
  const brlVariantIds = await deps.readProductBrlVariantIds(payload.productId);
  if (brlVariantIds === null || brlVariantIds.length === 0) {
    // Should never occur post-adjudication (the resolver REFUSEs a product with
    // no BRL-priced variant). Fail LOUD rather than send an empty (no-op) update.
    throw new Error(
      `[ops] product.price.set: no BRL-priced variant for product ${payload.productId}`,
    );
  }
  // Hard Rule #2: payload is integer centavos; Medusa v2 stores reais.
  const amountReais = payload.priceCentavos / 100;
  const body = {
    variants: brlVariantIds.map((id) => ({
      id,
      prices: [{ currency_code: "brl", amount: amountReais }],
    })),
  };
  await deps.medusaAdjudicated<typeof body, Record<string, unknown>>({
    scope: "admin",
    method: "POST",
    path: `/admin/products/${payload.productId}`,
    payload: body,
    intentKind: "medusa.admin.product.update",
    idempotencyKey: randomUUID(),
    sourceSubject: `ops:product.price.set:admin:${staffId ?? "unknown"}`,
    auditSink: deps.auditSink,
    ...(deps.log ? { log: deps.log } : {}),
  });
  return {
    productId: payload.productId,
    priceCentavos: payload.priceCentavos,
    variantsUpdated: brlVariantIds.length,
  };
}

/**
 * Executor for `menu.special.set` (SCN-114) — the POST-adjudication UPSERT of a
 * DailySpecial via the domain service (NO Medusa egress — the same service the
 * NEW-005 admin route uses). The composed router already produced the Decision at
 * SUBMIT (carrying `adminSessionOnlyGuard` + `staffRoleGuard` {OWNER,MANAGER} +
 * the payload / not-past / existence guards + the UNTRUSTED-taint CONFIRM overlay
 * — a REQUEST_CONFIRMATION parks and resumes via the ops matchToParked driver);
 * this executor performs NO adjudication.
 *
 * Upsert keyed on the DB `@@unique([medusaProductId, date])`: it LISTS the day's
 * specials (all, not active-only, so a paused row is found rather than colliding
 * on create) and, if the product already has a row for that day, UPDATEs it
 * (`active: true` re-affirms a paused one) — otherwise CREATEs a fresh one. An
 * OMITTED `promoPriceCentavos` is left untouched on update (never silently
 * cleared) and defaults to NULL (featured without a discount) on create.
 */
async function executeMenuSpecialSet(
  deps: OpsToolRegistryDeps,
  payload: MenuSpecialSetPayload,
): Promise<{
  specialId: string;
  productId: string;
  date: string;
  created: boolean;
}> {
  const promoFields =
    payload.promoPriceCentavos !== undefined
      ? { promoPriceCentavos: payload.promoPriceCentavos }
      : {};
  const daySpecials = await deps.dailySpecialSvc.list({ date: payload.date });
  const existing =
    daySpecials.find((s) => s.medusaProductId === payload.productId) ?? null;

  if (existing) {
    await deps.dailySpecialSvc.update(existing.id, {
      ...promoFields,
      active: true,
    });
    return {
      specialId: existing.id,
      productId: payload.productId,
      date: payload.date,
      created: false,
    };
  }
  const created = await deps.dailySpecialSvc.create({
    medusaProductId: payload.productId,
    date: payload.date,
    ...promoFields,
  });
  return {
    specialId: created.id,
    productId: payload.productId,
    date: payload.date,
    created: true,
  };
}

/**
 * Executor for `order.note.add` — the POST-adjudication write via
 * `writeAdjudicatedNote`. Staff notes are INTERNAL by default: `isInternal` is
 * defaulted true on the PAYLOAD passed to the writer (the envelope is untouched)
 * when the model omitted it. `authorId` is the closure/Capsule staffId, never a
 * model field.
 */
async function executeNote(
  deps: OpsToolRegistryDeps,
  payload: OrderNoteAddPayload,
  staffId: string | null,
): Promise<AddNoteResult> {
  const notePayload: OrderNoteAddPayload = {
    ...payload,
    // Staff notes default to internal; set on the payload, not the envelope.
    isInternal: payload.isInternal ?? true,
  };
  return deps.orderCmdSvc.writeAdjudicatedNote(notePayload, {
    author: "staff",
    ...(staffId ? { authorId: staffId } : {}),
  });
}

/**
 * Executor for `order.status.transition` (BKL-090 kitchen-advance) — the
 * POST-adjudication write via `writeAdjudicatedStatusTransition`. The composed
 * router already produced the Decision (carrying the BKL-090 legality guard +
 * `staffRoleGuard`) at the conductor SUBMIT stage; this executor performs NO
 * adjudication. `actor` is forced to `"admin"` and `actorId` is the Capsule
 * staffId — NEVER the model-parsed `payload.actor`/`payload.actorId`. The model
 * payload's `expectedVersion` is deliberately NOT forwarded (a kitchen-advance
 * is a fresh operator command, not a version-snapshotted two-step confirm); the
 * executor's `canTransition` re-read throw remains the last transactional line.
 */
async function executeStatusTransition(
  deps: OpsToolRegistryDeps,
  payload: OrderStatusTransitionPayload,
  staffId: string | null,
): Promise<OpsStatusTransitionResult> {
  const result = await deps.orderCmdSvc.writeAdjudicatedStatusTransition(
    { orderId: payload.orderId, newStatus: payload.newStatus },
    {
      actor: "admin",
      ...(staffId ? { actorId: staffId } : {}),
      reason: "Status avançado pela operação (ops).",
    },
  );

  // Emit order.status_changed ONLY after the committed write — mirrors the admin
  // advance route so an ops-plane advance triggers the SAME downstream effects
  // (event log + projection reconcile + customer notification via the
  // cart-intelligence subscriber). displayId/customerId come from the projection
  // row the write read, NEVER the model payload. Best-effort: a publish failure
  // is logged (the transition already committed — it must not undo it or fail the
  // turn), the same posture as admin/orders.ts's fire-and-forget publish.
  try {
    await deps.publishOrderStatusChanged({
      orderId: payload.orderId,
      displayId: result.displayId,
      previousStatus: result.previousStatus as OrderFulfillmentStatus,
      newStatus: result.newStatus as OrderFulfillmentStatus,
      customerId: result.customerId,
      updatedBy: "admin",
      version: result.version,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    deps.log?.error?.(
      "[ops] order.status_changed publish failed after committed transition:",
      (err as Error).message ?? String(err),
    );
  }

  return result;
}

/**
 * Executor for `payment.refund.issue` (BKL-085 refunds-by-message) — the
 * POST-adjudication ledger write via `writeAdjudicatedRefund` PLUS the FULL
 * side-effect chain an admin-HTTP refund produces. The composed router already
 * produced the Decision (carrying `staffRoleGuard` + the matrix + the BKL-085
 * UNTRUSTED-taint CONFIRM overlay) at the conductor SUBMIT stage; this executor
 * performs NO adjudication.
 *
 * Identity is forced from the Capsule (`actor: "admin"` + Capsule staffId) —
 * NEVER the model-parsed `payload.actor`/`payload.actorId`. The balance fields in
 * the payload were already STAMPED from the DB row by the ops resolver
 * (STOP-GATE B); the write additionally re-derives balance from the LIVE DB row
 * inside its tx (the last transactional line).
 *
 * The refund WRITE is ledger-only (no Stripe/PIX egress — verified: the only
 * Stripe refund code is the inbound `charge.refunded` webhook reconcile). The
 * full chain = write + `payment.status_changed` (drives the auto-cancel-on-full-
 * refund lifecycle subscriber) + the `ops.refund.executed` audit event. The
 * emissions are best-effort AFTER the committed write (a publish failure must
 * not undo or fail the committed refund — same posture as the admin route +
 * the ops kitchen-advance).
 */
export async function executeRefund(
  deps: OpsToolRegistryDeps,
  payload: PaymentRefundIssuePayload,
  staffId: string | null,
): Promise<{
  paymentId: string;
  refundAmountCentavos: number;
  newStatus: string;
  version: number;
}> {
  // Force identity from the Capsule, never the payload (defense in depth — the
  // ops resolver already stamped these from the authenticated staffId).
  const writePayload: PaymentRefundIssuePayload = {
    ...payload,
    actor: "admin",
    ...(staffId ? { actorId: staffId } : {}),
  };
  const result = await deps.paymentCmdSvc.writeAdjudicatedRefund(writePayload);

  // 1) payment.status_changed — the SAME event the admin refund route publishes
  //    (drives payment-lifecycle.ts's auto-cancel on a full refund). orderId +
  //    method come from the committed DB row, never the model payload.
  try {
    await deps.publishPaymentStatusChanged({
      orderId: result.orderId,
      paymentId: writePayload.paymentId,
      previousStatus: result.previousStatus,
      newStatus: result.newStatus,
      method: result.method,
      version: result.version,
      timestamp: new Date().toISOString(),
    } as PaymentStatusChangedEvent);
  } catch (err) {
    deps.log?.error?.(
      "[ops] payment.status_changed publish failed after committed refund:",
      (err as Error).message ?? String(err),
    );
  }

  // 2) ops.refund.executed audit event — parity with admin.refund.executed.
  try {
    await deps.appendRefundEventLog({
      orderId: result.orderId,
      eventType: "ops.refund.executed",
      discriminator: `ops:${writePayload.paymentId}:${result.version}`,
      payload: {
        staffId,
        paymentId: writePayload.paymentId,
        refundAmountCentavos: result.refundAmountCentavos,
        totalRefunded: result.totalRefundedCentavos,
        newStatus: result.newStatus,
        version: result.version,
      },
      timestamp: new Date(),
    });
  } catch (err) {
    deps.log?.warn?.(
      "[ops] ops.refund.executed audit append failed after committed refund:",
      (err as Error).message ?? String(err),
    );
  }

  return {
    paymentId: writePayload.paymentId,
    refundAmountCentavos: result.refundAmountCentavos,
    newStatus: result.newStatus,
    version: result.version,
  };
}

/**
 * BKL-088 — the staff identity token stamped onto the SYSTEM-write payload's
 * `resolvedBy`, derived from the Capsule staffId (NEVER the model). Mirrors the
 * admin routes' `staff:${staffId}` idiom; a null staffId (should not occur on
 * the JWT-authenticated ops plane) degrades to a traceable non-staff marker.
 */
function opsResolvedBy(staffId: string | null): string {
  return staffId ? `staff:${staffId}` : "ops:unknown";
}

/**
 * Executor for `ops.alert.resolve.staff` (BKL-088) — the D10 SECOND governed
 * layer. The composed router already produced the STAFF-verb Decision (carrying
 * `adminSessionOnlyGuard` + `staffRoleGuard` {OWNER,MANAGER} + the actionability
 * guard) at the conductor SUBMIT stage; this executor performs NO adjudication
 * of the staff kind. It BUILDS a SYSTEM `ops.alert.resolve` envelope — staff
 * identity on the payload (`resolvedBy: "staff:<id>"`, `resolutionType: STAFF`,
 * FORCED, never the model) — and calls `resolveAlertFromEnvelope`, EXACTLY the
 * admin ops-alerts resolve route's path (which adjudicates that SYSTEM kind
 * internally + audits it). The admin resolve route emits no NATS/event-log side
 * effect, so there is none to reproduce (verified). The model-supplied `reason`
 * (an operator note) rides the audited STAFF-verb envelope only; the SYSTEM
 * `OpsAlertResolvePayload` has no reason slot to persist.
 */
async function executeAlertResolveStaff(
  deps: OpsToolRegistryDeps,
  payload: OpsAlertResolveStaffPayload,
  staffId: string | null,
): Promise<{ alertId: string; status: string | null }> {
  const systemPayload: OpsAlertResolvePayload = {
    id: payload.alertId,
    resolvedBy: opsResolvedBy(staffId),
    resolutionType: "STAFF",
  };
  const envelope = buildSystemEnvelope({
    kind: "ops.alert.resolve" as const,
    payload: systemPayload,
    sourceSubject: "ops.alert.ops_staff_resolve",
    eventId: `${payload.alertId}:resolve:${Date.now()}`,
  });
  const out = await deps.opsAlertSvc.resolveAlertFromEnvelope(envelope, {});
  return { alertId: payload.alertId, status: out.result?.status ?? null };
}

/**
 * Executor for `incident.ticket.close.staff` (BKL-088) — the D10 SECOND
 * governed layer. Same posture as {@link executeAlertResolveStaff}: builds a
 * SYSTEM `incident.ticket.close` envelope with FORCED `resolvedBy` +
 * `resolutionType: STAFF` (never AUTO/HANDED_OFF — those are system-driven) and
 * calls `closeIncidentFromEnvelope`, exactly the admin incidents resolve route's
 * path (no NATS/event-log side effect to reproduce).
 */
async function executeIncidentCloseStaff(
  deps: OpsToolRegistryDeps,
  payload: IncidentCloseStaffPayload,
  staffId: string | null,
): Promise<{ incidentId: string; status: string | null }> {
  const systemPayload: IncidentClosePayload = {
    id: payload.incidentId,
    resolvedBy: opsResolvedBy(staffId),
    resolutionType: "STAFF",
    closingTurnId: null,
  };
  const envelope = buildSystemEnvelope({
    kind: "incident.ticket.close" as const,
    payload: systemPayload,
    sourceSubject: "incident.ops_staff_resolve",
    eventId: `${payload.incidentId}:resolve:${Date.now()}`,
  });
  const out = await deps.incidentSvc.closeIncidentFromEnvelope(envelope, {});
  return { incidentId: payload.incidentId, status: out.result?.status ?? null };
}

/**
 * Executor for `schedule.override.set` (SCN-127) — writes a per-date schedule
 * override via the SAME `scheduleService.upsertOverride` the admin schedule
 * override route uses (a domain-service verb; NO Medusa egress, NO second
 * adjudication — the composed router already produced the Decision at SUBMIT). The
 * resolver already normalized `payload.date` to a CONCRETE ISO date; the pack
 * validator guaranteed `blocks` are coherent with `isOpen` (open ⇒ non-empty,
 * closed ⇒ none). After the committed write it invalidates the Redis schedule
 * cache EXACTLY like the admin route, so the customer-facing hours/closed-notice
 * reads pick the override up immediately; a swallowed invalidation is WARN-logged
 * (with the Capsule staffId — never the payload) and the cache TTL bounds
 * staleness. A failed invalidation NEVER fails the write (the override committed).
 */
async function executeScheduleOverrideSet(
  deps: OpsToolRegistryDeps,
  payload: ScheduleOverrideSetPayload,
  staffId: string | null,
): Promise<{ date: string; isOpen: boolean }> {
  await deps.scheduleSvc.upsertOverride(payload.date, {
    isOpen: payload.isOpen,
    // A CLOSED day carries no windows; an OPEN day carries the validated blocks.
    blocks: payload.isOpen ? (payload.blocks ?? []) : [],
    note: payload.note ?? null,
  });
  const { ok } = await deps.invalidateScheduleCache();
  if (!ok) {
    deps.log?.warn?.(
      {
        event: "ops_schedule_override_cache_invalidation_failed",
        date: payload.date,
        staffId,
      },
      "Ops schedule override written but cache invalidation was swallowed — the edit may take up to SCHEDULE_CACHE_TTL_SECONDS (default 300s) to propagate to the bot.",
    );
  }
  return { date: payload.date, isOpen: payload.isOpen };
}

/** The nine governed ops MUTATING tools (capability === intentKind). */
function opsToolDefinitions(
  deps: OpsToolRegistryDeps,
): ReadonlyArray<ToolDefinition<unknown, unknown>> {
  return [
    {
      id: "ibatexas.ops.productAvailability.v1",
      capability: asCapability("product.availability.set"),
      intentKind: asIntentKind("product.availability.set"),
      description:
        "Marcar um produto como disponível/indisponível (86 / desfazer 86).",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "medium",
      execute: (input, ctx) =>
        executeAvailability(
          deps,
          input as ProductAvailabilitySetPayload,
          staffIdFromCapsule(ctx),
        ),
    },
    {
      id: "ibatexas.ops.productPrice.v1",
      capability: asCapability("product.price.set"),
      intentKind: asIntentKind("product.price.set"),
      description:
        "Alterar o preço de um produto (ex.: aumenta o preço da picanha pra 95 reais).",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "medium",
      execute: (input, ctx) =>
        executePriceSet(
          deps,
          input as ProductPriceSetPayload,
          staffIdFromCapsule(ctx),
        ),
    },
    {
      id: "ibatexas.ops.menuSpecialSet.v1",
      capability: asCapability("menu.special.set"),
      intentKind: asIntentKind("menu.special.set"),
      description:
        "Definir o especial do dia (ex.: o especial de hoje é feijoada por 45 reais).",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "low",
      execute: (input) =>
        executeMenuSpecialSet(deps, input as MenuSpecialSetPayload),
    },
    {
      id: "ibatexas.ops.orderNoteAdd.v1",
      capability: asCapability("order.note.add"),
      intentKind: asIntentKind("order.note.add"),
      description: "Adicionar uma observação (nota interna) a um pedido.",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "low",
      execute: (input, ctx) =>
        executeNote(
          deps,
          input as OrderNoteAddPayload,
          staffIdFromCapsule(ctx),
        ),
    },
    {
      id: "ibatexas.ops.orderStatusTransition.v1",
      capability: asCapability("order.status.transition"),
      intentKind: asIntentKind("order.status.transition"),
      description:
        "Avançar um pedido para o próximo status da cozinha/entrega (ex.: preparando → pronto).",
      // BKL-144 — the REAL model-facing shape. The runtime treats inputSchema
      // opaquely (it is NOT surfaced to the LLM — the planner advertises only
      // `capability` + a generic `payload`), so this documents the CLOSED contract
      // the guard enforces rather than driving generation: the planner emits ONLY
      // `orderId` + `newStatus`; `actor`/`actorId`/`reason` are Capsule-forced by
      // the executor, never model-parsed. `newStatus` is one of the six English
      // enum values VERBATIM — the BKL-090 guard reads `payload.newStatus`
      // literally with NO pt→en / alias normalization (the fix teaches the planner,
      // it does NOT loosen the guard).
      inputSchema: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description:
              "Pedido a transicionar — id, número de exibição ou nome do cliente (o resolver mapeia para o id real).",
          },
          newStatus: {
            type: "string",
            enum: [
              "confirmed",
              "preparing",
              "ready",
              "in_delivery",
              "delivered",
              "canceled",
            ],
            description:
              "Status alvo — EXATAMENTE um destes valores em inglês (contrato fechado; o guard não normaliza).",
          },
        },
        required: ["orderId", "newStatus"],
        additionalProperties: false,
      },
      outputSchema: {},
      riskLevel: "medium",
      execute: (input, ctx) =>
        executeStatusTransition(
          deps,
          input as OrderStatusTransitionPayload,
          staffIdFromCapsule(ctx),
        ),
    },
    {
      id: "ibatexas.ops.paymentRefundIssue.v1",
      capability: asCapability("payment.refund.issue"),
      intentKind: asIntentKind("payment.refund.issue"),
      description:
        "Emitir um reembolso de um pedido (envia dinheiro de volta ao cliente).",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "high",
      execute: (input, ctx) =>
        executeRefund(
          deps,
          input as PaymentRefundIssuePayload,
          staffIdFromCapsule(ctx),
        ),
    },
    {
      id: "ibatexas.ops.alertResolveStaff.v1",
      capability: asCapability("ops.alert.resolve.staff"),
      intentKind: asIntentKind("ops.alert.resolve.staff"),
      description:
        "Resolver (fechar) um alerta operacional pela mensagem (ex.: resolve o alerta X).",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "low",
      execute: (input, ctx) =>
        executeAlertResolveStaff(
          deps,
          input as OpsAlertResolveStaffPayload,
          staffIdFromCapsule(ctx),
        ),
    },
    {
      id: "ibatexas.ops.incidentCloseStaff.v1",
      capability: asCapability("incident.ticket.close.staff"),
      intentKind: asIntentKind("incident.ticket.close.staff"),
      description:
        "Fechar (resolver) um incidente de não-resposta pela mensagem (ex.: fecha o incidente Y).",
      inputSchema: {},
      outputSchema: {},
      riskLevel: "low",
      execute: (input, ctx) =>
        executeIncidentCloseStaff(
          deps,
          input as IncidentCloseStaffPayload,
          staffIdFromCapsule(ctx),
        ),
    },
    {
      id: "ibatexas.ops.scheduleOverrideSet.v1",
      capability: asCapability("schedule.override.set"),
      intentKind: asIntentKind("schedule.override.set"),
      description:
        "Definir uma exceção de horário para uma data (ex.: fecha amanhã / amanhã abrimos só às 18h).",
      inputSchema: {},
      outputSchema: {},
      // Reversible, non-money (a per-date override the admin UI can correct/remove).
      riskLevel: "low",
      execute: (input, ctx) =>
        executeScheduleOverrideSet(
          deps,
          input as ScheduleOverrideSetPayload,
          staffIdFromCapsule(ctx),
        ),
    },
  ];
}

/**
 * Build the OPS-plane tool registry. SEPARATE from the chat registry
 * (`createToolRegistry()` + `registerIbatexasToolPacks`) so the chat roster /
 * drift gates never see these tools. Built ONCE at boot; the executors read the
 * per-request staffId from the Capsule.
 */
export function createOpsToolRegistry(deps: OpsToolRegistryDeps): ToolRegistry {
  const registry = createToolRegistry();
  for (const tool of opsToolDefinitions(deps)) {
    registry.register(tool);
  }
  return registry;
}

/** For tests / the boot drift-parity gate: the ops tools without registering. */
export function listOpsToolDefinitions(
  deps: OpsToolRegistryDeps,
): ReadonlyArray<ToolDefinition<unknown, unknown>> {
  return opsToolDefinitions(deps);
}
