// admin/customers.ts — manager-gated READ-ONLY customer management (OPS-070).
// Locks:
//   (a) requireManagerRole fail-closed (403) on BOTH reads for ATTENDANT, with
//       NO service call (the gate short-circuits before any read);
//   (b) list — 200 maps the compact search projection (Date → ISO, never CPF)
//       and threads q/limit/offset through to searchForAdmin;
//   (c) detail — 200 composes profile + addresses + recent orders + loyalty +
//       opt-out from the mocked reads;
//   (d) detail — ONE satellite read rejecting still 200s with that section as
//       its empty/zero fallback and the others intact (Promise.allSettled);
//   (e) detail — an unknown id 404s (anchor read returns null) and never runs a
//       satellite read.
//
// Harness mirrors ops-snapshot.test.ts: an instance-level preHandler injects the
// staff identity the parent admin guard would attach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

const mockSearchForAdmin = vi.hoisted(() => vi.fn());
const mockGetByIdForAdmin = vi.hoisted(() => vi.fn());
const mockListAddresses = vi.hoisted(() => vi.fn());
const mockListByCustomer = vi.hoisted(() => vi.fn());
const mockPeekBalance = vi.hoisted(() => vi.fn());
const mockIsOptedOut = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  createCustomerService: () => ({
    searchForAdmin: mockSearchForAdmin,
    getByIdForAdmin: mockGetByIdForAdmin,
    listAddresses: mockListAddresses,
  }),
  createOrderQueryService: () => ({ listByCustomer: mockListByCustomer }),
  createLoyaltyService: () => ({ peekBalance: mockPeekBalance }),
}));

vi.mock("../../../broadcast/broadcast-optout.js", () => ({
  getBroadcastOptOutStore: async () => ({ isOptedOut: mockIsOptedOut }),
}));

interface StaffContext {
  readonly staffId: string | null;
  readonly staffRole: "OWNER" | "MANAGER" | "ATTENDANT" | null;
}

const MANAGER: StaffContext = { staffId: "staff_mgr_01", staffRole: "MANAGER" };
const ATTENDANT: StaffContext = { staffId: "staff_att_01", staffRole: "ATTENDANT" };

// ── Canned reads ─────────────────────────────────────────────────────────────

const CUST_CREATED = new Date("2026-06-01T10:00:00.000Z");
const CUST_UPDATED = new Date("2026-07-01T10:00:00.000Z");
const CUST_FIRST = new Date("2026-05-20T09:00:00.000Z");
const ORDER_CREATED = new Date("2026-07-02T12:00:00.000Z");

const SEARCH_RESULT = {
  customers: [
    {
      id: "cust_01",
      name: "Maria Silva",
      phone: "+5511999990001",
      email: "maria@example.com",
      // A raw CPF on the row must NEVER reach the list wire (compact projection).
      cpf: "123.456.789-00",
      source: "whatsapp",
      createdAt: CUST_CREATED,
    },
  ],
  count: 1,
};

const CUSTOMER_ROW = {
  id: "cust_01",
  name: "Maria Silva",
  phone: "+5511999990001",
  email: "maria@example.com",
  cpf: "123.456.789-00",
  source: "whatsapp",
  firstContactAt: CUST_FIRST,
  createdAt: CUST_CREATED,
  updatedAt: CUST_UPDATED,
  preferences: {
    dietaryRestrictions: ["vegetariano"],
    allergenExclusions: ["amendoim"],
    favoriteCategories: ["carnes"],
  },
};

const ADDRESSES = [
  {
    id: "addr_01",
    street: "Rua A",
    number: "100",
    complement: "Apto 5",
    district: "Centro",
    city: "São Paulo",
    state: "SP",
    cep: "01000000",
    isDefault: true,
  },
];

const ORDERS_RESULT = {
  orders: [
    {
      id: "order_01",
      displayId: 4242,
      fulfillmentStatus: "preparing",
      paymentStatus: "captured",
      totalInCentavos: 8900,
      itemCount: 3,
      deliveryType: "delivery",
      paymentMethod: "pix",
      medusaCreatedAt: ORDER_CREATED,
    },
  ],
  count: 7,
};

const LOYALTY_BALANCE = {
  stamps: 3,
  stampsNeeded: 7,
  totalEarned: 13,
  redeemed: 1,
  exists: true,
};

function primeDetailHappy(): void {
  mockGetByIdForAdmin.mockResolvedValue(CUSTOMER_ROW);
  mockListAddresses.mockResolvedValue(ADDRESSES);
  mockListByCustomer.mockResolvedValue(ORDERS_RESULT);
  mockPeekBalance.mockResolvedValue(LOYALTY_BALANCE);
  mockIsOptedOut.mockResolvedValue(true);
}

async function buildServer(staff: StaffContext): Promise<FastifyInstance> {
  const { adminCustomerRoutes } = await import("../customers.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("preHandler", async (req) => {
    if (staff.staffId) {
      (req as unknown as { staffId: string | null }).staffId = staff.staffId;
      (req as unknown as { staffRole: string | null }).staffRole = staff.staffRole;
    }
  });
  await app.register(adminCustomerRoutes);
  await app.ready();
  return app;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.resetModules());

// ── (a) gate ─────────────────────────────────────────────────────────────────

