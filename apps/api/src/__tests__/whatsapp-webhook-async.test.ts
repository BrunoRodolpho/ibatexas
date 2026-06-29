// Unit tests for the WhatsApp webhook ASYNC handler (handleMessageAsync) and its
// helpers — the post-200, fire-and-forget pipeline the existing
// whatsapp-webhook-route.test.ts does NOT exercise.
//
// The route answers Twilio with 200 immediately, then runs the conductor turn in
// the background. We drive that background work through the HTTP route (the only
// exported surface) and assert on the mocked side-effects:
//   - media-only short-circuit
//   - per-message + per-conversation metrics (SEC-003 atomic INCR)
//   - new-customer welcome credit + hesitation nudge
//   - LGPD opt-in disclosure (once per phone)
//   - GPS location pin storage + synthesized location message
//   - interactive list/button selection → buildUserMessage
//   - claustrum Conductor turn (getConductor/handleTurn) success path
//   - PIX follow-up (copia-e-cola + QR + expiry monitor) from turn.acted
//   - turn failure → pt-BR fallback + idempotency claim RELEASE (Twilio retry)
//   - D2 bot-pause: human takeover suppresses the bot reply
//   - shortcut bypass (help) → no conductor turn
//   - post-lock retry for messages that arrived mid-turn
//
// Nothing real is touched: Conductor, Twilio, Redis, session store, jobs and the
// LLM are all mocked. The 2s debounce sleep is real time — slow tests carry an
// explicit per-test timeout.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import { mintRenderedReply } from "@adjudicate/core";
import { whatsappWebhookRoutes } from "../routes/whatsapp-webhook.js";

// EGRESS BRAND (E-1): sendText receives a branded RenderedReply (`{ text }` at
// runtime); match the body by its unwrapped text.
const textContaining = (sub: string) =>
  expect.objectContaining({ text: expect.stringContaining(sub) });

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockValidateRequest = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn());
const mockAtomicIncr = vi.hoisted(() => vi.fn());
const mockNormalizePhone = vi.hoisted(() => vi.fn());
const mockHashPhone = vi.hoisted(() => vi.fn());
const mockResolveWhatsAppSession = vi.hoisted(() => vi.fn());
const mockTouchSession = vi.hoisted(() => vi.fn());
const mockAcquireAgentLock = vi.hoisted(() => vi.fn());
const mockReleaseAgentLock = vi.hoisted(() => vi.fn());
const mockTryDebounce = vi.hoisted(() => vi.fn());
const mockHasOptedIn = vi.hoisted(() => vi.fn());
const mockMarkOptedIn = vi.hoisted(() => vi.fn());
const mockSetWelcomeCredit = vi.hoisted(() => vi.fn());
const mockStoreLastLocation = vi.hoisted(() => vi.fn());
const mockGetLastLocation = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockSendMedia = vi.hoisted(() => vi.fn());
const mockMatchShortcut = vi.hoisted(() => vi.fn());
const mockBuildHelpText = vi.hoisted(() => vi.fn());
const mockBuildWelcomeText = vi.hoisted(() => vi.fn());
const mockLoadSession = vi.hoisted(() => vi.fn());
const mockAppendMessages = vi.hoisted(() => vi.fn());
const mockScheduleHesitationNudge = vi.hoisted(() => vi.fn());
const mockMarkCustomerReplied = vi.hoisted(() => vi.fn());
const mockSchedulePixExpiryMonitor = vi.hoisted(() => vi.fn());
const mockGetConductor = vi.hoisted(() => vi.fn());
const mockHandleTurn = vi.hoisted(() => vi.fn());
const mockIsSessionPausedForHuman = vi.hoisted(() => vi.fn());

vi.mock("twilio", () => ({
  default: Object.assign(() => ({}), { validateRequest: mockValidateRequest }),
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
}));

vi.mock("../escalation/escalation-store.js", () => ({
  isSessionPausedForHuman: mockIsSessionPausedForHuman,
}));

vi.mock("../session/store.js", () => ({
  loadSession: mockLoadSession,
  appendMessages: mockAppendMessages,
}));

