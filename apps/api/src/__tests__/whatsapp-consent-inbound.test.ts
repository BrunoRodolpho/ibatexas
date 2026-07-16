// Inbound marketing-consent (STOP / opt-in) durable-write coverage (WS3A / LGPD).
//
// whatsapp-shortcuts.test.ts pins the PURE classifier (matchShortcut → {type}).
// This file pins the SIDE EFFECT the classifier feeds: when an inbound "PARAR"
// classifies as `optout`, handleShortcut must WRITE durable consent through the
// broadcast opt-out store with source 'inbound_stop' and reply with the current
// pt-BR confirmation — the legally-significant half the pure test can't reach.
//
// `../whatsapp/shortcuts.js` is intentionally left REAL so the confirmation
// tokens asserted here are the ACTUAL production copy (including the "bare
// 'voltar' removed as opt-in" change — the opt-out confirmation now points at the
// unambiguous "quero voltar a receber" token).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleShortcut } from "../routes/whatsapp-webhook.js";

const mockOptOut = vi.hoisted(() => vi.fn(async () => {}));
const mockOptIn = vi.hoisted(() => vi.fn(async () => {}));
const mockIsOptedOut = vi.hoisted(() => vi.fn(async () => false));

// The module under focus — the durable consent store.
vi.mock("../broadcast/broadcast-optout.js", () => ({
  getBroadcastOptOutStore: vi.fn(async () => ({
    optOut: mockOptOut,
    optIn: mockOptIn,
    isOptedOut: mockIsOptedOut,
    list: vi.fn(async () => [] as string[]),
  })),
}));

// ── Import-graph stubs so whatsapp-webhook.ts loads without heavy infra ────────
// (mirrors whatsapp-webhook-route.test.ts; shortcuts.js is deliberately NOT here).

vi.mock("../ops/ops-whatsapp-ingress.js", () => ({
  handleOpsWhatsAppMessage: vi.fn(async () => ({ consumed: false })),
  buildOpsWhatsAppIngressDeps: vi.fn(() => ({})),
}));

vi.mock("twilio", () => ({
  default: Object.assign(() => ({}), { validateRequest: vi.fn() }),
}));

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(),
  rk: (s: string) => s,
  atomicIncr: vi.fn(),
  getLoyaltyBalance: vi.fn(),
  getOrCreateCart: vi.fn(async () => ({ cartId: "cart_test", items: [], total: 0, message: "" })),
}));

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: vi.fn(),
}));

vi.mock("../session/store.js", () => ({
  loadSession: vi.fn(),
  appendMessages: vi.fn(),
}));

vi.mock("../whatsapp/session.js", () => ({
  normalizePhone: vi.fn(),
  hashPhone: vi.fn((p: string) => `hash(${p})`),
  resolveWhatsAppSession: vi.fn(),
  buildWhatsAppContext: vi.fn(),
  touchSession: vi.fn(),
  acquireAgentLock: vi.fn(),
  releaseAgentLock: vi.fn(),
  tryDebounce: vi.fn(),
  hasOptedIn: vi.fn(),
  markOptedIn: vi.fn(),
  storeLastLocation: vi.fn(),
  getLastLocation: vi.fn(),
  isMessageDuplicate: vi.fn(),
  setWelcomeCredit: vi.fn(),
  getAndConsumeWelcomeCredit: vi.fn(),
}));

vi.mock("../whatsapp/formatter.js", () => ({
  collectAgentResponse: vi.fn(),
}));

vi.mock("../whatsapp/client.js", () => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
}));

vi.mock("../jobs/hesitation-nudge.js", () => ({
  scheduleHesitationNudge: vi.fn(),
  markCustomerReplied: vi.fn(),
}));

vi.mock("../jobs/pix-expiry-monitor.js", () => ({
  schedulePixExpiryMonitor: vi.fn(),
}));

vi.mock("../whatsapp/constants.js", () => ({
  LGPD_OPTIN_MESSAGE: "Mensagem LGPD mock",
}));

beforeEach(() => vi.clearAllMocks());

const PHONE = "+5511999990000";

describe("handleShortcut — inbound marketing consent (WS3A / LGPD)", () => {
  it("inbound STOP ('optout') writes durable opt-out with source 'inbound_stop' and confirms in pt-BR", async () => {
    const out = await handleShortcut("optout", { phone: PHONE, sessionId: "s1" });

    // The durable, legally-significant write — keyed by the canonical phone,
    // stamped with the inbound-STOP source.
    expect(mockOptOut).toHaveBeenCalledWith(PHONE, "inbound_stop");
    expect(mockOptIn).not.toHaveBeenCalled();

    // Current production confirmation copy.
    expect(out).toContain("não receberá mais mensagens promocionais");
    // The opt-in path now requires the UNAMBIGUOUS token (bare 'voltar' removed).
    expect(out).toContain("quero voltar a receber");
  });

  it("inbound re-subscribe ('optin') writes durable opt-in with source 'inbound_stop' and confirms in pt-BR", async () => {
    const out = await handleShortcut("optin", { phone: PHONE, sessionId: "s1" });

    expect(mockOptIn).toHaveBeenCalledWith(PHONE, "inbound_stop");
    expect(mockOptOut).not.toHaveBeenCalled();
    expect(out).toContain("voltou a receber");
  });

  it("does NOT write consent (and falls through) when the inbound message has no phone", async () => {
    const out = await handleShortcut("optout", { sessionId: "s1" });
    expect(out).toBeNull();
    expect(mockOptOut).not.toHaveBeenCalled();
  });

  it("falls through (returns null) without ghosting when the durable consent write throws", async () => {
    mockOptOut.mockRejectedValueOnce(new Error("pg 57P01 — DB blip"));
    const out = await handleShortcut("optout", { phone: PHONE, sessionId: "s1" });
    expect(out).toBeNull();
    expect(mockOptOut).toHaveBeenCalledWith(PHONE, "inbound_stop");
  });
});
