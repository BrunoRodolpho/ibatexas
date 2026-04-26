// Unit tests for WhatsApp webhook route
// POST /api/webhooks/whatsapp — Twilio incoming message webhook

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { whatsappWebhookRoutes } from "../routes/whatsapp-webhook.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockValidateRequest = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockAtomicIncr = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn());
const mockRunAgent = vi.hoisted(() => vi.fn());
const mockNormalizePhone = vi.hoisted(() => vi.fn());
const mockHashPhone = vi.hoisted(() => vi.fn());
const mockResolveWhatsAppSession = vi.hoisted(() => vi.fn());
const mockBuildWhatsAppContext = vi.hoisted(() => vi.fn());
const mockTouchSession = vi.hoisted(() => vi.fn());
const mockAcquireAgentLock = vi.hoisted(() => vi.fn());
const mockReleaseAgentLock = vi.hoisted(() => vi.fn());
const mockTryDebounce = vi.hoisted(() => vi.fn());
const mockHasOptedIn = vi.hoisted(() => vi.fn());
const mockMarkOptedIn = vi.hoisted(() => vi.fn());
const mockCollectAgentResponse = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockMatchShortcut = vi.hoisted(() => vi.fn());
const mockBuildHelpText = vi.hoisted(() => vi.fn());
const mockLoadSession = vi.hoisted(() => vi.fn());
const mockAppendMessages = vi.hoisted(() => vi.fn());

vi.mock("twilio", () => ({
  default: Object.assign(() => ({}), { validateRequest: mockValidateRequest }),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  atomicIncr: mockAtomicIncr,
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: mockPublishNatsEvent,
}));

vi.mock("@ibx/intent-runtime", () => ({
  runOrchestrator: mockRunAgent,
}));

vi.mock("../session/store.js", () => ({
  loadSession: mockLoadSession,
  appendMessages: mockAppendMessages,
}));

vi.mock("../whatsapp/session.js", () => ({
  normalizePhone: mockNormalizePhone,
  hashPhone: mockHashPhone,
  resolveWhatsAppSession: mockResolveWhatsAppSession,
  buildWhatsAppContext: mockBuildWhatsAppContext,
  touchSession: mockTouchSession,
  acquireAgentLock: mockAcquireAgentLock,
  releaseAgentLock: mockReleaseAgentLock,
  tryDebounce: mockTryDebounce,
  hasOptedIn: mockHasOptedIn,
  markOptedIn: mockMarkOptedIn,
  storeLastLocation: vi.fn().mockResolvedValue(undefined),
  getLastLocation: vi.fn().mockResolvedValue(null),
  isMessageDuplicate: vi.fn().mockResolvedValue(false),
  setWelcomeCredit: vi.fn().mockResolvedValue(undefined),
  getAndConsumeWelcomeCredit: vi.fn().mockResolvedValue(null),
}));

vi.mock("../whatsapp/formatter.js", () => ({
  collectAgentResponse: mockCollectAgentResponse,
}));

vi.mock("../whatsapp/client.js", () => ({
  sendText: mockSendText,
  sendMedia: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../whatsapp/shortcuts.js", () => ({
  matchShortcut: mockMatchShortcut,
  buildHelpText: mockBuildHelpText,
  buildWelcomeText: vi.fn().mockReturnValue("Bem-vindo!"),
}));


vi.mock("../jobs/hesitation-nudge.js", () => ({
  scheduleHesitationNudge: vi.fn().mockResolvedValue(undefined),
  markCustomerReplied: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../jobs/pix-expiry-monitor.js", () => ({
  schedulePixExpiryMonitor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../whatsapp/constants.js", () => ({
  LGPD_OPTIN_MESSAGE: "Mensagem LGPD mock",
}));

// ── Server factory ─────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  await app.register(whatsappWebhookRoutes);
  await app.ready();
  return app;
}

// ── Mock Redis client ─────────────────────────────────────────────────────────

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function setupEnv() {
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.com/api/webhooks/whatsapp");
}

