// admin/dashboard.ts — GET /api/admin/dashboard, the admin panel's KPI tile row.
//
// F-33: this route had ZERO tests. The gap is pre-existing — PR #540 surfaced it
// while deleting a phantom `admin-routes.test.ts` that never touched
// `dashboard.ts` in the first place.
//
// ENDPOINT CENSUS — the module registers exactly one route:
//   GET /api/admin/dashboard → { ordersToday, revenueToday, activeReservations,
//                                pendingEscalations }
// composed from three independent sources, each wrapped in its OWN try/catch so
// a failure zeroes only its own figure:
//   1. `medusaAdmin("/admin/orders?…")` → ordersToday (count) + revenueToday
//      (sum of `total`, missing total counted as 0), over TODAY's orders only.
//   2. `createReservationService().countActive()` → activeReservations.
//   3. `getEscalationStore().listOpen(1000).length` → pendingEscalations. (This
//      was a hard-coded 0 once, masking the takeover queue — so "0" here has to
//      mean "counted zero", never "did not count".)
// Plus an outer try/catch → 500 { error: "Failed to load dashboard" }. That arm
// is enumerated but NOT covered: every statement it wraps already has an inner
// catch, so the only way to reach it is `reply.send` itself throwing, which is
// not reachable through the public interface. Covering it would take a mutation
// of Fastify's reply, which pins the double rather than the route.
//
// AUTH POSTURE: dashboard.ts carries no route-level guard. The gate it sits
// behind is the parent `adminRoutes` DOM-001 preHandler (routes/admin/index.ts),
// and `/api/admin/dashboard` is NOT in that guard's KEY_ELIGIBLE set — so it is
// staff-JWT-only, and the proxy-injected x-admin-key must NOT stand in for a
// session. That posture is only observable through the real parent, so the auth
// block below registers the real `adminRoutes`. The ONLY thing stubbed there is
// `optionalAuth` — the JWT crypto/cookie seam, which has its own coverage in
// `staff-middleware.test.ts`. Every decision under test (KEY_ELIGIBLE, the
// 401s, the forged-cookie belt, the timing-safe key compare) is the real code.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockMedusaAdmin = vi.hoisted(() => vi.fn());
const mockCountActive = vi.hoisted(() => vi.fn());
const mockListOpen = vi.hoisted(() => vi.fn());
// Drives the stubbed `optionalAuth`: the staff identity a valid JWT would have
// attached, or null for "no valid staff JWT".
const authState = vi.hoisted(() => ({
  staff: null as { id: string; role: "OWNER" | "MANAGER" | "ATTENDANT" } | null,
}));

vi.mock("../_shared.js", () => ({
  medusaAdmin: mockMedusaAdmin,
  medusaStore: vi.fn(async () => ({})),
}));

vi.mock("../../../escalation/escalation-store.js", () => ({
  getEscalationStore: vi.fn(async () => ({ listOpen: mockListOpen })),
}));

