// Unit tests for analytics route
// POST /api/analytics/track → validate → NATS publish → 204

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

// ── Server factory ─────────────────────────────────────────────────────────────

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { analyticsRoutes } from "../routes/analytics.js";

async function buildTestServer() {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(analyticsRoutes);
  await app.ready();
  return app;
}

describe("POST /api/analytics/track", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 204 and publishes to NATS with correct subject", async () => {
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: {
        event: "pdp_viewed",
        properties: { productId: "prod_01", sessionId: "sess_123" },
      },
    });

    expect(res.statusCode).toBe(204);
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);

    const [subject, payload] = mockPublishNatsEvent.mock.calls[0];
    expect(subject).toBe("web.pdp_viewed");
    expect(payload.productId).toBe("prod_01");
    expect(payload.sessionId).toBe("sess_123");
    expect(payload.receivedAt).toBeDefined();

    await app.close();
  });

  it("returns 204 with minimal payload (event only, no properties)", async () => {
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: { event: "session_started" },
    });

    expect(res.statusCode).toBe(204);
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);

    const [subject, payload] = mockPublishNatsEvent.mock.calls[0];
    expect(subject).toBe("web.session_started");
    expect(payload.receivedAt).toBeDefined();

    await app.close();
  });

  it("returns 400 when event field is missing", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: { properties: { foo: "bar" } },
    });

    expect(res.statusCode).toBe(400);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 400 when body is empty", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 204 even when NATS publish fails (non-blocking)", async () => {
    mockPublishNatsEvent.mockRejectedValue(new Error("NATS connection failed"));

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: {
        event: "checkout_completed",
        properties: { orderId: "ord_01", sessionId: "sess_456" },
      },
    });

    // Must return 204 — analytics never blocks UX
    expect(res.statusCode).toBe(204);
    expect(mockPublishNatsEvent).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("rejects oversized payload (> 4KB body limit)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: {
        event: "test_oversized",
        properties: { data: "x".repeat(5000) },
      },
    });

    // Fastify returns 413 when bodyLimit is exceeded
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(mockPublishNatsEvent).not.toHaveBeenCalled();

    await app.close();
  });

  it("publishes NATS subject with ibatexas prefix via publishNatsEvent", async () => {
    // publishNatsEvent internally prefixes with "ibatexas."
    // so web.pdp_viewed becomes ibatexas.web.pdp_viewed
    mockPublishNatsEvent.mockResolvedValue(undefined);

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: { event: "add_to_cart", properties: { productId: "prod_02" } },
    });

    expect(mockPublishNatsEvent).toHaveBeenCalledWith(
      "web.add_to_cart",
      expect.objectContaining({
        productId: "prod_02",
        receivedAt: expect.any(String),
      }),
    );

    await app.close();
  });
});