vi.mock("../whatsapp/session.js", () => ({
  normalizePhone: mockNormalizePhone,
  hashPhone: mockHashPhone,
  resolveWhatsAppSession: mockResolveWhatsAppSession,
  touchSession: mockTouchSession,
  acquireAgentLock: mockAcquireAgentLock,
  releaseAgentLock: mockReleaseAgentLock,
  tryDebounce: mockTryDebounce,
  hasOptedIn: mockHasOptedIn,
  markOptedIn: mockMarkOptedIn,
  setWelcomeCredit: mockSetWelcomeCredit,
  storeLastLocation: mockStoreLastLocation,
  getLastLocation: mockGetLastLocation,
}));

vi.mock("../whatsapp/client.js", () => ({
  sendText: mockSendText,
  sendMedia: mockSendMedia,
}));

vi.mock("../whatsapp/shortcuts.js", () => ({
  matchShortcut: mockMatchShortcut,
  buildHelpText: mockBuildHelpText,
  buildWelcomeText: mockBuildWelcomeText,
}));

vi.mock("../whatsapp/constants.js", () => ({
  LGPD_OPTIN_MESSAGE: "Aviso LGPD: ao continuar você concorda com nossa política.",
}));

vi.mock("../jobs/hesitation-nudge.js", () => ({
  scheduleHesitationNudge: mockScheduleHesitationNudge,
  markCustomerReplied: mockMarkCustomerReplied,
}));

vi.mock("../jobs/pix-expiry-monitor.js", () => ({
  schedulePixExpiryMonitor: mockSchedulePixExpiryMonitor,
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const PHONE = "+5511999999999";
const HASH = "phonehash-abc";

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

let mockRedis: ReturnType<typeof createMockRedis>;

async function buildTestServer() {
  const app = Fastify({ logger: false });
  await app.register(whatsappWebhookRoutes);
  await app.ready();
  return app;
}

function post(app: Awaited<ReturnType<typeof buildTestServer>>, payload: string) {
  return app.inject({
    method: "POST",
    url: "/api/webhooks/whatsapp",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "valid-sig",
    },
    payload,
  });
}

const ORIG_ENV = { token: process.env.TWILIO_AUTH_TOKEN, url: process.env.TWILIO_WEBHOOK_URL };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
  vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.com/api/webhooks/whatsapp");

  // Signature + field parsing (synchronous route preamble)
  mockValidateRequest.mockReturnValue(true);
  mockNormalizePhone.mockReturnValue(PHONE);
  mockHashPhone.mockReturnValue(HASH);
  mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
  mockAtomicIncr.mockResolvedValue(1); // under the rate limit + metrics counters

  mockRedis = createMockRedis();
  mockGetRedisClient.mockResolvedValue(mockRedis);

  // Async handler defaults (existing customer, opted in, no shortcut, lock free)
  mockMarkCustomerReplied.mockResolvedValue(undefined);
  mockResolveWhatsAppSession.mockResolvedValue({
    phone: PHONE,
    sessionId: "sess-1",
    customerId: "cus-1",
    isNew: false,
  });
  mockTouchSession.mockResolvedValue(undefined);
  mockHasOptedIn.mockResolvedValue(true);
  mockMarkOptedIn.mockResolvedValue(undefined);
  mockSetWelcomeCredit.mockResolvedValue(undefined);
  mockScheduleHesitationNudge.mockResolvedValue(undefined);
  mockStoreLastLocation.mockResolvedValue(undefined);
  mockGetLastLocation.mockResolvedValue(null);
  mockSchedulePixExpiryMonitor.mockResolvedValue(undefined);
  mockTryDebounce.mockResolvedValue(false); // default: skip the conductor turn (no sleep)
  mockAcquireAgentLock.mockResolvedValue("lock-uuid");
  mockReleaseAgentLock.mockResolvedValue(undefined);
  mockMatchShortcut.mockReturnValue(null);
  mockBuildHelpText.mockReturnValue("Aqui estão os comandos disponíveis.");
  mockBuildWelcomeText.mockReturnValue("Bem-vindo ao IbateXas!");
  // last message is assistant → post-lock retry is a no-op unless a test overrides
  mockLoadSession.mockResolvedValue([
    { role: "user", content: "oi" },
    { role: "assistant", content: "resposta anterior" },
  ]);
  mockAppendMessages.mockResolvedValue(undefined);
  mockSendText.mockResolvedValue(undefined);
  mockSendMedia.mockResolvedValue(undefined);
  mockIsSessionPausedForHuman.mockResolvedValue(false);
  mockGetConductor.mockReturnValue({
    openCapsule: vi.fn().mockResolvedValue({ id: "capsule-1" }),
    closeCapsule: vi.fn().mockResolvedValue(undefined),
  });
  mockHandleTurn.mockResolvedValue({
    response: { text: "Resposta padrão" },
    acted: null,
    decision: { kind: "EXECUTE" },
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
  if (ORIG_ENV.token === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = ORIG_ENV.token;
  if (ORIG_ENV.url === undefined) delete process.env.TWILIO_WEBHOOK_URL;
  else process.env.TWILIO_WEBHOOK_URL = ORIG_ENV.url;
});

// ── Media short-circuit ──────────────────────────────────────────────────────

describe("handleMessageAsync — media handling", () => {
  it("replies with a pt-BR 'can't process media' message and skips session resolution", async () => {
    const app = await buildTestServer();
    const res = await post(
      app,
      "MessageSid=SM_MEDIA&From=whatsapp%3A%2B5511999999999&NumMedia=1&MediaUrl0=http%3A%2F%2Fx.jpg&MediaContentType0=image%2Fjpeg",
    );
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockSendText).toHaveBeenCalledWith(
        `whatsapp:${PHONE}`,
        textContaining("Recebi sua mídia"),
      );
    }, { timeout: 2000 });

    // Media-only path returns BEFORE resolving a session / running the agent.
    expect(mockResolveWhatsAppSession).not.toHaveBeenCalled();
    expect(mockHandleTurn).not.toHaveBeenCalled();
  });
});

