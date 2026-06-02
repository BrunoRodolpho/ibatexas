// Route tests for POST /api/webhooks/whatsapp (post-RC-A1-cutover, un-skipped).
//
// The route was rewritten for the claustrum cutover: it keeps the security
// envelope (Twilio signature verify, two-phase idempotency claim, per-phone rate
// limit) and delegates the conversation to the @claustrum/* Conductor,
// fire-and-forget after the synchronous Twilio 200:
//
//   verifySig (@claustrum/channel-whatsapp verifyTwilioSignature)
//   → claimIdempotency (Redis SET NX, 300s in-flight)
//   → checkRateLimit (atomicIncr, 60s)
//   → 200 <Response/>  +  void handleInboundAsync:
//        getConductor() → channels.whatsapp.perceive → openCapsule
//        → handleTurn (@claustrum/core) → channels.whatsapp.render → closeCapsule
//
// These tests exercise that ROUTED path by mocking the new dependencies
// (verifyTwilioSignature, getConductor → a test-double Conductor, handleTurn).
//
// The legacy suites that mocked the PRE-cutover route — buildUserMessage,
// handleShortcut, normalizePhone phone-format validation, and the
// session-store append — were REMOVED with the cutover (those modules/functions
// no longer exist in the route; the Conductor handles all inbound text
// uniformly). The "a valid message reaches the conductor" intent they partly
// covered is now the explicit conductor-delegation test below; the mandatory
// inbound-signature invariant is owned by @claustrum/channel-whatsapp's own 42
// signature tests. Deleting tests for deleted code is not a re-skip.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { whatsappWebhookRoutes } from "../routes/whatsapp-webhook.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockVerifyTwilioSignature = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockAtomicIncr = vi.hoisted(() => vi.fn());
const mockHashPhone = vi.hoisted(() => vi.fn());
const mockGetConductor = vi.hoisted(() => vi.fn());
const mockTryGetConductor = vi.hoisted(() => vi.fn());
const mockHandleTurn = vi.hoisted(() => vi.fn());
// The test-double Conductor surface the route touches.
const mockPerceive = vi.hoisted(() => vi.fn());
const mockRender = vi.hoisted(() => vi.fn());
const mockOpenCapsule = vi.hoisted(() => vi.fn());
const mockCloseCapsule = vi.hoisted(() => vi.fn());

vi.mock("@claustrum/channel-whatsapp", () => ({
  verifyTwilioSignature: mockVerifyTwilioSignature,
}));

vi.mock("@claustrum/core", () => ({
  handleTurn: mockHandleTurn,
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  atomicIncr: mockAtomicIncr,
}));

vi.mock("../claustrum-bootstrap.js", () => ({
  getConductor: mockGetConductor,
  tryGetConductor: mockTryGetConductor,
}));

vi.mock("../lib/phone-hash.js", () => ({
  hashPhone: mockHashPhone,
}));

// ── Server factory ──────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  await app.register(whatsappWebhookRoutes);
  await app.ready();
  return app;
}

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

/** Test-double Conductor with only the surface the route invokes. */
function fakeConductor() {
  return {
    channels: { whatsapp: { perceive: mockPerceive, render: mockRender } },
    openCapsule: mockOpenCapsule,
    closeCapsule: mockCloseCapsule,
  };
}

function setupEnv() {
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.com/api/webhooks/whatsapp");
}

/** Default-happy wiring for the security envelope + conductor delegation. */
function wireHappyPath(redis = createMockRedis()) {
  setupEnv();
  mockVerifyTwilioSignature.mockReturnValue(true);
  mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  mockAtomicIncr.mockResolvedValue(1);
  mockHashPhone.mockReturnValue("abc123def456");
  mockGetRedisClient.mockResolvedValue(redis);
  // Conductor delegation resolves cleanly (the route runs it fire-and-forget).
  mockPerceive.mockResolvedValue({
    channel: "whatsapp",
    customerId: "cus-1",
    conversationId: "conv-1",
    text: "oi",
    receivedAt: "2026-05-31T00:00:00.000Z",
  });
  mockOpenCapsule.mockResolvedValue({ id: "capsule-1" });
  mockHandleTurn.mockResolvedValue({ response: { text: "Resposta do agente" } });
  mockRender.mockResolvedValue(undefined);
  mockCloseCapsule.mockResolvedValue(undefined);
  mockGetConductor.mockReturnValue(fakeConductor());
  // Conductor bootstrapped (flag ON) by default → the routed conductor path is
  // taken. The flag-OFF legacy-fallback test below overrides this to null.
  mockTryGetConductor.mockReturnValue(fakeConductor());
  return redis;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ── Signature verification (security envelope) ──────────────────────────────────

describe("verifyTwilioSignature (via POST /api/webhooks/whatsapp)", () => {
  it("returns 500 when TWILIO_AUTH_TOKEN / TWILIO_WEBHOOK_URL are not set", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_WEBHOOK_URL", "");

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SM123&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("not configured");
  });

  it("returns 400 when X-Twilio-Signature header is missing", async () => {
    wireHappyPath();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SM123&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Missing signature");
  });

  it("returns 403 when the Twilio signature is invalid", async () => {
    wireHappyPath();
    mockVerifyTwilioSignature.mockReturnValue(false);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "bad-signature",
      },
      payload: "MessageSid=SM123&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("Invalid signature");
  });

  it("proceeds past verification (200) when the signature is valid", async () => {
    wireHappyPath();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM123&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(200);
  });
});

