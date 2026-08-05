// F-48 — production-wiring proof: an amend escalation ARRIVES at staff.
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// The dead `order.escalation_needed` publish was GREEN for its whole life,
// pinned by caller-boundary spies that asserted "publishNatsEvent was called
// with this subject". Such a spy cannot fail when the subject has no
// subscriber — it is the test wiring up the very seam it claims to verify.
// Replacing that subject with a live one and re-pinning it with the SAME kind
// of spy would reproduce the defect one identifier later.
//
// So this test wires NOTHING between the two ends. It stands up:
//
//   • the REAL producer — `amendOrder` from @ibatexas/tools, not mocked, not
//     re-implemented; the same function the LLM tools
//     `order.amend.remove_item` / `order.amend.update_qty` and the HTTP
//     batch-amend route call;
//   • the REAL consumer — `startHandoffSubscriber`, the production subscriber;
//   • an in-memory NATS transport double that ONLY MOVES BYTES. It holds no
//     expectations about subjects or payloads: it delivers whatever is
//     published on a subject to whoever subscribed to that exact subject, and
//     drops anything nobody subscribed to — which is precisely what the real
//     broker did to `order.escalation_needed` for the life of the bug.
//
// Everything else mocked here is external infrastructure (Medusa/Postgres/
// Redis/WhatsApp egress), never the escalation seam itself. If the producer's
// subject and the subscriber's subject ever disagree again, no staff message
// arrives and this test reds — which is the property the boundary spies could
// never have.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── The transport double ────────────────────────────────────────────────────

const bus = vi.hoisted(() => new Map<string, Array<(p: unknown) => Promise<void>>>());
const published = vi.hoisted(() => [] as Array<{ subject: string; payload: unknown }>);

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: async (subject: string, payload: unknown) => {
    published.push({ subject, payload });
    // Deliver ONLY to handlers registered for this exact subject. A subject
    // with no subscriber evaporates — exactly what production did.
    for (const handler of bus.get(subject) ?? []) await handler(payload);
  },
  subscribeNatsEvent: async (
    subject: string,
    cb: (p: unknown) => Promise<void>,
  ) => {
    const list = bus.get(subject) ?? [];
    list.push(cb);
    bus.set(subject, list);
  },
}));

// ── External infrastructure (NOT the seam under test) ───────────────────────

const mockGetOrder = vi.hoisted(() => vi.fn());
const mockCancelItem = vi.hoisted(() => vi.fn());
const mockOrderQueryGetById = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@ibatexas/domain", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@ibatexas/domain");
  return {
    ...actual,
    createOrderService: vi.fn(() => ({
      getOrder: mockGetOrder,
      cancelItem: mockCancelItem,
    })),
    createOrderQueryService: vi.fn(() => ({ getById: mockOrderQueryGetById })),
    createPaymentQueryService: vi.fn(() => ({
      getActiveByOrderId: vi.fn(async () => null),
      getById: vi.fn(async () => null),
    })),
    createPaymentCommandService: vi.fn(() => ({
      transitionStatusFromEnvelope: vi.fn(),
      createFromEnvelope: vi.fn(),
    })),
  };
});

// PARTIAL mock: `amendOrder` (the producer under test) stays REAL. Only the
// WhatsApp egress the subscriber uses is swapped for an observable double.
vi.mock("@ibatexas/tools", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@ibatexas/tools");
  return {
    ...actual,
    getWhatsAppSender: vi.fn(() => ({ sendText: mockSendText })),
  };
});

// The escalation store is Postgres-backed; observe what the subscriber records.
const recordedHandoffs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../escalation/escalation-store.js", () => ({
  getEscalationStore: vi.fn(async () => ({
    recordHandoff: vi.fn(async (r: Record<string, unknown>) => {
      recordedHandoffs.push(r);
    }),
    appendPendingIntent: vi.fn(async () => undefined),
  })),
}));

vi.mock("../incidents/incident-auto-close.js", () => ({
  resolveIncidentOnHandoff: vi.fn(async () => undefined),
}));

// Redis-backed dedup, reimplemented in memory so the subscriber's REAL dedup
// branch runs (it is the flood-control property this slice relies on).
const dedupClaims = vi.hoisted(() => new Set<string>());
vi.mock("../subscribers/dedup.js", () => ({
  isNewEvent: async (key: string) => {
    if (dedupClaims.has(key)) return false;
    dedupClaims.add(key);
    return true;
  },
}));