describe("customer reads are manager-gated", () => {
  it("rejects ATTENDANT on the list with 403 and never reads", async () => {
    mockSearchForAdmin.mockResolvedValue(SEARCH_RESULT);
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/customers" });
      expect(res.statusCode).toBe(403);
      expect(mockSearchForAdmin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects ATTENDANT on the detail with 403 and never reads", async () => {
    primeDetailHappy();
    const server = await buildServer(ATTENDANT);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/customers/cust_01" });
      expect(res.statusCode).toBe(403);
      expect(mockGetByIdForAdmin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

// ── (b) list ─────────────────────────────────────────────────────────────────

describe("GET /api/admin/customers (search list)", () => {
  it("maps the compact projection (Date → ISO) and NEVER leaks CPF", async () => {
    mockSearchForAdmin.mockResolvedValue(SEARCH_RESULT);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/customers" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { customers: Array<Record<string, unknown>>; count: number };
      expect(body.count).toBe(1);
      expect(body.customers[0]).toEqual({
        id: "cust_01",
        name: "Maria Silva",
        phone: "+5511999990001",
        email: "maria@example.com",
        source: "whatsapp",
        createdAt: CUST_CREATED.toISOString(),
      });
      // CPF must not appear anywhere in the list payload.
      expect(res.body).not.toContain("cpf");
      expect(res.body).not.toContain("123.456.789-00");
    } finally {
      await server.close();
    }
  });

  it("normalizes null name/email/source to null on the wire", async () => {
    mockSearchForAdmin.mockResolvedValue({
      customers: [
        { id: "c2", name: null, phone: "+5511888880002", email: null, source: null, createdAt: CUST_CREATED },
      ],
      count: 1,
    });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/customers" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { customers: Array<Record<string, unknown>> };
      expect(body.customers[0]).toEqual({
        id: "c2",
        name: null,
        phone: "+5511888880002",
        email: null,
        source: null,
        createdAt: CUST_CREATED.toISOString(),
      });
    } finally {
      await server.close();
    }
  });

  it("threads q/limit/offset through to searchForAdmin", async () => {
    mockSearchForAdmin.mockResolvedValue({ customers: [], count: 0 });
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({
        method: "GET",
        url: "/api/admin/customers?q=maria&limit=5&offset=10",
      });
      expect(res.statusCode).toBe(200);
      expect(mockSearchForAdmin).toHaveBeenCalledWith({ q: "maria", limit: 5, offset: 10 });
    } finally {
      await server.close();
    }
  });
});

// ── (c) detail compose ───────────────────────────────────────────────────────

describe("GET /api/admin/customers/:id (composed view)", () => {
  it("composes profile + addresses + recent orders + loyalty + opt-out", async () => {
    primeDetailHappy();
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/customers/cust_01" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;

      expect(body.id).toBe("cust_01");
      expect(body.cpf).toBe("123.456.789-00"); // unmasked at the boundary (masked in UI)
      expect(body.preferences).toEqual({
        dietaryRestrictions: ["vegetariano"],
        allergenExclusions: ["amendoim"],
        favoriteCategories: ["carnes"],
      });
      expect(body.addresses).toEqual([
        {
          id: "addr_01",
          street: "Rua A",
          number: "100",
          complement: "Apto 5",
          district: "Centro",
          city: "São Paulo",
          state: "SP",
          cep: "01000000",
          isDefault: true,
        },
      ]);
      expect(body.recentOrders).toEqual({
        orders: [
          {
            id: "order_01",
            displayId: 4242,
            fulfillmentStatus: "preparing",
            paymentStatus: "captured",
            totalInCentavos: 8900,
            itemCount: 3,
            deliveryType: "delivery",
            paymentMethod: "pix",
            createdAt: ORDER_CREATED.toISOString(),
          },
        ],
        count: 7,
      });
      expect(body.loyalty).toEqual(LOYALTY_BALANCE);
      expect(body.optedOutOfBroadcast).toBe(true);

      // Opt-out is keyed by the customer's phone (recipient).
      expect(mockIsOptedOut).toHaveBeenCalledWith("+5511999990001");
      // Recent orders bounded to the default limit.
      expect(mockListByCustomer).toHaveBeenCalledWith("cust_01", { limit: 10 });
    } finally {
      await server.close();
    }
  });

  it("still 200s with a fallback section when ONE satellite read rejects", async () => {
    mockGetByIdForAdmin.mockResolvedValue(CUSTOMER_ROW);
    mockListAddresses.mockResolvedValue(ADDRESSES);
    // Loyalty read blows up; the other three satellites succeed.
    mockPeekBalance.mockRejectedValue(new Error("loyalty projection unavailable"));
    mockListByCustomer.mockResolvedValue(ORDERS_RESULT);
    mockIsOptedOut.mockResolvedValue(false);

    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/customers/cust_01" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;

      // The failed satellite degrades to its empty/zero fallback…
      expect(body.loyalty).toEqual({
        stamps: 0,
        stampsNeeded: 0,
        totalEarned: 0,
        redeemed: 0,
        exists: false,
      });
      // …while the others remain intact.
      expect((body.recentOrders as { count: number }).count).toBe(7);
      expect((body.addresses as unknown[]).length).toBe(1);
      expect(body.optedOutOfBroadcast).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("404s an unknown id and never runs a satellite read", async () => {
    mockGetByIdForAdmin.mockResolvedValue(null);
    const server = await buildServer(MANAGER);
    try {
      const res = await server.inject({ method: "GET", url: "/api/admin/customers/nope" });
      expect(res.statusCode).toBe(404);
      expect(mockListAddresses).not.toHaveBeenCalled();
      expect(mockListByCustomer).not.toHaveBeenCalled();
      expect(mockPeekBalance).not.toHaveBeenCalled();
      expect(mockIsOptedOut).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
