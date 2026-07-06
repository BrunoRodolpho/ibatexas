// incident-subscriber — H1 durable-backstop idempotency.
//
// The durable backstop must commit its 7-day dedup key ONLY after the side
// effect SUCCEEDS (two-phase withDedup), and must NOT ack-suppress a transient
// failure. Pre-fix it used single-phase isNewEvent (key committed BEFORE the
// side effect) and SWALLOWED a kind:"error" result → on a transient DB failure
// the message was acked and the committed key suppressed all redelivery for 7
// days, silently losing the owed reply. These tests drive the real withDedup
// against a fake Redis and assert the full-TTL key is committed only on success.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockOpenIncidentInline = vi.hoisted(() => vi.fn());
const mockDeriveEventId = vi.hoisted(() => vi.fn(() => "evt_1"));
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisDel = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());

const natsHandlers: Record<string, (payload: unknown) => Promise<void>> = {};

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent.mockImplementation(
    async (event: string, handler: (payload: unknown) => Promise<void>) => {
      natsHandlers[event] = handler;
      return { unsubscribe: () => {} };
    },
  ),
}));

vi.mock("@ibatexas/domain", () => ({
  prisma: {
    conversationIncident: {
      create: mockCreate,
      findFirst: mockFindFirst,
      update: mockUpdate,
    },
  },
  FROZEN_CAUSES: ["send_failed", "timeout", "empty_completion"],
}));

vi.mock("../../conversation/no-delivery.js", () => ({
  deriveEventId: mockDeriveEventId,
  openIncidentInline: mockOpenIncidentInline,
}));

// Drive the REAL withDedup (dedup.js) against a fake Redis so we can assert the
// exact TTLs written: EX=300 (short in-flight claim) vs EX=604800 (full dedup).
vi.mock("@ibatexas/tools", () => ({
  getRedisClient: vi.fn(async () => ({ set: mockRedisSet, del: mockRedisDel })),
  rk: (k: string) => `test:${k}`,
}));

import { startIncidentSubscriber } from "../../subscribers/incident-subscriber.js";

const FULL_TTL = 604_800; // withDedup's markProcessed EX — "processed, suppress 7 days"

const signalPayload = {
  sessionId: "wa:5511999999999",
  cause: "empty_completion",
  channel: "whatsapp",
  turnId: "turn_1",
  customerImpacted: true,
};

async function getHandler(): Promise<(payload: unknown) => Promise<void>> {
  await startIncidentSubscriber();
  return natsHandlers["conversation.no_delivery"]!;
}

function committedFullTtl(): boolean {
  return mockRedisSet.mock.calls.some(
    ([, , opts]) => (opts as { EX?: number } | undefined)?.EX === FULL_TTL,
  );
}

describe("incident-subscriber — H1 two-phase durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeriveEventId.mockReturnValue("evt_1");
    mockRedisSet.mockResolvedValue("OK"); // Phase-1 claim (SET NX) succeeds
  });

  it("does NOT commit the dedup key and rethrows on a transient open failure (kind:error)", async () => {
    mockOpenIncidentInline.mockResolvedValue({
      kind: "error",
      error: new Error("db down"),
    });
    const handler = await getHandler();

    // Surfaced (not swallowed) → subscribeNatsEvent nak's (JetStream) / DLQs (Core).
    await expect(handler(signalPayload)).rejects.toThrow();

    // The 7-day suppression key was NEVER committed → the owed reply is redeliverable.
    expect(committedFullTtl()).toBe(false);
    // The in-flight claim was released so a redelivery can reprocess.
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it("commits the dedup key on a successful open (kind:opened)", async () => {
    mockOpenIncidentInline.mockResolvedValue({ kind: "opened", incidentId: "inc_1" });
    const handler = await getHandler();

    await expect(handler(signalPayload)).resolves.toBeUndefined();

    expect(committedFullTtl()).toBe(true);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it("commits the dedup key on a genuine duplicate (kind:duplicate, idempotent no-op)", async () => {
    mockOpenIncidentInline.mockResolvedValue({ kind: "duplicate" });
    const handler = await getHandler();

    await handler(signalPayload);

    expect(committedFullTtl()).toBe(true);
  });
});

describe("incident-subscriber — [#3] suspect-row P2002 disambiguation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeriveEventId.mockReturnValue("evt_1");
    mockRedisSet.mockResolvedValue("OK");
    // Governance REFUSED the governed open → the durable backstop persists a
    // flagged suspect row so the owed reply is never silently lost.
    mockOpenIncidentInline.mockResolvedValue({ kind: "refused", cause: "bogus_cause", code: "X" });
  });

  it("session-open collision ATTACHES the suspect to the existing open incident (not dropped)", async () => {
    // The suspect create loses to the per-session open-incident partial unique
    // index — the session already has a DIFFERENT open incident. The owed reply
    // MUST be attached to it, never silently dropped.
    mockCreate.mockRejectedValue(
      Object.assign(new Error("dup"), {
        code: "P2002",
        meta: { target: "conversation_incidents_session_open_uq" },
      }),
    );
    mockFindFirst.mockResolvedValue({ id: "inc_open", customerImpacted: false, detail: "prior" });
    mockUpdate.mockResolvedValue({});

    const handler = await getHandler();
    await handler(signalPayload);

    expect(mockFindFirst).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inc_open" },
        data: expect.objectContaining({
          dropCount: { increment: 1 },
          customerImpacted: true, // monotonic: false || signal.true
        }),
      }),
    );
    // The owed reply was recorded → the two-phase dedup key commits.
    expect(committedFullTtl()).toBe(true);
  });

  it("external_id collision is an idempotent no-op (redelivered suspect) — no attach", async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error("dup"), {
        code: "P2002",
        meta: { target: "conversation_incidents_external_id_key" },
      }),
    );

    const handler = await getHandler();
    await handler(signalPayload);

    // A redelivered suspect: neither re-read nor attach — just skip.
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
