// BKL-286 — guest web-chat stream credential propagation.
//
// WHY A SEPARATE FILE (and a KEYED Redis): chat-route.test.ts drives every
// stream-delivery case with `mockRedisGet.mockResolvedValue(null)` — one blanket
// value for EVERY key. That makes the guest happy path structurally unable to
// see this defect: after a real POST there IS a `session:secret:<id>` in Redis,
// so a blanket-null Redis tests a state the product never reaches. Here the
// fake Redis is a real keyed map, so a POST's mint is visible to the GET exactly
// as it is in production, and the two requests compose the way the browser
// composes them.
//
// What this pins down:
//   - the POST→GET guest sequence (the ONLY sequence the widget ever performs)
//   - the owner's measured double-message failure (stale secret, re-mint)
//   - the hijack attempt: a WRONG secret is still denied (P2-SEC-SSECORS)
//   - secret TTL expiry mid-conversation

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { mintRenderedReply } from "@adjudicate/core";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockCreateSessionToken = vi.hoisted(() => vi.fn());
const mockVerifySessionToken = vi.hoisted(() => vi.fn());

const mockHandleTurn = vi.hoisted(() => vi.fn());
const mockGetConductor = vi.hoisted(() => vi.fn());
const mockOpenCapsule = vi.hoisted(() => vi.fn());
const mockCloseCapsule = vi.hoisted(() => vi.fn());

const mockLoadSession = vi.hoisted(() => vi.fn());
const mockAppendMessages = vi.hoisted(() => vi.fn());

const mockCreateStream = vi.hoisted(() => vi.fn());
const mockPushChunk = vi.hoisted(() => vi.fn());
const mockGetStream = vi.hoisted(() => vi.fn());
const mockSubscribeToStream = vi.hoisted(() => vi.fn());
const mockCleanupStream = vi.hoisted(() => vi.fn());

const mockAcquireLock = vi.hoisted(() => vi.fn());
const mockReleaseLock = vi.hoisted(() => vi.fn());

const mockIsSessionPausedForHuman = vi.hoisted(() => vi.fn());
const mockIsPaused = vi.hoisted(() => vi.fn());
const mockGetEscalationStore = vi.hoisted(() => vi.fn());

const mockEmitNoDelivery = vi.hoisted(() => vi.fn());
const mockOpenIncidentInline = vi.hoisted(() => vi.fn());
const mockCloseIncidentOnDeliveredReply = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (k: string) => `ibatexas:${k}`,
  createSessionToken: mockCreateSessionToken,
  verifySessionToken: mockVerifySessionToken,
}));

vi.mock("@claustrum/core", () => ({ handleTurn: mockHandleTurn }));

vi.mock("../../middleware/auth.js", () => ({
  optionalAuth: (
    request: { headers: Record<string, string>; customerId?: string },
    _reply: unknown,
    done: () => void,
  ) => {
    const cid = request.headers["x-test-customer-id"];
    if (cid) request.customerId = cid;
    done();
  },
}));

vi.mock("../../session/store.js", () => ({
  loadSession: mockLoadSession,
  appendMessages: mockAppendMessages,
}));

vi.mock("../../streaming/emitter.js", () => ({
  createStream: mockCreateStream,
  pushChunk: mockPushChunk,
  getStream: mockGetStream,
  subscribeToStream: mockSubscribeToStream,
  cleanupStream: mockCleanupStream,
  chunkToWire: (chunk: { type: string; delta?: { text: string } }) =>
    chunk.type === "text_delta" ? { type: "text_delta", delta: chunk.delta?.text } : chunk,
}));

vi.mock("../../streaming/execution-queue.js", () => ({
  acquireWebAgentLock: mockAcquireLock,
  releaseWebAgentLock: mockReleaseLock,
}));

vi.mock("../../claustrum-bootstrap.js", () => ({ getConductor: mockGetConductor }));

vi.mock("../../escalation/escalation-store.js", () => ({
  isSessionPausedForHuman: mockIsSessionPausedForHuman,
  getEscalationStore: mockGetEscalationStore,
}));

