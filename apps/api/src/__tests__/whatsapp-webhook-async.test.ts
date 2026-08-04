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
// B4: cart pre-ensure before the conductor turn (mirrors chat.ts BKL-066).
const mockGetOrCreateCart = vi.hoisted(() => vi.fn());
const mockIsSessionPausedForHuman = vi.hoisted(() => vi.fn());
// W1 Redis-outage fix: the webhook gate now reads the store via readPauseState
// (real, kept below) → getEscalationStore().isPaused(), so it can DISTINGUISH a
// genuine pause from a Redis read-error.
const mockIsPaused = vi.hoisted(() => vi.fn());
const mockGetEscalationStore = vi.hoisted(() => vi.fn());
// W1 no-reply seam: keep the PURE classifiers real; mock only the side-effecting
// collaborators (NATS emit + governed open) and the auto-close (M3/L10).
const mockEmitNoDelivery = vi.hoisted(() => vi.fn());
const mockOpenIncidentInline = vi.hoisted(() => vi.fn());
const mockCloseIncidentOnDeliveredReply = vi.hoisted(() => vi.fn());
// BKL-086 ops-actor fork — mocked so the CUSTOMER-path regression tests below run
// byte-identically (default {consumed:false} ⇒ fall through). The fork's own logic
// is proven in ops-whatsapp-ingress*.test.ts.
const mockHandleOpsWhatsAppMessage = vi.hoisted(() => vi.fn());
const mockBuildOpsWhatsAppIngressDeps = vi.hoisted(() => vi.fn());

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
  getOrCreateCart: mockGetOrCreateCart,
}));

vi.mock("../claustrum-bootstrap.js", () => ({
  getConductor: mockGetConductor,
}));

vi.mock("../escalation/escalation-store.js", () => ({
  isSessionPausedForHuman: mockIsSessionPausedForHuman,
  getEscalationStore: mockGetEscalationStore,
}));

vi.mock("../conversation/no-delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../conversation/no-delivery.js")>();
  return {
    ...actual, // keep classifyTurnDelivery + classifyCatchError (pure) + the types
    emitNoDelivery: mockEmitNoDelivery,
    openIncidentInline: mockOpenIncidentInline,
  };
});

