// Regression tests for P2-SEC-WAIDEMPOTENCY — the WhatsApp webhook's two-phase
// idempotency guard.
//
// The bug: the route used to SET the dedup key (NX, 24h) BEFORE the async turn
// ran, so any turn failure black-holed the MessageSid for 24h — Twilio's retries
// dedup'd against a key for work that never completed.
//
// The fix mirrors the subscribers' withDedup / the Stripe webhook two-phase:
//   1. CLAIM   — SET NX with a SHORT in-flight TTL (synchronously, before 200).
//   2. RUN     — the async turn.
//   3a. CONFIRM — promote to the full 24h window on success.
//   3b. RELEASE — DEL the claim on failure so Twilio's retry reprocesses.
//
// These tests mock the REAL route's deps (verifyTwilioSignature from
// @claustrum/channel-whatsapp, getConductor, handleTurn) — they do NOT activate
// any real bootstrap/conductor wiring; getConductor is a controllable test
// double so we can drive both the success and failure branches deterministically.

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
// vi.hoisted() + vi.mock() are hoisted above all imports by Vitest, so the route
// import below still resolves against the mocked modules despite appearing first.
import { whatsappWebhookRoutes } from "../routes/whatsapp-webhook.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockVerifyTwilioSignature = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockRk = vi.hoisted(() => vi.fn((key: string) => `ibatexas:${key}`));
const mockAtomicIncr = vi.hoisted(() => vi.fn());
const mockHandleTurn = vi.hoisted(() => vi.fn());
const mockGetConductor = vi.hoisted(() => vi.fn());
const mockHashPhone = vi.hoisted(() => vi.fn(() => "phone-hash"));
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

vi.mock("../claustrum-bootstrap.js", () => ({
  getConductor: mockGetConductor,
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: mockRk,
  atomicIncr: mockAtomicIncr,
}));

vi.mock("../lib/phone-hash.js", () => ({
  hashPhone: mockHashPhone,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildTestServer() {
  const app = Fastify({ logger: false });
  await app.register(whatsappWebhookRoutes);
  await app.ready();
  return app;
}

const WEBHOOK_KEY = "ibatexas:wa:webhook:SM_TEST";

function postValid(app: Awaited<ReturnType<typeof buildTestServer>>, sid = "SM_TEST") {
  return app.inject({
    method: "POST",
    url: "/api/webhooks/whatsapp",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "valid-sig",
    },
    payload: `MessageSid=${sid}&From=whatsapp%3A%2B5511999999999&Body=oi`,
  });
}

describe("P2-SEC-WAIDEMPOTENCY — two-phase idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.com/api/webhooks/whatsapp");
    mockVerifyTwilioSignature.mockReturnValue(true);
    mockRk.mockImplementation((key: string) => `ibatexas:${key}`);
    mockAtomicIncr.mockResolvedValue(1); // under rate limit
    // Default conductor double — a turn that produces text and succeeds.
    mockPerceive.mockResolvedValue({
      channel: "whatsapp",
      customerId: "cus-1",
      conversationId: "conv-1",
      text: "oi",
      receivedAt: new Date().toISOString(),
    });
    mockRender.mockResolvedValue(undefined);
    mockOpenCapsule.mockResolvedValue({ id: "capsule-1" });
    mockCloseCapsule.mockResolvedValue(undefined);
    mockGetConductor.mockReturnValue({
      channels: { whatsapp: { perceive: mockPerceive, render: mockRender } },
      openCapsule: mockOpenCapsule,
      closeCapsule: mockCloseCapsule,
    });
    mockHandleTurn.mockResolvedValue({ response: { text: "Olá!" } });
  });

  it("claims with a SHORT in-flight TTL, NOT the 24h window, before processing", async () => {
    const setMock = vi.fn().mockResolvedValue("OK");
    mockGetRedisClient.mockResolvedValue(
      { set: setMock, del: vi.fn().mockResolvedValue(1), get: vi.fn().mockResolvedValue(null) },
    );

    const app = await buildTestServer();
    const res = await postValid(app);

    expect(res.statusCode).toBe(200);
    // The synchronous claim must use a short TTL (300s) with NX — never EX:86400 up front.
    expect(setMock).toHaveBeenCalledWith(WEBHOOK_KEY, "1", { EX: 300, NX: true });
    expect(setMock).not.toHaveBeenCalledWith(
      WEBHOOK_KEY,
      "1",
      expect.objectContaining({ EX: 86400, NX: true }),
    );
  });

  it("promotes the claim to the full 24h window only AFTER the turn succeeds", async () => {
    const setMock = vi.fn().mockResolvedValue("OK");
    const delMock = vi.fn().mockResolvedValue(1);
    mockGetRedisClient.mockResolvedValue(
      { set: setMock, del: delMock, get: vi.fn().mockResolvedValue(null) },
    );

    const app = await buildTestServer();
    await postValid(app);

    // Async turn (fire-and-forget) confirms the claim → SET key 1 EX 86400 (no NX).
    await vi.waitFor(() => {
      expect(setMock).toHaveBeenCalledWith(WEBHOOK_KEY, "1", { EX: 86400 });
    }, { timeout: 1000 });
    // Success path must NOT release the claim.
    expect(delMock).not.toHaveBeenCalledWith(WEBHOOK_KEY);
  });

  it("RELEASES the claim (no 24h black-hole) when the turn FAILS", async () => {
    const setMock = vi.fn().mockResolvedValue("OK");
    const delMock = vi.fn().mockResolvedValue(1);
    mockGetRedisClient.mockResolvedValue(
      { set: setMock, del: delMock, get: vi.fn().mockResolvedValue(null) },
    );
    // Turn blows up — this is the black-hole scenario.
    mockHandleTurn.mockRejectedValue(new Error("provider exploded"));

    const app = await buildTestServer();
    const res = await postValid(app);

    expect(res.statusCode).toBe(200); // Twilio still gets its synchronous 200
    await vi.waitFor(() => {
      expect(delMock).toHaveBeenCalledWith(WEBHOOK_KEY);
    }, { timeout: 1000 });
    // Crucially, the failed message is NOT promoted to the 24h dedup window.
    expect(setMock).not.toHaveBeenCalledWith(WEBHOOK_KEY, "1", { EX: 86400 });
  });

  it("treats an already-claimed SID as a duplicate and skips the turn", async () => {
    // SET NX returns null → already claimed/processed.
    mockGetRedisClient.mockResolvedValue(
      { set: vi.fn().mockResolvedValue(null), del: vi.fn(), get: vi.fn().mockResolvedValue(null) },
    );

    const app = await buildTestServer();
    const res = await postValid(app);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<Response/>");
    // No turn should run for a duplicate.
    expect(mockGetConductor).not.toHaveBeenCalled();
    expect(mockHandleTurn).not.toHaveBeenCalled();
  });

  it("fails CLOSED (non-2xx) when the idempotency claim cannot reach Redis", async () => {
    mockGetRedisClient.mockResolvedValue(
      { set: vi.fn().mockRejectedValue(new Error("redis down")), del: vi.fn(), get: vi.fn() },
    );

    const app = await buildTestServer();
    const res = await postValid(app);

    // Non-2xx so Twilio retries instead of us processing unguarded.
    expect(res.statusCode).toBe(503);
    expect(mockHandleTurn).not.toHaveBeenCalled();
  });
});