vi.mock("../../conversation/no-delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conversation/no-delivery.js")>();
  return {
    ...actual,
    emitNoDelivery: mockEmitNoDelivery,
    openIncidentInline: mockOpenIncidentInline,
  };
});

vi.mock("../../incidents/incident-auto-close.js", () => ({
  closeIncidentOnDeliveredReply: mockCloseIncidentOnDeliveredReply,
}));

import { chatRoutes } from "../chat.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const SID = "22222222-2222-4222-8222-222222222222";
const SECRET_KEY = `ibatexas:session:secret:${SID}`;

/** A REAL keyed store — a mint by the POST is visible to the GET, as in prod. */
function makeKeyedRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

let redis: ReturnType<typeof makeKeyedRedis>;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(chatRoutes);
  await app.ready();
  return app;
}

/** POST a guest message exactly as the widget does (secret header when held). */
async function guestPost(app: FastifyInstance, heldSecret?: string) {
  return app.inject({
    method: "POST",
    url: "/api/chat/messages",
    payload: { sessionId: SID, message: "quero costela", channel: "web" },
    ...(heldSecret ? { headers: { "x-session-secret": heldSecret } } : {}),
  });
}

/** Open the SSE stream carrying `secret` (undefined = send no credential). */
async function guestStream(app: FastifyInstance, secret?: string) {
  return app.inject({
    method: "GET",
    url: `/api/chat/stream/${SID}`,
    ...(secret ? { headers: { "x-session-secret": secret } } : {}),
  });
}