vi.mock("../incidents/incident-auto-close.js", () => ({
  closeIncidentOnDeliveredReply: mockCloseIncidentOnDeliveredReply,
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

vi.mock("../ops/ops-whatsapp-ingress.js", () => ({
  handleOpsWhatsAppMessage: mockHandleOpsWhatsAppMessage,
  buildOpsWhatsAppIngressDeps: mockBuildOpsWhatsAppIngressDeps,
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const PHONE = "+5511999999999";
const HASH = "phonehash-abc";

/**
 * LE2-030 — every conductor-turn send now carries a THIRD argument: the turn
 * correlation `{ turnId, conversationId }` the delivery store joins the captured
 * Twilio SID on. Matched loosely so these assertions stay about the MESSAGE, not
 * about ids the individual fixtures happen to set. Sends with no conductor turn
 * (shortcuts, the holding message, the apology) still pass two arguments.
 */
const CORR = expect.objectContaining({ conversationId: expect.any(String) });

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
  mockIsPaused.mockResolvedValue(false);
  mockGetEscalationStore.mockResolvedValue({ isPaused: mockIsPaused });
  mockGetOrCreateCart.mockResolvedValue({
    cartId: "cart_pre_1",
    items: [],
    total: 0,
    message: "Carrinho vazio pronto para adicionar itens.",
  });
  mockGetConductor.mockReturnValue({
    openCapsule: vi.fn().mockResolvedValue({ id: "capsule-1" }),
    closeCapsule: vi.fn().mockResolvedValue(undefined),
  });
  mockHandleTurn.mockResolvedValue({
    response: { text: "Resposta padrão" },
    acted: null,
    decision: { kind: "EXECUTE" },
  });
  mockEmitNoDelivery.mockResolvedValue(undefined);
  mockOpenIncidentInline.mockResolvedValue({ kind: "opened", incidentId: "inc-1" });
  mockCloseIncidentOnDeliveredReply.mockResolvedValue(undefined);
  // Default: not a staff phone → the ops fork falls through to the customer path.
  mockBuildOpsWhatsAppIngressDeps.mockReturnValue({});
  mockHandleOpsWhatsAppMessage.mockResolvedValue({ consumed: false });
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

    // B4 (the D-014 WhatsApp plane): the Medusa cart pre-ensure ran BEFORE the
    // conductor turn, keyed by the SAME sessionId the resolver reads
    // (cart:active:session:<sessionKey> ← cognition.conversationId === "sess-1"),
    // so a fresh session's order.item.add adjudicates against a real cart.
    expect(mockGetOrCreateCart).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateCart).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channel: "whatsapp",
        sessionId: "sess-1",
        customerId: "cus-1",
        userType: "customer",
      }),
    );
    const preEnsureOrder = mockGetOrCreateCart.mock.invocationCallOrder[0]!;
    const turnOrder = mockHandleTurn.mock.invocationCallOrder[0]!;
    expect(preEnsureOrder).toBeLessThan(turnOrder);

    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("Olá! Como posso ajudar você hoje?"),
      CORR,
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

  it("B4: a guest session pre-ensures the cart WITHOUT a customerId (userType guest)", async () => {
    mockResolveWhatsAppSession.mockResolvedValue({
      phone: PHONE,
      sessionId: "sess-guest",
      customerId: "", // no real customer → guest marker path
      isNew: false,
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_GUEST&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockGetOrCreateCart).toHaveBeenCalledTimes(1);
    }, { timeout: 4000 });

    expect(mockGetOrCreateCart).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        channel: "whatsapp",
        sessionId: "sess-guest",
        userType: "guest",
      }),
    );
    // The guest marker must NOT be forwarded as a customerId.
    const ctx = mockGetOrCreateCart.mock.calls[0]![1] as Record<string, unknown>;
    expect(ctx.customerId).toBeUndefined();
  }, 15000);

  it("B4: a cart pre-ensure failure is non-fatal — the turn still runs and replies", async () => {
    mockGetOrCreateCart.mockRejectedValue(new Error("medusa down"));
    mockHandleTurn.mockResolvedValue({
      response: { text: "Resposta mesmo sem carrinho" },
      acted: null,
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_CARTFAIL&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockSendText).toHaveBeenCalledWith(
        `whatsapp:${PHONE}`,
        mintRenderedReply("Resposta mesmo sem carrinho"),
        CORR,
      );
    }, { timeout: 4000 });
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
  }, 15000);

  it("extracts PIX artifacts from turn.acted and sends copia-e-cola + QR + schedules expiry monitor", async () => {
    mockHandleTurn.mockResolvedValue({
      response: { text: "Pedido confirmado! Aqui está o pagamento." },
      acted: {
        kind: "executed",
        // The real `createCheckout` PIX return shape: `orderId` is the CLIENT
        // tracking id and holds the same `pi_…` value, because the Medusa order
        // is created later by the Stripe webhook.
        result: {
          pixCopyPaste: "00020126PIX-COPIA-E-COLA-CODE",
          pixQrCode: "data:image/png;base64,QR",
          pixExpiresAt: "2026-06-28T23:59:00Z",
          paymentIntentId: "pi_3Rpix42",
          orderId: "pi_3Rpix42",
        },
      },
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_PIX&From=whatsapp%3A%2B5511999999999&Body=pagar");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      // BKL-241: scheduled under the PaymentIntent id — the id the Stripe
      // webhook writes the `pix:paid:` marker under, so payment silences it.
      expect(mockSchedulePixExpiryMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ phone: PHONE, phoneHash: HASH, paymentIntentId: "pi_3Rpix42" }),
      );
    }, { timeout: 4000 });

    // Agent text was sent first, then the PIX copia-e-cola block (text omitted the code).
    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("Pedido confirmado! Aqui está o pagamento."),
      CORR,
    );
    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      textContaining("Código PIX (copia e cola)"),
      CORR,
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
      // F4: the caption is now minted at the producer (RenderedReply), not a
      // bare string. The brand symbol is shared across minters, so a reply
      // minted here deep-equals the webhook's `mintReceiptReply("QR Code PIX")`.
      mintRenderedReply("QR Code PIX"),
      CORR,
    );
  }, 15000);

  it("BKL-241: a regenerated PIX is monitored under its NEW PaymentIntent id", async () => {
    // `regeneratePix` surfaces only `paymentIntentId` (it has no client tracking
    // id to return), so this is the shape that used to fall through to the
    // customer-id fallback and produce an unsilenceable monitor.
    mockHandleTurn.mockResolvedValue({
      response: { text: "Novo PIX gerado!" },
      acted: {
        kind: "executed",
        result: {
          pixCopyPaste: "00020126PIX-REGENERATED",
          pixExpiresAt: "2026-06-28T23:59:00Z",
          paymentIntentId: "pi_3Rregen99",
        },
      },
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_REGEN&From=whatsapp%3A%2B5511999999999&Body=novo+pix");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockSchedulePixExpiryMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ paymentIntentId: "pi_3Rregen99" }),
      );
    }, { timeout: 4000 });
  }, 15000);

  it("BKL-241: schedules NOTHING when the PIX artifact carries no payment intent id", async () => {
    // The session has customerId "cus-1". The old code fell back to it, keying
    // the monitor on an id the `pix:paid:` marker can never carry — so the job
    // was guaranteed to tell a paying customer "O PIX expirou". Silence beats a
    // reminder that cannot be silenced.
    mockHandleTurn.mockResolvedValue({
      response: { text: "Aqui está o PIX." },
      acted: {
        kind: "executed",
        result: { pixCopyPaste: "00020126PIX-NO-ID" },
      },
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_NOID&From=whatsapp%3A%2B5511999999999&Body=pagar");
    expect(res.statusCode).toBe(200);

    // The copia-e-cola still reaches the customer — only the monitor is skipped.
    await vi.waitFor(() => {
      expect(mockSendText).toHaveBeenCalledWith(
        `whatsapp:${PHONE}`,
        textContaining("Código PIX (copia e cola)"),
        CORR,
      );
    }, { timeout: 4000 });
    expect(mockSchedulePixExpiryMonitor).not.toHaveBeenCalled();
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
    // BKL-175 — never-silent PARITY: the pre-send escape now opens a GOVERNED
    // incident (turn_error mapped into the frozen `send_failed`), mirroring the
    // web backstop. The apology above delivered → NOT a full ghost.
    expect(mockEmitNoDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: "send_failed",
        channel: "whatsapp",
        customerImpacted: false,
      }),
      expect.anything(),
    );
    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "send_failed", customerImpacted: false }),
      expect.anything(),
    );
  }, 15000);

  it("BKL-175 full ghost: pre-send failure AND the apology send fails → customerImpacted:true", async () => {
    mockHandleTurn.mockRejectedValue(new Error("conductor exploded pre-send"));
    mockSendText.mockRejectedValue(new Error("twilio down"));

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_GHOST&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockOpenIncidentInline).toHaveBeenCalledWith(
        expect.objectContaining({
          cause: "send_failed",
          channel: "whatsapp",
          customerImpacted: true,
        }),
        expect.anything(),
      );
    }, { timeout: 4000 });
    expect(mockEmitNoDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "send_failed", customerImpacted: true }),
      expect.anything(),
    );
  }, 15000);

  it("BKL-175 F2 pin: a POST-send throw (already-served) stays incident-less — apology only", async () => {
    // Turn succeeds, the reply is DELIVERED (sendText resolves), then the
    // assistant-append AFTER sendCompleted throws. The customer was served —
    // opening an incident (or mapping to send_failed) here would be the exact
    // F2 false-positive the exclusion protects. The fix must NOT widen into this.
    mockHandleTurn.mockResolvedValue({
      response: { text: "Seu pedido está confirmado." },
      acted: null,
      decision: { kind: "EXECUTE" },
    });
    // mockReset clears any queued Once implementations so this chain is exact:
    // call 1 = the user-message append (pre-send) resolves; call 2 = the
    // assistant append AFTER sendCompleted rejects; later calls resolve.
    mockAppendMessages.mockReset();
    mockAppendMessages
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("session store write failed"))
      .mockResolvedValue(undefined);

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_POSTSEND&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockReleaseAgentLock).toHaveBeenCalledWith(HASH, "lock-uuid");
    }, { timeout: 4000 });

    // The real reply reached the customer…
    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      textContaining("Seu pedido está confirmado."),
      CORR,
    );
    // …so NO governed incident and NO no-delivery signal (F2 already-served).
    expect(mockEmitNoDelivery).not.toHaveBeenCalled();
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
  }, 15000);

  it("D2 bot-pause: a human takeover suppresses the bot reply but still confirms idempotency", async () => {
    mockIsPaused.mockResolvedValue(true);

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
    // A GENUINE pause is never a ghost → no incident opened.
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
  }, 15000);

  it("#2: a pause-gate READ-ERROR opens ONE pause_read_error incident (Redis-free path) and sends nothing", async () => {
    // The bot-pause gate is unreachable (Redis down). Fail-CLOSED (no reply), but
    // this is a customer-impacted ghost WITHOUT a confirmed pause → a durable
    // pause_read_error incident opens via the inline (Redis-free) path.
    mockGetEscalationStore.mockRejectedValue(new Error("redis down"));

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_PAUSEERR&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockOpenIncidentInline).toHaveBeenCalledWith(
        expect.objectContaining({
          cause: "pause_read_error",
          customerImpacted: true,
          channel: "whatsapp",
        }),
        expect.anything(),
      );
    }, { timeout: 4000 });

    // Exactly one open (one incident per session; the storm digest — not a
    // per-incident ping — aggregates cross-session via the notification subscriber).
    expect(mockOpenIncidentInline).toHaveBeenCalledTimes(1);
    // Fail-CLOSED: the conductor never ran and no reply text was sent.
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
    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("Claro, vou adicionar."),
      CORR,
    );
  }, 15000);

  it("M3: a whitespace-only retry reply is NOT sent, does NOT auto-close, and flags retry_exhausted", async () => {
    // Post-lock re-check fires (user-last history); the retry produces a blank
    // completion. A whitespace reply must NOT be delivered (raw truthiness would
    // have sent "\n" and auto-resolved the incident) and the whitespace_only
    // else-if must be reachable → a retry_exhausted incident, not a self-heal.
    mockLoadSession.mockResolvedValue([{ role: "user", content: "cadê minha resposta?" }]);
    mockHandleTurn
      .mockResolvedValueOnce({ response: { text: "Perfeito!" }, acted: null, decision: { kind: "EXECUTE" } })
      .mockResolvedValueOnce({ response: { text: "  \n " }, acted: null, decision: { kind: "EXECUTE" } });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_WS_RETRY&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockHandleTurn).toHaveBeenCalledTimes(2);
    }, { timeout: 4000 });
    await vi.waitFor(() => {
      expect(mockOpenIncidentInline).toHaveBeenCalled();
    }, { timeout: 4000 });

    // Main deliverable reply WAS sent; the whitespace-only retry reply was NOT.
    expect(mockSendText).toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("Perfeito!"),
      CORR,
    );
    expect(mockSendText).not.toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("  \n "),
      CORR,
    );
    // The blank retry did NOT auto-resolve an OPEN incident…
    expect(mockCloseIncidentOnDeliveredReply).not.toHaveBeenCalled();
    // …and the now-reachable whitespace_only branch flagged it as retry_exhausted.
    expect(mockOpenIncidentInline).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "retry_exhausted", channel: "whatsapp" }),
      expect.anything(),
    );
  }, 15000);

  it("F5: a whitespace main reply that delivered PIX is NOT sent as text and opens NO incident", async () => {
    // The model returned a blank completion but the turn DID deliver a PIX action
    // (copia-e-cola + QR). Whitespace is NOT a delivered reply → not sent, but the
    // PIX reached the customer, so deliveredText == hasPixData == true and the
    // whitespace_only PIX-only guard (F5) must suppress the incident + holding msg.
    mockHandleTurn.mockResolvedValue({
      response: { text: "  \n " },
      acted: {
        kind: "executed",
        result: {
          pixCopyPaste: "00020126PIX-WHITESPACE-CASE",
          pixQrCode: "data:image/png;base64,QR",
          pixExpiresAt: "2026-06-28T23:59:00Z",
          orderId: "ord-ws",
        },
      },
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_WS_PIX&From=whatsapp%3A%2B5511999999999&Body=pagar");
    expect(res.statusCode).toBe(200);

    // The PIX copia-e-cola block confirms the turn was fully processed.
    await vi.waitFor(() => {
      expect(mockSendText).toHaveBeenCalledWith(
        `whatsapp:${PHONE}`,
        textContaining("Código PIX (copia e cola)"),
        CORR,
      );
    }, { timeout: 4000 });

    // Whitespace text was NOT sent as a message…
    expect(mockSendText).not.toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      mintRenderedReply("  \n "),
      CORR,
    );
    // …no empty-completion holding message was pushed…
    expect(mockSendText).not.toHaveBeenCalledWith(
      `whatsapp:${PHONE}`,
      textContaining("não consegui montar uma resposta"),
    );
    // …and NO no-delivery incident was opened (PIX reached the customer).
    expect(mockOpenIncidentInline).not.toHaveBeenCalled();
  }, 15000);

  it("L10: a delivered reply still auto-closes an OPEN incident (detached fire-and-forget)", async () => {
    // Default history ends with an assistant message → no post-lock retry. Give
    // the main turn a turnId so the (now detached) close is observable.
    mockGetConductor.mockReturnValue({
      openCapsule: vi.fn().mockResolvedValue({ id: "capsule-1", turnId: "turn-main" }),
      closeCapsule: vi.fn().mockResolvedValue(undefined),
    });
    mockHandleTurn.mockResolvedValue({
      response: { text: "Tudo certo!" },
      acted: null,
      decision: { kind: "EXECUTE" },
    });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_CLOSE&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    // Fire-and-forget: the close may settle after the reply path — wait for it.
    await vi.waitFor(() => {
      expect(mockCloseIncidentOnDeliveredReply).toHaveBeenCalledWith(
        "sess-1",
        "turn-main",
        expect.anything(),
      );
    }, { timeout: 4000 });
  }, 15000);

  it("#5: a PIX-only turn whose copia-e-cola send FAILS opens a send_failed incident (not turn_error)", async () => {
    // Empty text (PIX-only) → the text send is skipped (sendEntered stays false).
    // The copia-e-cola send is now tracked, so a throw there is classified
    // send_failed (customerImpacted) instead of turn_error (which opened NO
    // incident → a customer ghosted on a payment turn).
    mockHandleTurn.mockResolvedValue({
      response: { text: "" },
      acted: {
        kind: "executed",
        result: { pixCopyPaste: "00020126PIX-ONLY-FAIL", orderId: "ord-fail" },
      },
      decision: { kind: "EXECUTE" },
    });
    mockSendText.mockRejectedValue(new Error("twilio 500")); // the only send is copia-e-cola

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_PIXFAIL&From=whatsapp%3A%2B5511999999999&Body=pagar");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockOpenIncidentInline).toHaveBeenCalledWith(
        expect.objectContaining({ cause: "send_failed", channel: "whatsapp" }),
        expect.anything(),
      );
    }, { timeout: 4000 });
  }, 15000);

  it("below-cap: a send_failed whose canned apology IS delivered opens the incident customerImpacted:false", async () => {
    // The reply send fails (send_failed), but the canned apology send succeeds →
    // the customer got the apology (degraded, not silence) → customerImpacted:false.
    mockHandleTurn.mockResolvedValue({
      response: { text: "Olá, tudo certo!" },
      acted: null,
      decision: { kind: "EXECUTE" },
    });
    mockSendText
      .mockRejectedValueOnce(new Error("twilio 500")) // the reply send fails → send_failed
      .mockResolvedValue(undefined); // the canned apology send succeeds

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_APOLOGY&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      expect(mockOpenIncidentInline).toHaveBeenCalledWith(
        expect.objectContaining({ cause: "send_failed", customerImpacted: false }),
        expect.anything(),
      );
    }, { timeout: 4000 });
  }, 15000);
});