function _validBody() {
  return {
    MessageSid: "SM12345",
    From: "whatsapp:+5511999999999",
    To: "whatsapp:+5511888888888",
    Body: "Oi, quero ver o cardapio",
    NumMedia: "0",
    ProfileName: "Test User",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("verifyTwilioSignature (via POST /api/webhooks/whatsapp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1);
  });

  it("returns 500 when TWILIO_AUTH_TOKEN is not set", async () => {
    // Do NOT set TWILIO_AUTH_TOKEN
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
    const body = res.json();
    expect(body.error).toContain("not configured");
  });

  it("returns 400 when X-Twilio-Signature header is missing", async () => {
    setupEnv();

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "MessageSid=SM123&From=whatsapp%3A%2B5511999999999&Body=oi",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain("Missing signature");
  });

  it("returns 403 when Twilio signature is invalid", async () => {
    setupEnv();
    mockValidateRequest.mockReturnValue(false);

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
    const body = res.json();
    expect(body.error).toContain("Invalid signature");
  });

  it("returns null (passes validation) when signature is valid", async () => {
    setupEnv();
    mockValidateRequest.mockReturnValue(true);
    mockNormalizePhone.mockReturnValue("+5511999999999");
    mockHashPhone.mockReturnValue("abc123def456");

    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

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

    // Valid signature should proceed past verification (200 XML or further processing)
    expect(res.statusCode).toBe(200);
  });
});

describe("parseIncomingFields (via POST /api/webhooks/whatsapp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockValidateRequest.mockReturnValue(true);
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1);
  });

  it("returns 200 XML when MessageSid and Body are empty (empty message guard)", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      // Body is empty and NumMedia is 0
      payload: "MessageSid=SM123&From=whatsapp%3A%2B5511999999999&NumMedia=0",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response/>");
  });

  it("returns 400 when From is missing", async () => {
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

    // Missing From → parseIncomingFields returns null → 400
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain("Missing required fields");
  });

  it("returns 400 when phone format is invalid", async () => {
    mockNormalizePhone.mockImplementation(() => {
      throw new Error("Invalid phone format");
    });

    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM123&From=invalid-phone&Body=oi",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain("Invalid phone format");
  });
});

describe("checkIdempotency (via POST /api/webhooks/whatsapp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockValidateRequest.mockReturnValue(true);
    mockNormalizePhone.mockReturnValue("+5511999999999");
    mockHashPhone.mockReturnValue("abc123def456");
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1);
  });

  it("processes new message (not duplicate)", async () => {
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue("OK") });
    mockGetRedisClient.mockResolvedValue(mockRedis);

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
    // Idempotency key was set
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("SM_NEW"),
      "1",
      expect.objectContaining({ EX: 86400, NX: true }),
    );
  });

  it("returns 200 XML immediately for duplicate message", async () => {
    // SET NX returns null for duplicates
    const mockRedis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    mockGetRedisClient.mockResolvedValue(mockRedis);

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

describe("checkWebhookRateLimit (via POST /api/webhooks/whatsapp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockValidateRequest.mockReturnValue(true);
    mockNormalizePhone.mockReturnValue("+5511999999999");
    mockHashPhone.mockReturnValue("abc123def456");
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1);
  });

  it("allows messages under rate limit", async () => {
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(5); // under 20

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

  it("returns 429 XML when rate limit is exceeded", async () => {
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(21); // over 20
    mockNormalizePhone.mockReturnValue("+5511999999999");
    mockHashPhone.mockReturnValue("abc123");
    mockSendText.mockResolvedValue(undefined);

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

describe("buildUserMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockValidateRequest.mockReturnValue(true);
    mockNormalizePhone.mockReturnValue("+5511999999999");
    mockHashPhone.mockReturnValue("abc123def456");
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1);
  });

  // buildUserMessage is tested indirectly through async handler.
  // We can test list selection and button selection via the body payload.

  it("passes plain text through to async handler", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);

    mockResolveWhatsAppSession.mockResolvedValue({
      phone: "+5511999999999",
      sessionId: "sess-123",
      customerId: "cus-123",
      isNew: false,
    });
    mockTouchSession.mockResolvedValue(undefined);
    mockHasOptedIn.mockResolvedValue(true);
    mockMarkOptedIn.mockResolvedValue(undefined);
    mockAppendMessages.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockTryDebounce.mockResolvedValue(true);
    mockAcquireAgentLock.mockResolvedValue(true);
    mockMatchShortcut.mockReturnValue(null);
    mockLoadSession.mockResolvedValue([]);
    mockBuildWhatsAppContext.mockReturnValue({});
    mockCollectAgentResponse.mockResolvedValue({ text: "Resposta", toolsUsed: [] });
    mockSendText.mockResolvedValue(undefined);
    mockReleaseAgentLock.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_PLAIN&From=whatsapp%3A%2B5511999999999&Body=Quero+costela",
    });

    expect(res.statusCode).toBe(200);
    // The message should be appended as-is (no interactive selection)
    await vi.waitFor(() => {
      expect(mockAppendMessages).toHaveBeenCalledWith(
        "sess-123",
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Quero costela" }),
        ]),
        true,
        expect.objectContaining({ customerId: "cus-123", channel: "whatsapp" }),
      );
    }, { timeout: 500 });
  });
});