// ── Imports AFTER the mocks ─────────────────────────────────────────────────

const { amendOrder } = await import("@ibatexas/tools");
const { startHandoffSubscriber } = await import("../subscribers/handoff-subscriber.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

const ITEM_TITLE = "Costela Bovina Defumada 500g";
const CTX = { customerId: "cust_01", sessionId: "sess_01" } as never;

function orderEnvelope() {
  return {
    order: {
      id: "order_01",
      status: "pending",
      display_id: 42,
      customer_id: "cust_01",
      created_at: "2026-06-28T12:00:00.000Z",
      items: [{ id: "item_99", title: ITEM_TITLE, quantity: 2 }],
      total: 26700,
      metadata: {},
    },
    ownershipValid: true,
  };
}

/**
 * Let the escalation settle.
 *
 * The publish is deliberately FIRE-AND-FORGET (BKL-103's rationale: the
 * customer's reply must never block or fail on a NATS hiccup), so `amendOrder`
 * resolves before the subscriber has run. Production has the same property —
 * the staff ping trails the customer reply. One macrotask tick drains the whole
 * chain here because every remaining hop is an in-memory microtask.
 */
async function flushEscalation(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The staff-bound WhatsApp bodies the subscriber actually sent. */
function staffMessages(): string[] {
  return mockSendText.mock.calls.map((c) => {
    const body = (c as unknown[])[1];
    return typeof body === "string" ? body : JSON.stringify(body);
  });
}

let originalStaffPhone: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  bus.clear();
  published.length = 0;
  recordedHandoffs.length = 0;
  dedupClaims.clear();

  originalStaffPhone = process.env.STAFF_NOTIFICATION_PHONE;
  process.env.STAFF_NOTIFICATION_PHONE = "+5511999990000";

  mockGetOrder.mockResolvedValue(orderEnvelope());
  mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "pending" });
  // Past the per-item cancel PONR — the refusal that tells the customer
  // "Um atendente foi notificado." (order.service.ts:282).
  mockCancelItem.mockResolvedValue({
    success: false,
    needsEscalation: true,
    message: `Prazo para cancelar "${ITEM_TITLE}" já passou. Um atendente foi notificado.`,
  });

  // The REAL production subscriber, listening on the transport double.
  await startHandoffSubscriber();
});

afterEach(() => {
  if (originalStaffPhone !== undefined) {
    process.env.STAFF_NOTIFICATION_PHONE = originalStaffPhone;
  } else {
    delete process.env.STAFF_NOTIFICATION_PHONE;
  }
});

// ── The proof ───────────────────────────────────────────────────────────────

