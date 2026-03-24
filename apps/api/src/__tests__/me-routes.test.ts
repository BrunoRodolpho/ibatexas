// Unit tests for /api/me routes — LGPD data export and anonymization

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockExportCustomerData = vi.hoisted(() => vi.fn());
const mockAnonymizeCustomer = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/domain", () => ({
  exportCustomerData: mockExportCustomerData,
  anonymizeCustomer: mockAnonymizeCustomer,
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const customerId = request.headers["x-customer-id"] as string | undefined;
    if (!customerId) {
      void reply
        .code(401)
        .send({ statusCode: 401, error: "Unauthorized", message: "Autenticação necessária." });
      return;
    }
    request.customerId = customerId;
    done();
  },
}));

// ── Server factory ─────────────────────────────────────────────────────────────

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { meRoutes } from "../routes/me.js";

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(meRoutes);
  await app.ready();
  return app;
}

// ── Fixtures ────────────────────────────────────────────────────────────────────

const customerDataFixture = {
  customer: {
    id: "cust_01",
    phone: "+5511999887766",
    name: "Maria",
    email: null,
    source: "whatsapp",
    firstContactAt: new Date("2026-01-15T00:00:00.000Z"),
  },
  addresses: [],
  preferences: null,
  reviews: [],
  orderHistory: [],
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/me/data — export customer data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns customer data", async () => {
    mockExportCustomerData.mockResolvedValue(customerDataFixture);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/me/data",
      headers: { "x-customer-id": "cust_01" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customer.id).toBe("cust_01");
    expect(body.customer.phone).toBe("+5511999887766");
    expect(body).toHaveProperty("addresses");
    expect(body).toHaveProperty("preferences");
    expect(body).toHaveProperty("reviews");
    expect(body).toHaveProperty("orderHistory");
    expect(mockExportCustomerData).toHaveBeenCalledWith("cust_01");
  });

  it("returns 401 when not authenticated", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/me/data",
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/me/data — anonymize customer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("anonymizes customer and returns success", async () => {
    mockAnonymizeCustomer.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/me/data",
      headers: { "x-customer-id": "cust_01" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("anonimizados");
    expect(mockAnonymizeCustomer).toHaveBeenCalledWith("cust_01");
  });

  it("returns 401 when not authenticated", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/me/data",
    });

    expect(res.statusCode).toBe(401);
  });
});
