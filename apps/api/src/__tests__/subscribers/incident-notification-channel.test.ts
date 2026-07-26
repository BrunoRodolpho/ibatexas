// incident-notification-subscriber — the staff ping must name the RIGHT audience.
//
// BKL-235 put ops-channel rows on the same `no_reply` journal the customer planes
// use, which means the same staff WhatsApp ping now fires for both. Its copy asserted
// "Uma falha de resposta automática impediu a entrega ao cliente." — FLATLY FALSE for
// an ops row: no customer was involved, a staff member's own operational command went
// unanswered. Sending the customer wording for an ops ghost tells the owner their
// customers are being dropped during what is actually an internal staff-channel
// hiccup, so these pin the branch in BOTH directions.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
// Typed params so `mock.calls` is indexable (an inferred zero-arg mock is not).
const mockSendText = vi.hoisted(() =>
  vi.fn(async (_to: string, _message: { text: string }) => {}),
);
const mockIsNewEvent = vi.hoisted(() => vi.fn(async () => true));
const mockPushToDlq = vi.hoisted(() => vi.fn(async () => {}));

const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
      return { unsubscribe: () => {} };
    },
  ),
}));

vi.mock("@ibatexas/tools", () => ({
  getWhatsAppSender: () => ({ sendText: mockSendText }),
  // Under the hourly cap → the per-incident ping (never the storm digest).
  getRedisClient: async () => ({ set: async () => "OK" }),
  atomicIncr: async () => 1,
  rk: (k: string) => `test:${k}`,
}));

vi.mock("../../subscribers/dedup.js", () => ({ isNewEvent: mockIsNewEvent }));
vi.mock("../../subscribers/dlq.js", () => ({ pushToDlq: mockPushToDlq }));

import { OPS_DASHBOARD_CHANNEL, OPS_WHATSAPP_CHANNEL } from "@ibatexas/domain";
import { startIncidentNotificationSubscriber } from "../../subscribers/incident-notification-subscriber.js";

/** Deliver one `conversation.incident_opened` and return the pt-BR message sent. */
async function pingFor(channel: string | undefined): Promise<string> {
  mockSendText.mockClear();
  await natsHandlers["conversation.incident_opened"]!({
    incidentId: `inc_${channel ?? "none"}`,
    sessionId: "sess_1",
    cause: "empty_completion",
    severity: "low",
    ...(channel !== undefined ? { channel } : {}),
  });
  expect(mockSendText).toHaveBeenCalledTimes(1);
  // sendText(to, RenderedReply) — the branded egress object carries the pt-BR body
  // on `.text` (mintBroadcastReply); read that, not the object.
  return mockSendText.mock.calls[0]![1].text;
}

beforeEach(async () => {
  process.env.STAFF_NOTIFICATION_PHONE = "+5511888888888";
  mockIsNewEvent.mockResolvedValue(true);
  await startIncidentNotificationSubscriber();
});

describe("BKL-235 — the staff incident ping names the right audience", () => {
  it("an OPS-WhatsApp row reports a STAFF-channel failure, never a customer one", async () => {
    const body = await pingFor(OPS_WHATSAPP_CHANNEL);

    expect(body).toContain("Incidente no canal operacional");
    expect(body).toContain("deixou um comando da equipe sem resposta");
    // The load-bearing negative: never claim a customer was dropped.
    expect(body).not.toContain("ao cliente");
  });

  it("an OPS-dashboard row reports the same staff-channel failure", async () => {
    const body = await pingFor(OPS_DASHBOARD_CHANNEL);

    expect(body).toContain("Incidente no canal operacional");
    expect(body).not.toContain("ao cliente");
  });

  it("PIN — a customer WhatsApp row keeps the original customer copy byte-for-byte", async () => {
    const body = await pingFor("whatsapp");

    expect(body).toContain("🚨 *Incidente no atendimento*");
    expect(body).toContain(
      "Uma falha de resposta automática impediu a entrega ao cliente.",
    );
    expect(body).not.toContain("canal operacional");
  });

  it("PIN — a customer web row keeps the customer copy", async () => {
    const body = await pingFor("web");

    expect(body).toContain("Uma falha de resposta automática impediu a entrega ao cliente.");
    expect(body).not.toContain("canal operacional");
  });

  it("PIN — an ABSENT channel falls back to the customer copy (unchanged legacy shape)", async () => {
    const body = await pingFor(undefined);

    expect(body).toContain("Uma falha de resposta automática impediu a entrega ao cliente.");
  });

  it("still carries the shared cause/severity/session lines on an ops row", async () => {
    const body = await pingFor(OPS_WHATSAPP_CHANNEL);

    expect(body).toContain("Sessão: sess_1");
    expect(body).toContain("Causa: resposta vazia do modelo");
    expect(body).toContain("Gravidade: baixa");
    expect(body).toContain("Verifique o painel de Incidentes.");
  });
});