// ── Field parsing / empty-message guard ─────────────────────────────────────────

describe("field parsing (via POST /api/webhooks/whatsapp)", () => {
  it("returns 200 <Response/> when the message has no body, media, or location", async () => {
    wireHappyPath();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM123&From=whatsapp%3A%2B5511999999999&NumMedia=0",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response/>");
  });

  it("returns 400 when From is missing", async () => {
    wireHappyPath();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM123&Body=hello",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Missing required fields");
  });
});

// ── Two-phase idempotency (P2-SEC-WAIDEMPOTENCY) ────────────────────────────────

describe("idempotency claim (via POST /api/webhooks/whatsapp)", () => {
  it("claims a new message with a short in-flight TTL (SET NX, 300s) and proceeds", async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    wireHappyPath(redis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_NEW&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(200);
    // Phase-1 claim is SET NX with the 300s in-flight TTL (the 24h dedup window
    // is promoted only on success, in the async confirm phase).
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining("SM_NEW"),
      "1",
      expect.objectContaining({ EX: 300, NX: true }),
    );
  });

  it("returns 200 <Response/> immediately for a duplicate (SET NX → null)", async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    wireHappyPath(redis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_DUP&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response/>");
  });
});

// ── Per-phone rate limit ────────────────────────────────────────────────────────

describe("rate limit (via POST /api/webhooks/whatsapp)", () => {
  it("allows messages under the limit (atomicIncr ≤ 20) → 200", async () => {
    wireHappyPath();
    mockAtomicIncr.mockResolvedValue(5);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_RATE&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 429 <Response/> when the rate limit is exceeded (atomicIncr > 20)", async () => {
    wireHappyPath();
    mockAtomicIncr.mockResolvedValue(21);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_RATELIM&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(429);
    expect(res.body).toContain("<Response/>");
  });
});

// ── Full routed integration (security envelope + conductor delegation) ───────────

describe("Full POST /api/webhooks/whatsapp integration (routed)", () => {
  it("returns 200 <Response/> immediately for a valid message (async turn is fire-and-forget)", async () => {
    wireHappyPath();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_VALID&From=whatsapp%3A%2B5511999999999&Body=Ola",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response/>");
  });

  it("uses atomicIncr for the rate limit with a 60s TTL (SEC-003)", async () => {
    const redis = wireHappyPath();

    const app = await buildTestServer();
    await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_FIRST&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(mockAtomicIncr).toHaveBeenCalledWith(
      redis,
      expect.stringContaining("rate"),
      60,
    );
  });

  it("delegates a valid message to the Conductor (perceive → openCapsule → handleTurn → render)", async () => {
    wireHappyPath();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_TURN&From=whatsapp%3A%2B5511999999999&Body=Quero+costela",
    });

    expect(res.statusCode).toBe(200);

    // The conductor turn runs fire-and-forget after the sync 200 — wait for it.
    await vi.waitFor(
      () => {
        expect(mockGetConductor).toHaveBeenCalled();
        expect(mockPerceive).toHaveBeenCalledTimes(1);
        expect(mockOpenCapsule).toHaveBeenCalledTimes(1);
        expect(mockHandleTurn).toHaveBeenCalledTimes(1);
        // A non-empty turn response is rendered back through the WA channel.
        expect(mockRender).toHaveBeenCalledTimes(1);
        expect(mockCloseCapsule).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
  });
});