vi.mock("../../../middleware/auth.js", () => ({
  optionalAuth: (
    request: { staffId?: string; staffRole?: string },
    _reply: unknown,
    done: () => void,
  ) => {
    if (authState.staff) {
      request.staffId = authState.staff.id;
      request.staffRole = authState.staff.role;
    }
    done();
  },
  requireAuth: (_request: unknown, _reply: unknown, done: () => void) => done(),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

// The domain surface the FULL adminRoutes tree touches at registration time.
// Mirrors src/__tests__/admin-auth.test.ts, which already builds this same
// server; `createReservationService().countActive` is the one addition this
// slice needs.
vi.mock("@ibatexas/domain", () => ({
  createFiscalDocumentService: () => ({}),
  createStaffCommandService: () => ({}),
  FROZEN_CAUSES: ["empty_completion", "whitespace_only", "send_failed", "retry_exhausted", "timeout"],
  createReservationService: () => ({
    countActive: mockCountActive,
    findAll: vi.fn(async () => []),
    findConfirmedForDate: vi.fn(async () => []),
    checkAvailability: vi.fn(async () => []),
    transition: vi.fn(async () => {}),
    transitionFromEnvelope: vi.fn(async () => ({ decision: { kind: "EXECUTE", basis: [] }, result: undefined })),
    listAll: vi.fn(async () => ({ reservations: [], total: 0 })),
    getTodaySummary: vi.fn(async () => ({ total: 0, confirmed: 0, seated: 0, completed: 0, cancelled: 0, noShow: 0, covers: 0 })),
  }),
  createTableService: () => ({
    listAll: vi.fn(async () => []),
    upsert: vi.fn(async (data: { number: string }) => ({ id: "t1", ...data })),
  }),
  createDeliveryZoneService: () => ({ listAll: vi.fn(async () => []) }),
  createScheduleService: () => ({
    getSchedule: vi.fn(async () => ({ days: {} })),
    updateSchedule: vi.fn(async () => ({})),
  }),
  createOrderCommandService: () => ({
    create: vi.fn(),
    reconcileStatus: vi.fn(async () => ({ success: true })),
    transitionStatus: vi.fn(async () => ({ version: 1, previousStatus: "pending", newStatus: "pending" })),
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 1, previousStatus: "pending", newStatus: "pending" },
    })),
  }),
  createOrderQueryService: () => ({
    list: vi.fn(async () => ({ orders: [], count: 0 })),
    listAll: vi.fn(async () => ({ orders: [], count: 0 })),
    getById: vi.fn(async () => null),
  }),
  createPaymentCommandService: () => ({
    create: vi.fn(),
    transitionStatus: vi.fn(async () => ({ id: "pay_01", version: 1 })),
    transitionStatusFromEnvelope: vi.fn(async () => ({
      decision: { kind: "EXECUTE", basis: [] },
      result: { version: 1, previousStatus: "paid", newStatus: "paid" },
    })),
  }),
  createPaymentQueryService: () => ({
    listByOrderId: vi.fn(async () => ({ payments: [], count: 0 })),
    getActiveByOrderId: vi.fn(async () => null),
  }),
  createOrderEventLogService: () => ({ append: vi.fn(async () => undefined) }),
  createConversationService: () => ({
    findBySessionId: vi.fn(async () => null),
    searchConversations: vi.fn(async () => []),
    appendMessage: vi.fn(async () => undefined),
  }),
  prisma: {
    reservation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    review: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    customerOrderItem: { findMany: vi.fn(async () => []) },
    conversationMessage: { count: vi.fn(async () => 0) },
    orderProjection: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), count: vi.fn(async () => 0) },
    customer: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) },
    reservationTable: { findMany: vi.fn(async () => []) },
    payment: { update: vi.fn(async () => ({})) },
    orderNote: { create: vi.fn(async () => ({ id: "n1", createdAt: new Date(), content: "" })), findMany: vi.fn(async () => []) },
  },
}));

// ── Hand-written fixtures ────────────────────────────────────────────────────
// Every expected figure below is written as a literal computed BY HAND from
// these rows — never read back off the route's own response.
const ORDERS = [
  { id: "order_01", total: 1_500, status: "pending" },
  { id: "order_02", total: 2_500, status: "completed" },
  { id: "order_03", total: 400, status: "pending" },
];
// 1500 + 2500 + 400
const ORDERS_REVENUE = 4_400;
const ORDERS_COUNT = 3;

const OPEN_ESCALATIONS = [
  { sessionId: "sess_a" },
  { sessionId: "sess_b" },
  { sessionId: "sess_c" },
  { sessionId: "sess_d" },
];
const OPEN_ESCALATIONS_COUNT = 4;

const ACTIVE_RESERVATIONS = 7;

interface DashboardBody {
  ordersToday: number;
  revenueToday: number;
  activeReservations: number;
  pendingEscalations: number;
}

