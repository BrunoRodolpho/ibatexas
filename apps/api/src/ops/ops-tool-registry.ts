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
//
// `staffId` (audit sourceSubject / note authorId) is read from the per-turn
// `Capsule.actor.staffId` — the AUTHORITATIVE identity the ops route stamps from
// the JWT at `openCapsule`, NEVER from the model-parsed payload. The registry is
// built ONCE at boot and reused per request (the Capsule is the per-request
// context); the injected side-effect deps make it unit-testable with spies.

import { randomUUID } from "node:crypto";
import {
  createToolRegistry,
  type CapabilityId,
  type IntentKind,
  type ToolDefinition,
  type ToolRegistry,
} from "@claustrum/core";
import type { AuditSink } from "@ibatexas/audit-sink";
import type { MedusaAdjudicatedArgs } from "@ibatexas/tools";
import type { AddNoteResult } from "@ibatexas/domain";
import type {
  OrderNoteAddPayload,
  OrderStatusTransitionPayload,
} from "@ibatexas/pack-orders";
import type { ProductAvailabilitySetPayload } from "@ibatexas/pack-ops";
import type {
  OrderFulfillmentStatus,
  OrderStatusChangedEvent,
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

export interface OpsToolRegistryDeps {
  /** `medusaAdjudicated` (injected for testability). */
  readonly medusaAdjudicated: MedusaAdjudicatedFn;
  /** Audit sink threaded into the egress call (getAuditSink() at boot). */
  readonly auditSink: AuditSink;
  /** The order command service's POST-adjudication writers (note + transition). */
  readonly orderCmdSvc: OpsNoteWriter & OpsStatusWriter;
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

/** The three governed ops MUTATING tools (capability === intentKind). */
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
      inputSchema: {},
      outputSchema: {},
      riskLevel: "medium",
      execute: (input, ctx) =>
        executeStatusTransition(
          deps,
          input as OrderStatusTransitionPayload,
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