// ── BKL-086 — the ops-actor fork (customer-path preservation) ─────────────────
//
// The ops fork runs at the TOP of handleMessageAsync, BEFORE resolveWhatsAppSession
// (which auto-creates a Customer + welcome credit + LGPD opt-in). A consumed
// (active-staff) message must NEVER touch the customer path; a non-staff /
// inactive message must fall through BYTE-IDENTICALLY.
describe("handleMessageAsync — ops-actor fork (BKL-086)", () => {
  it("a CONSUMED staff message never runs the customer path (no session resolve, no customer conductor, no Customer-create side effects)", async () => {
    mockHandleOpsWhatsAppMessage.mockResolvedValue({ consumed: true });

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_OPS&From=whatsapp%3A%2B5511999999999&Body=acabou+a+picanha");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      // Consumed ⇒ the idempotency claim is promoted (a stray SID redelivery must
      // never re-fire a mutating owner command).
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining("SM_OPS"),
        "1",
        { EX: 86400 },
      );
    }, { timeout: 2000 });

    // The customer path — and EVERY Customer-creating side effect — never ran.
    expect(mockResolveWhatsAppSession).not.toHaveBeenCalled();
    expect(mockGetConductor).not.toHaveBeenCalled();
    expect(mockSetWelcomeCredit).not.toHaveBeenCalled();
    expect(mockMarkOptedIn).not.toHaveBeenCalled();
    expect(mockMarkCustomerReplied).not.toHaveBeenCalled();

    // The fork was invoked with the trimmed body + phone/hash.
    expect(mockHandleOpsWhatsAppMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phone: PHONE, hash: HASH, text: "acabou a picanha" }),
    );
  });

  it("a NON-staff (consumed:false) message falls through to the customer path — the fork runs FIRST", async () => {
    mockTryDebounce.mockResolvedValue(true); // become the runner → run the customer conductor
    // default mock returns { consumed:false }

    const app = await buildTestServer();
    const res = await post(app, "MessageSid=SM_CUST&From=whatsapp%3A%2B5511999999999&Body=oi");
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => {
      // The customer conductor ran, byte-identically to the pre-BKL-086 flow
      // (after the real 2s debounce sleep).
      expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    }, { timeout: 6000 });
    expect(mockResolveWhatsAppSession).toHaveBeenCalled();
    // The fork was consulted BEFORE session resolution (fork-first).
    const forkOrder = mockHandleOpsWhatsAppMessage.mock.invocationCallOrder[0]!;
    const resolveOrder = mockResolveWhatsAppSession.mock.invocationCallOrder[0]!;
    expect(forkOrder).toBeLessThan(resolveOrder);
  }, 15000);
});