/** The healthy default: all three sources answer. */
function primeHappyPath(): void {
  mockMedusaAdmin.mockResolvedValue({ orders: ORDERS });
  mockCountActive.mockResolvedValue(ACTIVE_RESERVATIONS);
  mockListOpen.mockResolvedValue(OPEN_ESCALATIONS);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Handler behaviour — dashboardRoutes registered on its own.
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /api/admin/dashboard", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    const { dashboardRoutes } = await import("../dashboard.js");
    server = Fastify({ logger: false });
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(dashboardRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    primeHappyPath();
  });

  async function get(): Promise<{ statusCode: number; body: DashboardBody }> {
    const res = await server.inject({ method: "GET", url: "/api/admin/dashboard" });
    return { statusCode: res.statusCode, body: res.json() as DashboardBody };
  }

  it("composes the four KPI figures from Medusa, the reservation service and the escalation store", async () => {
    const { statusCode, body } = await get();

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      ordersToday: ORDERS_COUNT,
      revenueToday: ORDERS_REVENUE,
      activeReservations: ACTIVE_RESERVATIONS,
      pendingEscalations: OPEN_ESCALATIONS_COUNT,
    });
  });

  it("sums the `total` of every order and counts a missing total as 0", async () => {
    mockMedusaAdmin.mockResolvedValue({
      orders: [
        { id: "order_01", total: 1_000, status: "pending" },
        { id: "order_02", status: "pending" }, // no `total` at all
        { id: "order_03", total: 250, status: "pending" },
      ],
    });

    const { body } = await get();

    // The order still COUNTS — it just contributes nothing to revenue.
    expect(body.ordersToday).toBe(3);
    expect(body.revenueToday).toBe(1_250); // 1000 + 0 + 250
  });

  it("counts an empty order list as zero orders and zero revenue", async () => {
    mockMedusaAdmin.mockResolvedValue({ orders: [] });

    const { body } = await get();

    expect(body.ordersToday).toBe(0);
    expect(body.revenueToday).toBe(0);
    // The other two sources answered normally in the same request, so these
    // zeros are a real count of an empty list, not a silently skipped fetch.
    expect(body.activeReservations).toBe(ACTIVE_RESERVATIONS);
    expect(body.pendingEscalations).toBe(OPEN_ESCALATIONS_COUNT);
  });

  it("tolerates a Medusa payload with no `orders` key at all", async () => {
    mockMedusaAdmin.mockResolvedValue({});

    const { statusCode, body } = await get();

    expect(statusCode).toBe(200);
    expect(body.ordersToday).toBe(0);
    expect(body.revenueToday).toBe(0);
  });

  it("asks Medusa for TODAY's orders only, capped at 500, fetching just id/total/status", async () => {
    // Only Date is faked — faking timers wholesale would stall the inject.
    vi.useFakeTimers({ toFake: ["Date"] });
    const frozen = new Date("2026-03-15T18:42:07.123Z");
    vi.setSystemTime(frozen);
    try {
      await get();

      expect(mockMedusaAdmin).toHaveBeenCalledTimes(1);
      const url = mockMedusaAdmin.mock.calls[0]?.[0] as string;
      const [path, query] = url.split("?");
      expect(path).toBe("/admin/orders");

      const params = new URLSearchParams(query);
      expect(params.get("limit")).toBe("500");
      expect(params.get("offset")).toBe("0");
      expect(params.get("fields")).toBe("id,total,status");

      // The lower bound is asserted by PROPERTY rather than by rebuilding the
      // route's own `setHours(0,0,0,0).toISOString()` expression — a rebuilt
      // string would agree with a wrong boundary as readily as a right one, and
      // the local-midnight/UTC pairing makes the literal timezone-dependent.
      const gte = params.get("created_at[gte]");
      expect(gte).toBeTruthy();
      const since = new Date(gte as string);
      expect(Number.isNaN(since.getTime())).toBe(false);
      // Local midnight: no time-of-day component survives.
      expect([since.getHours(), since.getMinutes(), since.getSeconds(), since.getMilliseconds()])
        .toEqual([0, 0, 0, 0]);
      // TODAY's midnight — not yesterday's, not the start of the month.
      expect(since.toDateString()).toBe(frozen.toDateString());
      // And it is genuinely a lower bound on "now".
      expect(since.getTime()).toBeLessThan(frozen.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts open escalations for real — listOpen is called with the wide 1000 limit", async () => {
    const { body } = await get();

    expect(mockListOpen).toHaveBeenCalledTimes(1);
    expect(mockListOpen).toHaveBeenCalledWith(1_000);
    // The count comes from the store, not from a constant: four open records in,
    // four out. (This field was a hard-coded 0 before it was wired up.)
    expect(body.pendingEscalations).toBe(OPEN_ESCALATIONS_COUNT);
  });

  it("an escalation-store failure zeroes ONLY pendingEscalations — the other three figures still report", async () => {
    mockListOpen.mockRejectedValue(new Error("redis down"));

    const { statusCode, body } = await get();

    expect(statusCode).toBe(200);
    expect(body.pendingEscalations).toBe(0);
    // The during-arm: these three are non-zero in the SAME response, so the 0
    // above is this source failing soft — not the whole handler bailing out.
    expect(body.ordersToday).toBe(ORDERS_COUNT);
    expect(body.revenueToday).toBe(ORDERS_REVENUE);
    expect(body.activeReservations).toBe(ACTIVE_RESERVATIONS);
  });

  it("a Medusa failure zeroes ONLY the order figures — reservations and escalations still report", async () => {
    mockMedusaAdmin.mockRejectedValue(new Error("medusa 502"));

    const { statusCode, body } = await get();

    expect(statusCode).toBe(200);
    expect(body.ordersToday).toBe(0);
    expect(body.revenueToday).toBe(0);
    expect(body.activeReservations).toBe(ACTIVE_RESERVATIONS);
    expect(body.pendingEscalations).toBe(OPEN_ESCALATIONS_COUNT);
  });

  it("a reservation-service failure zeroes ONLY activeReservations — orders and escalations still report", async () => {
    mockCountActive.mockRejectedValue(new Error("prisma pool exhausted"));

    const { statusCode, body } = await get();

    expect(statusCode).toBe(200);
    expect(body.activeReservations).toBe(0);
    expect(body.ordersToday).toBe(ORDERS_COUNT);
    expect(body.revenueToday).toBe(ORDERS_REVENUE);
    expect(body.pendingEscalations).toBe(OPEN_ESCALATIONS_COUNT);
  });

  it("all three sources failing still answers 200 with four zeros, never a 500", async () => {
    mockMedusaAdmin.mockRejectedValue(new Error("medusa 502"));
    mockCountActive.mockRejectedValue(new Error("prisma pool exhausted"));
    mockListOpen.mockRejectedValue(new Error("redis down"));

    const { statusCode, body } = await get();

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      ordersToday: 0,
      revenueToday: 0,
      activeReservations: 0,
      pendingEscalations: 0,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Auth posture — the REAL parent adminRoutes guard (DOM-001 / S1).
// ═════════════════════════════════════════════════════════════════════════════
const ADMIN_KEY = "f33-dashboard-admin-key-0123456789";

describe("GET /api/admin/dashboard — auth posture (DOM-001)", () => {
  let server: FastifyInstance;
  const savedKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { adminRoutes } = await import("../index.js");
    server = Fastify({ logger: false });
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(sensible);
    await server.register(adminRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    if (savedKey === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = savedKey;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    primeHappyPath();
    authState.staff = null;
  });

  afterEach(() => {
    authState.staff = null;
  });

  // ── CONTROL — this arm MUST reach the handler, or every treatment below is
  // satisfied by a route that simply does not exist.
  it("CONTROL: an authenticated staff session reaches the handler and gets the KPI body", async () => {
    authState.staff = { id: "staff_mgr_f33", role: "MANAGER" };

    const res = await server.inject({ method: "GET", url: "/api/admin/dashboard" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ordersToday: ORDERS_COUNT,
      revenueToday: ORDERS_REVENUE,
      activeReservations: ACTIVE_RESERVATIONS,
      pendingEscalations: OPEN_ESCALATIONS_COUNT,
    });
  });

  it("CONTROL: the gate is authentication, not role — an ATTENDANT session is admitted too", async () => {
    authState.staff = { id: "staff_att_f33", role: "ATTENDANT" };

    const res = await server.inject({ method: "GET", url: "/api/admin/dashboard" });

    expect(res.statusCode).toBe(200);
    expect((res.json() as DashboardBody).ordersToday).toBe(ORDERS_COUNT);
  });

  // NOTE (measured during RTR): this 401 is JOINTLY guaranteed. Removing the
  // non-key-eligible refusal alone leaves the request falling through to the
  // missing-x-admin-key refusal, which answers 401 too — so a single-conjunct
  // mutation cannot flip this test. Both refusals have to go before it reds.
  // The S1 test below is the one that isolates the key-eligibility conjunct.
  it("TREATMENT: an anonymous caller is refused 401 and the handler never runs", async () => {
    const res = await server.inject({ method: "GET", url: "/api/admin/dashboard" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
    // Refused AT the guard: no upstream fetch, no reservation count, no
    // escalation read. Same primed mocks the CONTROL above drove to 200.
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
    expect(mockCountActive).not.toHaveBeenCalled();
    expect(mockListOpen).not.toHaveBeenCalled();
  });

  // ── S1 — the shared x-admin-key is a CLI-only credential. The admin Next
  // proxy injects it on EVERY browser call with no session check, so honouring
  // it on a browser-facing route would let an unauthenticated caller read the
  // business's live revenue. /api/admin/dashboard is not KEY_ELIGIBLE.
  it("TREATMENT: an AUTHENTIC x-admin-key without a staff session is still refused 401 (S1: the key is CLI-only)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(res.statusCode).toBe(401);
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
    expect(mockListOpen).not.toHaveBeenCalled();
  });

  it("TREATMENT: a wrong x-admin-key is refused 401", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: { "x-admin-key": "not-the-key-not-the-key-not-the-k" },
    });

    expect(res.statusCode).toBe(401);
    expect(mockMedusaAdmin).not.toHaveBeenCalled();
  });

  // The key IS honoured on the CLI-driven groups, so the 401s above are about
  // WHICH ROUTE the key reaches — not about the key being rejected everywhere,
  // which a mis-set ADMIN_API_KEY would also produce.
  it("DISCRIMINATOR: the same key IS admitted on a CLI-eligible route, so the dashboard 401 is scoping and not a dud key", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/agents/kill-status",
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(res.statusCode).not.toBe(401);
  });
});