describe("handleShortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockValidateRequest.mockReturnValue(true);
    mockNormalizePhone.mockReturnValue("+5511999999999");
    mockHashPhone.mockReturnValue("abc123def456");
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1);
  });

  it("dispatches help shortcut and returns 200", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMatchShortcut.mockReturnValue({ type: "help" });
    mockBuildHelpText.mockReturnValue("Texto de ajuda");
    // Stub async handler deps so fire-and-forget doesn't throw
    mockResolveWhatsAppSession.mockResolvedValue({ phone: "+5511999999999", sessionId: "s", customerId: "c", isNew: false });
    mockTouchSession.mockResolvedValue(undefined);
    mockHasOptedIn.mockResolvedValue(true);
    mockAppendMessages.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockTryDebounce.mockResolvedValue(false); // Skip async processing
    mockSendText.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid-sig" },
      payload: "MessageSid=SM_HELP&From=whatsapp%3A%2B5511999999999&Body=ajuda",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response/>");
  });

  it("resolves session for menu shortcut and returns 200", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockMatchShortcut.mockReturnValue({ type: "menu" });
    mockResolveWhatsAppSession.mockResolvedValue({ phone: "+5511999999999", sessionId: "s", customerId: "c", isNew: false });
    mockTouchSession.mockResolvedValue(undefined);
    mockHasOptedIn.mockResolvedValue(true);
    mockAppendMessages.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockTryDebounce.mockResolvedValue(false); // Skip debounce processing
    mockSendText.mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "valid-sig" },
      payload: "MessageSid=SM_MENU&From=whatsapp%3A%2B5511999999999&Body=menu",
    });

    expect(res.statusCode).toBe(200);
    expect(mockResolveWhatsAppSession).toHaveBeenCalledWith("+5511999999999");
  });
});

describe("Full POST /api/webhooks/whatsapp integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    setupEnv();
    mockValidateRequest.mockReturnValue(true);
    mockNormalizePhone.mockReturnValue("+5511999999999");
    mockHashPhone.mockReturnValue("abc123def456");
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1);
  });

  it("returns 200 XML immediately for valid message", async () => {
    const mockRedis = createMockRedis();
    mockGetRedisClient.mockResolvedValue(mockRedis);
    // Stub all async handler deps to avoid unhandled rejections
    mockResolveWhatsAppSession.mockResolvedValue({ phone: "+5511999999999", sessionId: "s", customerId: "c", isNew: false });
    mockTouchSession.mockResolvedValue(undefined);
    mockHasOptedIn.mockResolvedValue(true);
    mockAppendMessages.mockResolvedValue(undefined);
    mockPublishNatsEvent.mockResolvedValue(undefined);
    mockTryDebounce.mockResolvedValue(false); // Skip debounce to avoid sleep
    mockSendText.mockResolvedValue(undefined);

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

    // Route returns 200 immediately (async processing is fire-and-forget)
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response/>");
  });

  it("returns 200 XML for empty body with no media", async () => {
    const app = await buildTestServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/whatsapp",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-sig",
      },
      payload: "MessageSid=SM_EMPTY&From=whatsapp%3A%2B5511999999999&NumMedia=0",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response/>");
  });

  it("uses atomicIncr for rate limit with 60s TTL (SEC-003)", async () => {
    const mockRedis = createMockRedis({
      set: vi.fn().mockResolvedValue("OK"),
    });
    mockGetRedisClient.mockResolvedValue(mockRedis);
    mockAtomicIncr.mockResolvedValue(1); // first message

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

    // atomicIncr should be called with the rate key and 60s TTL
    expect(mockAtomicIncr).toHaveBeenCalledWith(
      mockRedis,
      expect.stringContaining("rate"),
      60,
    );
  });
});