// ── Phase 6 — the customer-WhatsApp park-reply triage (the R4-S1 opt-out closes) ──
//
// The triage runs at the INGRESS, BEFORE handleTurn, so this route suite is the
// only seam that can measure it: `runConductorTurn` is module-private and the
// customer e2e harness drives `handleTurn` directly, i.e. it enters BELOW the
// branch under test. These drive the real Fastify webhook exactly as the web
// mirror (routes/__tests__/chat-route.test.ts, "BKL-212 parked-confirmation
// niceties") drives the real chat route.
//
// `mockHandleTurn` is the load-bearing witness throughout: a triage branch SKIPS
// the turn, so "the model was never called" is what distinguishes an answered
// reply from one that fell through to the loop.
describe("handleMessageAsync — park-reply triage (Phase 6, customer plane)", () => {
  const PARK_PROMPT = "cancelar o pedido 4242";
  const INTENT_HASH = "abc123def456";
  const DECLINE_ACK =
    "Ok, não vou fazer isso — nada foi alterado. Se precisar de outra coisa, é só me dizer.";
  let mockUnpark: ReturnType<typeof vi.fn>;

  /** Open the capsule with ONE parked confirmation in the CUSTOMER-plane shape:
   *  no `expiresAt` (only a `system:`-prefixed ops session gets one). `parkedAt`
   *  is a parameter so the no-TTL decision itself can be exercised. */
  function withPark(parkedAt: string = new Date().toISOString()): void {
    mockGetConductor.mockReturnValue({
      openCapsule: vi.fn().mockResolvedValue({
        id: "capsule-1",
        turnId: "turn-park",
        loadedSession: {
          id: "whatsapp:cus-1",
          pendingConfirmations: [
            {
              envelope: { kind: "order.cancel", intentHash: INTENT_HASH },
              confirmationToken: "tok-1",
              userPrompt: PARK_PROMPT,
              parkedAt,
            },
          ],
        },
        session: { unpark: mockUnpark },
      }),
      closeCapsule: vi.fn().mockResolvedValue(undefined),
    });
  }

  /** Open the capsule with NO parks (the pre-Phase-6 default shape). */
  function withoutPark(): void {
    mockGetConductor.mockReturnValue({
      openCapsule: vi.fn().mockResolvedValue({
        id: "capsule-1",
        turnId: "turn-nopark",
        loadedSession: { id: "whatsapp:cus-1", pendingConfirmations: [] },
        session: { unpark: mockUnpark },
      }),
      closeCapsule: vi.fn().mockResolvedValue(undefined),
    });
  }

  /** Drive ONE inbound WhatsApp message all the way through the async pipeline.
   *
   *  The turn input is the LAST USER message of the loaded session history (the
   *  route re-reads the thread rather than trusting the raw webhook body), so the
   *  history is seeded with `body` as that message. A trailing assistant message
   *  keeps the post-lock retry a no-op — the suite-wide convention — so a single
   *  inbound produces exactly ONE turn path to assert on. */
  async function send(sid: string, body: string): Promise<void> {
    mockLoadSession.mockResolvedValue([
      { role: "user", content: body },
      { role: "assistant", content: "resposta anterior" },
    ]);
    const app = await buildTestServer();
    const res = await post(
      app,
      `MessageSid=${sid}&From=whatsapp%3A%2B5511999999999&Body=${encodeURIComponent(body)}`,
    );
    expect(res.statusCode).toBe(200);
    // The lock release is the last thing the turn path does, triage or not.
    await vi.waitFor(() => {
      expect(mockReleaseAgentLock).toHaveBeenCalled();
    }, { timeout: 8000 });
  }

  /** The text of the reply that reached Twilio, or undefined. */
  function sentText(): string | undefined {
    const call = mockSendText.mock.calls.find(([to]) => to === `whatsapp:${PHONE}`);
    return (call?.[1] as { text?: string } | undefined)?.text;
  }

  beforeEach(() => {
    mockTryDebounce.mockResolvedValue(true); // become the runner → reach the turn path
    mockUnpark = vi.fn().mockResolvedValue(undefined);
    mockHandleTurn.mockResolvedValue({
      response: { text: "resposta do modelo" },
      acted: null,
      decision: { kind: "EXECUTE" },
    });
  });

  // (a) SOFT AFFIRMATIVE → restate, park SURVIVES.
  it("(a) a bare soft affirmative (\"pode\") RESTATES the park, keeps it, and never runs the turn", async () => {
    withPark();
    await send("SM_SOFT", "pode");

    expect(mockHandleTurn).not.toHaveBeenCalled();
    // Money-safety: a soft affirmative must never execute AND never unpark — the
    // park survives so a follow-up "sim" still runs the adjudicated resume.
    expect(mockUnpark).not.toHaveBeenCalled();
    const text = sentText();
    expect(text).toContain("Só confirmando");
    expect(text).toContain(PARK_PROMPT);
    expect(text).toContain('"sim"');
    // A deterministic notice IS a delivered reply: persisted to the thread.
    expect(mockAppendMessages).toHaveBeenCalledWith(
      "sess-1",
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Só confirmando"),
        }),
      ]),
      true,
      expect.objectContaining({ channel: "whatsapp" }),
    );
  }, 15000);

  // (a′) THE MANDATE'S BEHAVIOUR CHANGE, pinned. `@claustrum/channel-whatsapp`'s
  // matchToParked lists "ok" in its AFFIRMATIVE_RE, so BEFORE this wiring a bare
  // "ok" reached the loop and EXECUTED the parked action. It must now restate.
  it.each(["ok", "beleza", "OK!", "claro"])(
    "(a′) soft variant %j also restates instead of executing (the WhatsApp driver would have confirmed it)",
    async (word) => {
      withPark();
      await send(`SM_SOFT_${word.replace(/\W/g, "")}`, word);

      expect(mockHandleTurn).not.toHaveBeenCalled();
      expect(mockUnpark).not.toHaveBeenCalled();
      expect(sentText()).toContain("Só confirmando");
    },
    15000,
  );

  // (b) PURE NEGATIVE → decline + unpark + acknowledgment.
  it("(b) a pure negative (\"não\") DECLINES the park: unparked before the turn, deterministic ACK, turn skipped", async () => {
    withPark();
    await send("SM_NEG", "não");

    expect(mockHandleTurn).not.toHaveBeenCalled();
    // Unparked BEFORE the turn, keyed on the parked envelope's intentHash.
    expect(mockUnpark).toHaveBeenCalledWith("whatsapp:cus-1", INTENT_HASH);
    expect(sentText()).toBe(DECLINE_ACK);
  }, 15000);

  // (c) STALE — the config decision itself, pinned as a POSITIVE assertion.
  //
  // There is no stale branch on this plane and that is a DECISION, not a gap: a
  // customer park carries no `expiresAt` (`opsConfirmParkExpiresAt` returns a value
  // only for a `system:`-prefixed ops session), so the customer policy declares
  // `freshness: none` and every pending confirmation is live however old it is.
  // This drives a park aged FAR past the ops 15-minute confirm TTL and asserts it
  // is still treated as LIVE — no expiry notice, and the branches still engage. A
  // future TTL on the customer plane (which would change how long a park lives)
  // reds this test.
  it("(c) a park aged past the OPS confirm TTL is still LIVE on the customer plane — no expiry notice", async () => {
    const dayOld = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    withPark(dayOld);
    await send("SM_STALE", "não");

    expect(mockHandleTurn).not.toHaveBeenCalled();
    // Declined as a LIVE park (not reported expired, not left inert).
    expect(mockUnpark).toHaveBeenCalledWith("whatsapp:cus-1", INTENT_HASH);
    const text = sentText();
    expect(text).toBe(DECLINE_ACK);
    expect(text).not.toContain("expirou");
  }, 15000);

  // (d) CONTROL — an explicit confirm must NOT be intercepted.
  it("(d) CONTROL: an explicit \"sim\" is NOT intercepted — the normal confirm-resume turn runs, park untouched", async () => {
    withPark();
    await send("SM_SIM", "sim");

    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    // The conductor owns the resume unpark — the ingress must not pre-empt it.
    expect(mockUnpark).not.toHaveBeenCalled();
    expect(sentText()).toBe("resposta do modelo");
  }, 15000);

  // (d′) CONTROL — every other shape the triage must let through.
  it.each([
    ["a soft yes carrying NEW content", "ok mas manda às 19h"],
    ["a MIXED affirmative + negative (ambiguous, money-safe)", "não, pode deixar"],
    ["an ordinary utterance", "quero uma costela"],
  ])("(d′) CONTROL: %s runs the normal turn with the park untouched", async (_label, body) => {
    withPark();
    await send(`SM_CTL_${body.length}`, body);

    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(mockUnpark).not.toHaveBeenCalled();
    expect(sentText()).toBe("resposta do modelo");
  }, 15000);

  // (e) CONTROL — no parks at all: the loop runs untouched.
  it.each(["não", "ok", "sim", "quero uma costela"])(
    "(e) CONTROL: with NO park, %j takes the normal path",
    async (body) => {
      withoutPark();
      await send(`SM_FREE_${body.length}`, body);

      expect(mockHandleTurn).toHaveBeenCalledTimes(1);
      expect(mockUnpark).not.toHaveBeenCalled();
      expect(sentText()).toBe("resposta do modelo");
    },
    15000,
  );

  // FAIL-HONEST — the acknowledgment asserts a cancellation, so it may only be
  // sent once the unpark STUCK.
  it("an unpark FAILURE falls through to the normal loop instead of claiming a cancellation", async () => {
    withPark();
    mockUnpark.mockRejectedValue(new Error("redis down"));
    await send("SM_UNPARKFAIL", "não");

    // The triage DID decide to decline and DID attempt the unpark — this is what
    // separates the fail-honest fallthrough from an ingress with no triage at all
    // (which never touches the store), so the assertion is not satisfied by the
    // unwired baseline.
    expect(mockUnpark).toHaveBeenCalledWith("whatsapp:cus-1", INTENT_HASH);
    // The park did NOT clear → we must not acknowledge; run the loop, where
    // claustrum's own deny path still unparks.
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(sentText()).toBe("resposta do modelo");
    expect(sentText()).not.toBe(DECLINE_ACK);
  }, 15000);

  // ── F-3 (CLOSED) — a NEGATIVE carrying a SAFETY MARKER falls through ────────
  // This block previously PINNED the defect: `isPureNegativeReplyText("não, sou
  // celíaco")` is true (a negative token, no affirmative/hash/defer token), so the
  // triage answered the reply pre-turn with the decline ACK and the celiac marker
  // never reached the planner's §O#9 closed-taxonomy safety routing. That pin was
  // written as a change-detector an owner ruling would flip; the owner's standing
  // F-3 ruling (PR #515 — a safety marker OUTRANKS a short-circuit, and the gate
  // chooses NO terminal) has now been applied to this seam, so it is flipped here
  // into a DIRECTIONAL guard of the new behaviour.
  //
  // WHAT IS ASSERTED, and why this file. The triage is a PRE-handleTurn branch, so
  // `mockHandleTurn` is the only witness that can tell "the triage answered it"
  // from "the turn ran": the customer e2e harness drives `handleTurn` directly and
  // therefore enters BELOW the branch under test. `handleTurn` being CALLED is the
  // whole claim — it is what puts the marker in front of the planner.
  //
  // WHAT HAPPENS TO THE PARK — measured, and named rather than assumed. The triage
  // stands down, so it unparks NOTHING (money-safety: no cancellation is claimed
  // without its acknowledgment). `handleTurn` is mocked here, so the conductor's
  // own deny path does not run in THIS harness and the park simply survives the
  // ingress; in production that deny path unparks and re-plans the text, which for
  // a marker-bearing negative carries real content for the safety machinery to
  // answer. The assertion below is scoped to what this seam actually decides.
  it("F-3: a negative carrying a SAFETY MARKER reaches handleTurn — the triage stands down and unparks NOTHING", async () => {
    withPark();
    await send("SM_CELIAC", "não, sou celíaco");

    // The turn RAN — the marker is now in front of the planner (§O#9 / BKL-184).
    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    // The text handed to the conductor is the customer's own words, unmodified.
    expect(mockHandleTurn.mock.calls[0]?.[1]).toMatchObject({ text: "não, sou celíaco" });
    // The TRIAGE unparked nothing: it declined to intercept, so it claims no
    // cancellation. The park's fate belongs to the conductor's deny path.
    expect(mockUnpark).not.toHaveBeenCalled();
    // No decline ACK was sent — the turn's own reply is delivered instead.
    const text = sentText();
    expect(text).not.toBe(DECLINE_ACK);
    expect(text).toBe("resposta do modelo");
  }, 15000);

  // The CONTROL that makes the case above directional. Same park, same ingress,
  // same code path — only the marker differs. Without it, "handleTurn was called"
  // would also pass against a triage whose decline branch had been deleted outright.
  it("F-3 CONTROL: a marker-FREE negative on the same park still declines byte-identically", async () => {
    withPark();
    await send("SM_NOMARKER", "não, sou vegetariano");

    // `vegetariano` is deliberately OUT of the diet net (BKL-214 drew the
    // preference/restriction line), so this is the SAME sentence shape with no
    // marker — and it must still be intercepted exactly as before.
    expect(mockHandleTurn).not.toHaveBeenCalled();
    expect(mockUnpark).toHaveBeenCalledWith("whatsapp:cus-1", INTENT_HASH);
    expect(sentText()).toBe(DECLINE_ACK);
  }, 15000);

  // The ACTIVE-DISTRESS member of the class — the §O#9 ESCALATE proper (BKL-209),
  // not the BKL-270 diet net. Both halves of `carriesSafetyMarker` are exercised at
  // the ingress, so a regression in either net is visible at this seam.
  it("F-3: an ACTIVE-DISTRESS negative also reaches handleTurn (the BKL-209 net, not just the diet net)", async () => {
    withPark();
    await send("SM_DISTRESS", "não consigo respirar");

    expect(mockHandleTurn).toHaveBeenCalledTimes(1);
    expect(mockUnpark).not.toHaveBeenCalled();
    expect(sentText()).not.toBe(DECLINE_ACK);
  }, 15000);
});