/** A terminated local stream so an ALLOWED consumer gets real chunks. */
function armDeliverableStream(): void {
  mockGetStream.mockReturnValue({
    emitter: new EventEmitter(),
    buffer: [
      { type: "text_delta", delta: mintRenderedReply("temos costela sim") },
      { type: "done" },
    ],
    seq: 2,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CORS_ORIGIN", "");
  vi.stubEnv("SSE_HEARTBEAT_MS", "0");

  redis = makeKeyedRedis();
  mockGetRedisClient.mockResolvedValue(redis);

  mockCreateSessionToken.mockReturnValue("session-token-xyz");
  mockVerifySessionToken.mockReturnValue(null);
  mockLoadSession.mockResolvedValue([]);
  mockAppendMessages.mockResolvedValue(undefined);
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockIsSessionPausedForHuman.mockResolvedValue(false);
  mockIsPaused.mockResolvedValue(false);
  mockGetEscalationStore.mockResolvedValue({ isPaused: mockIsPaused });
  mockOpenCapsule.mockResolvedValue({ id: "capsule-1", turnId: "turn-1" });
  mockCloseCapsule.mockResolvedValue(undefined);
  mockGetConductor.mockReturnValue({
    openCapsule: mockOpenCapsule,
    closeCapsule: mockCloseCapsule,
  });
  mockHandleTurn.mockResolvedValue({
    response: { text: "temos costela sim" },
    decision: { kind: "EXECUTE" },
  });
  mockEmitNoDelivery.mockResolvedValue(undefined);
  mockOpenIncidentInline.mockResolvedValue({ kind: "opened", incidentId: "inc-1" });
  mockCloseIncidentOnDeliveredReply.mockResolvedValue(undefined);

  armDeliverableStream();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── LEG 1: the credential must reach the stream ─────────────────────────────

describe("BKL-286 leg 1 — guest POST→stream carries the CURRENT secret", () => {
  it("fresh guest session: the stream opened after the minting POST is SERVED, not denied", async () => {
    const app = await buildApp();

    const post = await guestPost(app);
    expect(post.statusCode).toBe(200);
    const minted = post.json().sessionSecret as string;
    expect(minted).toBeTruthy();
    expect(redis.store.get(SECRET_KEY)).toBe(minted);

    // The widget adopts the minted secret and opens the stream with it.
    const stream = await guestStream(app, minted);

    expect(stream.payload).not.toContain("Acesso negado.");
    expect(stream.payload).toContain('"delta":"temos costela sim"');
    expect(stream.payload).toContain('"type":"done"');
    await app.close();
  });

  it("the owner's measured double-message sequence heals: stale secret → re-mint → BOTH streams served", async () => {
    const app = await buildApp();

    // The browser holds a secret from a previous visit; Redis lost it (TTL/repair).
    const STALE = "stale-secret-from-a-previous-visit";
    expect(redis.store.has(SECRET_KEY)).toBe(false);

    // ── message 1: POST re-mints, and the stream must use the NEW secret ──
    const post1 = await guestPost(app, STALE);
    expect(post1.statusCode).toBe(200);
    const reminted = post1.json().sessionSecret as string;
    expect(reminted).toBeTruthy();
    expect(reminted).not.toBe(STALE);

    const stream1 = await guestStream(app, reminted);
    expect(stream1.payload).not.toContain("Acesso negado.");
    expect(stream1.payload).toContain('"type":"done"');

    // ── message 2: the adopted secret now matches; nothing is re-minted ──
    const post2 = await guestPost(app, reminted);
    expect(post2.statusCode).toBe(200);
    expect(post2.json().sessionSecret).toBeUndefined();

    const stream2 = await guestStream(app, reminted);
    expect(stream2.payload).not.toContain("Acesso negado.");
    expect(stream2.payload).toContain('"type":"done"');

    await app.close();
  });

  it("secret TTL expiry MID-conversation: the next POST re-mints and its stream is served", async () => {
    const app = await buildApp();

    const post1 = await guestPost(app);
    const first = post1.json().sessionSecret as string;
    expect(await guestStream(app, first)).toMatchObject({});

    // 1h TTL elapses — Redis drops the key while the tab stays open.
    redis.store.delete(SECRET_KEY);

    const post2 = await guestPost(app, first);
    expect(post2.statusCode).toBe(200);
    const second = post2.json().sessionSecret as string;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    const stream2 = await guestStream(app, second);
    expect(stream2.payload).not.toContain("Acesso negado.");
    expect(stream2.payload).toContain('"type":"done"');

    // The STALE secret must NOT open the stream any more.
    const hijack = await guestStream(app, first);
    expect(hijack.payload).toContain("Acesso negado.");

    await app.close();
  });
});

// ── LEG 1 (security): the fix must not weaken P2-SEC-SSECORS ────────────────

describe("BKL-286 leg 1 — hijack protection is intact (P2-SEC-SSECORS)", () => {
  it("a WRONG secret is denied even though a valid session exists", async () => {
    const app = await buildApp();

    const post = await guestPost(app);
    const legit = post.json().sessionSecret as string;
    expect(legit).toBeTruthy();

    // Attacker knows the sessionId (it is in the URL) but not the secret.
    const attacker = await guestStream(app, "attacker-guessed-secret");
    expect(attacker.payload).toContain('"type":"error"');
    expect(attacker.payload).toContain("Acesso negado.");
    expect(attacker.payload).not.toContain("temos costela sim");

    // The legitimate holder is still served — the denial is credential-scoped.
    const owner = await guestStream(app, legit);
    expect(owner.payload).toContain('"delta":"temos costela sim"');

    await app.close();
  });

  it("the denial frame carries a machine-readable code so the client need not match prose", async () => {
    const app = await buildApp();

    await guestPost(app);
    const denied = await guestStream(app, "wrong");

    expect(denied.payload).toContain('"code":"session_denied"');
    // The pt-BR prose stays on the wire for any client that predates the code.
    expect(denied.payload).toContain("Acesso negado.");
    await app.close();
  });

  it("an ALLOWED stream carries no error code — the field marks denials only", async () => {
    const app = await buildApp();

    const post = await guestPost(app);
    const served = await guestStream(app, post.json().sessionSecret as string);

    expect(served.payload).not.toContain("session_denied");
    await app.close();
  });

  it("NO credential at all is denied once a secret exists for the session", async () => {
    const app = await buildApp();

    const post = await guestPost(app);
    expect(post.json().sessionSecret).toBeTruthy();

    const anonymous = await guestStream(app, undefined);
    expect(anonymous.payload).toContain("Acesso negado.");
    expect(anonymous.payload).not.toContain("temos costela sim");

    await app.close();
  });
});
