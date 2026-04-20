// Unit tests for analytics route
// POST /api/analytics/track → validate → rate limit → 204

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import { analyticsRoutes } from "../routes/analytics.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockPublishNatsEvent = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

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

  it("returns 204 for valid event (NATS publish removed)", async () => {
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

    await app.close();
  });

  it("returns 204 with minimal payload (event only, no properties)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: { event: "session_started" },
    });

    expect(res.statusCode).toBe(204);

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

  it("returns 204 for valid event even without NATS (non-blocking)", async () => {
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

  it("returns 400 for unknown event type", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/analytics/track",
      payload: { event: "unknown_event_type" },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});