// ── Pre-turn pipeline (debounce skip avoids the 2s sleep) ─────────────────────

describe("handleMessageAsync — new customer onboarding (debounce-skip path)", () => {
  it("tracks daily conversation + message metrics, sets welcome credit, schedules nudge, sends LGPD once", async () => {
    mockResolveWhatsAppSession.mockResolvedValue({
      phone: PHONE,
      sessionId: "sess-new",
      customerId: "cus-new",
      isNew: true,
    });
    mockHasOptedIn.mockResolvedValue(false); // first contact → LGPD disclosure fires

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_NEW&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    // The claim is released at the end of the debounce-skip path (succeeded=false).
    await vi.waitFor(() => {
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining("SM_NEW"));
    }, { timeout: 2000 });

    const incrKeys = mockAtomicIncr.mock.calls.map((c) => String(c[1]));
    // New session → daily-conversation counter (48h TTL) AND per-session msg counter.
    expect(incrKeys.some((k) => k.includes("conversations:daily"))).toBe(true);
    expect(mockAtomicIncr).toHaveBeenCalledWith(
      mockRedis,
      expect.stringContaining("conversations:daily"),
      48 * 60 * 60,
    );
    expect(incrKeys.some((k) => k.includes("messages:sess-new"))).toBe(true);

    // New-customer onboarding side effects
    expect(mockSetWelcomeCredit).toHaveBeenCalledWith("cus-new");
    expect(mockScheduleHesitationNudge).toHaveBeenCalledWith(
      expect.objectContaining({ phone: PHONE, phoneHash: HASH, customerId: "cus-new" }),
    );

    // LGPD opt-in disclosure sent + marked
    expect(mockSendText).toHaveBeenCalledWith(`whatsapp:${PHONE}`, textContaining("LGPD"));
    expect(mockMarkOptedIn).toHaveBeenCalledWith(HASH);

    // Inbound user message persisted to the session
    expect(mockAppendMessages).toHaveBeenCalledWith(
      "sess-new",
      expect.arrayContaining([expect.objectContaining({ role: "user", content: "oi" })]),
      true,
      expect.objectContaining({ customerId: "cus-new", channel: "whatsapp" }),
    );

    // Debounce skip returns before the agent lock is acquired
    expect(mockAcquireAgentLock).not.toHaveBeenCalled();
  });

  it("existing opted-in customer: no welcome credit, no LGPD message, no daily-conversation counter", async () => {
    // defaults already model an existing (isNew:false), opted-in customer
    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_EXIST&From=whatsapp%3A%2B5511999999999&Body=ola");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining("SM_EXIST"));
    }, { timeout: 2000 });

    expect(mockSetWelcomeCredit).not.toHaveBeenCalled();
    expect(mockScheduleHesitationNudge).not.toHaveBeenCalled();
    expect(mockMarkOptedIn).not.toHaveBeenCalled();
    const incrKeys = mockAtomicIncr.mock.calls.map((c) => String(c[1]));
    expect(incrKeys.some((k) => k.includes("conversations:daily"))).toBe(false);
    expect(incrKeys.some((k) => k.includes("messages:sess-1"))).toBe(true);
  });
});