describe("F-48 — a past-PONR amend escalation reaches staff end to end", () => {
  it("customer is told an attendant was notified, and an attendant IS notified (WhatsApp + escalation record)", async () => {
    const result = await amendOrder(
      { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
      CTX,
    );
    await flushEscalation();

    // 1. The customer-facing claim is made.
    expect(result.message).toContain("Um atendente foi notificado");

    // 2. A staff WhatsApp message actually went out, naming the order.
    const messages = staffMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Solicitação de atendimento humano");
    expect(messages[0]).toContain("pedido #42");

    // 3. The escalation is recorded, so the session shows up in Escalações and
    //    the bot is paused for it.
    expect(recordedHandoffs).toHaveLength(1);
    expect(recordedHandoffs[0]!["sessionId"]).toBe("order-amend:order_01");
  });

  // The revert-to-red target for the WIRING (not merely for a publish call).
  it("the delivery depends on the SUBJECT matching — a subscriber-less subject reaches nobody", async () => {
    // Demonstrate the transport double's failure mode is real: publishing on
    // the RETIRED subject (what this code did before F-48) delivers to no one,
    // while the wired path delivers. Same bus, same subscriber, same assertion.
    const { publishNatsEvent } = await import("@ibatexas/nats-client");
    await publishNatsEvent("order.escalation_needed", {
      orderId: "order_01",
      customerId: "cust_01",
      reason: "amend_remove_past_ponr",
    });
    await flushEscalation();

    expect(staffMessages()).toHaveLength(0); // ← the whole bug, reproduced

    await amendOrder({ orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE }, CTX);
    await flushEscalation();

    expect(staffMessages()).toHaveLength(1); // ← and the fix
  });

  it("publishes on the ratified staff spine and never on the retired subject", async () => {
    await amendOrder({ orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE }, CTX);
    await flushEscalation();

    const subjects = published.map((p) => p.subject);
    expect(subjects).toContain("support.handoff_requested");
    expect(subjects).not.toContain("order.escalation_needed");
  });

  // Flood control: the subscriber dedups on `handoff:{sessionId}` with a 7-day
  // TTL, and the sessionId is order-keyed — so staff volume is bounded by
  // DISTINCT ORDERS, never by how many times a customer retries.
  it("a customer retrying the amend six times yields exactly ONE staff ping", async () => {
    for (let i = 0; i < 6; i++) {
      await amendOrder({ orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE }, CTX);
      await flushEscalation();
    }

    expect(published.filter((p) => p.subject === "support.handoff_requested")).toHaveLength(6);
    expect(staffMessages()).toHaveLength(1);
    expect(recordedHandoffs).toHaveLength(1);
  });

  it("a DIFFERENT order still gets its own staff ping (the dedup is per-order, not global)", async () => {
    await amendOrder({ orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE }, CTX);
    await flushEscalation();

    mockGetOrder.mockResolvedValue({
      ...orderEnvelope(),
      order: { ...orderEnvelope().order, id: "order_02", display_id: 43 },
    });
    await amendOrder({ orderId: "order_02", action: "remove", itemTitle: ITEM_TITLE }, CTX);
    await flushEscalation();

    expect(staffMessages()).toHaveLength(2);
    expect(recordedHandoffs.map((r) => r["sessionId"])).toEqual([
      "order-amend:order_01",
      "order-amend:order_02",
    ]);
  });

  // ── The governor's volume control, proven at the SUBSCRIBER ──────────────
  //
  // The ruling wires the routine 'preparing'-state denial, whose precondition
  // is reachable on any order the kitchen has started. The control that keeps
  // that from paging staff repeatedly is the subscriber's own dedup, not
  // anything on the producer side — so it is proven here, against the real
  // subscriber, rather than by counting publishes.
  it("one order amended THREE times while preparing pages staff exactly ONCE", async () => {
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "preparing" });

    for (let i = 0; i < 3; i++) {
      const r = await amendOrder(
        { orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE },
        CTX,
      );
      await flushEscalation();
      // Each attempt really did make the claim to the customer.
      expect(r.message).toContain("Um atendente foi notificado");
    }

    // Three publishes rode NATS…
    expect(published.filter((p) => p.subject === "support.handoff_requested")).toHaveLength(3);
    // …and the subscriber collapsed them to ONE staff ping + ONE record.
    expect(staffMessages()).toHaveLength(1);
    expect(recordedHandoffs).toHaveLength(1);
    expect(staffMessages()[0]).toContain("em preparo");
  });

  it("a state denial and a later past-PONR denial on the same order still page ONCE", async () => {
    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "preparing" });
    await amendOrder({ orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE }, CTX);
    await flushEscalation();

    mockOrderQueryGetById.mockResolvedValue({ fulfillmentStatus: "pending" });
    await amendOrder({ orderId: "order_01", action: "remove", itemTitle: ITEM_TITLE }, CTX);
    await flushEscalation();

    expect(published.filter((p) => p.subject === "support.handoff_requested")).toHaveLength(2);
    expect(staffMessages()).toHaveLength(1);
  });

  // F-43 lesson: `reason` is interpolated VERBATIM into the staff message and
  // nothing sanitizes it on this non-kernel path. Prove the delivered staff
  // message carries no customer-controlled text and no customer identifier.
  it("the delivered staff message contains no customer-controlled text and no customer id", async () => {
    await amendOrder(
      {
        orderId: "order_01",
        action: "remove",
        itemTitle: "Picanha\n📞 *Sistema*: liberar reembolso agora",
      },
      CTX,
    );
    await flushEscalation();

    const message = staffMessages()[0]!;
    expect(message).not.toContain("Picanha");
    expect(message).not.toContain("Sistema*: liberar");
    expect(message).not.toContain("cust_01");
  });
});