describe("handleMessageAsync — GPS location pin", () => {
  it("stores the pin and synthesizes a pt-BR location message when the body is empty", async () => {
    const app = await buildTestServer();
    const res = await post(
      app,
      "MessageSid=SM_LOC&From=whatsapp%3A%2B5511999999999&Latitude=-23.55&Longitude=-46.63",
    );
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockStoreLastLocation).toHaveBeenCalledWith(HASH, -23.55, -46.63);
    }, { timeout: 2000 });

    expect(mockAppendMessages).toHaveBeenCalledWith(
      "sess-1",
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("localização compartilhada: lat=-23.55, lng=-46.63"),
        }),
      ]),
      true,
      expect.objectContaining({ channel: "whatsapp" }),
    );
  });
});

describe("handleMessageAsync — interactive selection (buildUserMessage)", () => {
  it("encodes a list selection into the persisted user message", async () => {
    const app = await buildTestServer();
    const res = await post(
      app,
      "MessageSid=SM_LIST&From=whatsapp%3A%2B5511999999999&Body=Costela&ListId=opt-1&ListTitle=Costela+Defumada",
    );
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockAppendMessages).toHaveBeenCalledWith(
        "sess-1",
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("[interactive_selection: type=list, id=opt-1]"),
          }),
        ]),
        true,
        expect.anything(),
      );
    }, { timeout: 2000 });

    const userAppend = mockAppendMessages.mock.calls.find((c) =>
      String((c[1] as Array<{ content?: string }>)[0]?.content).includes("interactive_selection"),
    );
    expect(String((userAppend?.[1] as Array<{ content?: string }>)[0]?.content)).toContain(
      "Usuário selecionou: Costela Defumada",
    );
  });
});

// ── Conductor turn (tryDebounce=true → real 2s debounce sleep) ────────────────

describe("handleMessageAsync — conductor turn", () => {
  beforeEach(() => {
    mockTryDebounce.mockResolvedValue(true); // become the runner → run the agent
  });

  it("runs one conductor turn, sends the response, persists it, and CONFIRMS idempotency (24h)", async () => {
    mockHandleTurn.mockResolvedValue({
      response: { text: "Olá! Como posso ajudar você hoje?" },
      acted: null,
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_OK&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      // Phase 3a: claim promoted to the full 24h dedup window on success.
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining("SM_OK"),
        "1",
        { EX: 86400 },
      );
    }, { timeout: 4000 });

    const conductor = mockGetConductor.mock.results[0]?.value as {
      openCapsule: ReturnType<typeof vi.fn>;
      closeCapsule: ReturnType<typeof vi.fn>;
    };
    expect(conductor.openCapsule).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "whatsapp", sessionKey: "sess-1" }),
    );
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(conductor.closeCapsule).toHaveBeenCalled();

    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("Olá! Como posso ajudar você hoje?"),
    );
    expect(mockAppendMessages).toHaveBeenCalledWith(
      "sess-1",
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "Olá! Como posso ajudar você hoje?" }),
      ]),
      true,
      expect.objectContaining({ customerId: "cus-1", channel: "whatsapp" }),
    );
    expect(mockReleaseAgentLock).toHaveBeenCalledWith(HASH, "lock-uuid");
    // Success path never releases (DELs) the claim.
    expect(mockRedis.del).not.toHaveBeenCalled();
  }, 15000);

  it("extracts PIX artifacts from turn.acted and sends copia-e-cola + QR + schedules expiry monitor", async () => {
    mockHandleTurn.mockResolvedValue({
      response: { text: "Pedido confirmado! Aqui está o pagamento." },
      acted: {
        kind: "executed",
        result: {
          pixCopyPaste: "00020126PIX-COPIA-E-COLA-CODE",
          pixQrCode: "data:image/png;base64,QR",
          pixExpiresAt: "2026-06-28T23:59:00Z",
          orderId: "ord-42",
        },
      },
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_PIX&From=whatsapp%3A%2B5511999999999&Body=pagar");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockSchedulePixExpiryMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ phone: PHONE, phoneHash: HASH, orderId: "ord-42" }),
      );
    }, { timeout: 4000 });

    // Agent text was sent first, then the PIX copia-e-cola block (text omitted the code).
    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("Pedido confirmado! Aqui está o pagamento."),
    );
    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      textContaining("Código PIX (copia e cola)"),
    );
    const pixBlock = mockSendText.mock.calls.find((c) =>
      (c[1] as { text: string }).text.includes("Código PIX (copia e cola)"),
    );
    expect((pixBlock?.[1] as { text: string } | undefined)?.text).toContain(
      "00020126PIX-COPIA-E-COLA-CODE",
    );
    // QR sent as media
    expect(mockSendMedia).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      "data:image/png;base64,QR",
      "QR Code PIX",
    );
  }, 15000);

  it("on turn failure: sends the pt-BR fallback and RELEASES the claim so Twilio retries", async () => {
    mockHandleTurn.mockRejectedValue(new Error("LLM provider unavailable"));

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_FAIL&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining("SM_FAIL"));
    }, { timeout: 4000 });

    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      textContaining("problema técnico"),
    );
    // Failure path must NOT promote the claim to the 24h window.
    expect(mockRedis.set).not.toHaveBeenCalledWith(
      expect.stringContaining("SM_FAIL"),
      "1",
      { EX: 86400 },
    );
    expect(mockReleaseAgentLock).toHaveBeenCalledWith(HASH, "lock-uuid");
  }, 15000);

  it("D2 bot-pause: a human takeover suppresses the bot reply but still confirms idempotency", async () => {
    mockIsSessionPausedForHuman.mockResolvedValue(true);

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_PAUSE&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining("SM_PAUSE"),
        "1",
        { EX: 86400 },
      );
    }, { timeout: 4000 });

    // Paused → the conductor is never opened and no reply text is sent.
    expect(mockHandleTurn).not.toHaveBeenCalled();
    expect(mockSendText).not.toHaveBeenCalled();
  }, 15000);

  it("shortcut (help) replies directly and bypasses the conductor; claim is released", async () => {
    mockMatchShortcut.mockReturnValue({ type: "help" });
    mockBuildHelpText.mockReturnValue("Comandos: cardápio, carrinho, ajuda.");

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_HELP&From=whatsapp%3A%2B5511999999999&Body=ajuda");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockSendText).toHaveBeenCalledWith(
        `whatsapp:${PHONE}`,
        mintRenderedReply("Comandos: cardápio, carrinho, ajuda."),
      );
    }, { timeout: 4000 });

    expect(mockHandleTurn).not.toHaveBeenCalled();
    // Shortcut path returns before marking success → claim released.
    await vi.waitFor(() => {
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining("SM_HELP"));
    }, { timeout: 1000 });
  }, 15000);

  it("post-lock retry re-runs the agent once when a user message arrived mid-turn", async () => {
    // Every loadSession returns a user-last history → the post-lock re-check fires
    // and re-runs the conductor exactly once.
    mockLoadSession.mockResolvedValue([{ role: "user", content: "esqueci de adicionar a bebida" }]);
    mockHandleTurn.mockResolvedValue({
      response: { text: "Claro, vou adicionar." },
      acted: null,
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_RETRY&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      // Main turn + one retry turn.
      expect(mockHandleTurn).toHaveBeenCalledTimes(2);
    }, { timeout: 4000 });

    // Lock acquired for the main turn AND re-acquired for the retry.
    expect(mockAcquireAgentLock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockSendText).toHaveBeenCalledWith(`whatsapp:${PHONE}`, mintRenderedReply("Claro, vou adicionar."));
  }, 15000);
});
