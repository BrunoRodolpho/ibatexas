// R5 rollout, webhook/chat family — `routes/chat.ts`'s Redis-client seam,
// BORN GUARDED.
//
// This is the family's file where the fail-closed Pick rule does real work, so
// the suite is built around it rather than around the call sites.
//
// ── Why the Pick is {get, set} and not {set} ─────────────────────────────────
//
// The POST handler issues exactly ONE command on the client it resolves — the
// sliding `session:lastActivity` `set` — and then HANDS THAT CLIENT to two
// module-local helpers:
//
//   `rejectOnOwnershipFailure(redis, …)`  →  `get` (owner key) + `set` (the
//                                            sliding 24h re-assert)
//   `resolveGuestSecret(redis, …)`        →  `get` (secret) + `set` (mint)
//
// A Pick derived from the handler's own text is `{set}`, and `get` would be
// ABSENT. That is #539 exactly: on a throw-on-access client the first helper
// dies on `redis.get`, and what it guards is session OWNERSHIP. So this file
// does NOT stop at the line the handler writes — every case below drives one
// of the two helpers, which is the only way the `get` half of the Pick is
// covered at all.
//
// ── Directional pins, not happy paths ────────────────────────────────────────
//
// Each guard is pinned by the REFUSAL it exists to produce, paired with a
// control in the SAME test that must get through — otherwise "403" is equally
// satisfied by a route that refuses everyone:
//
//   1. OWNERSHIP — an owner key belonging to customer A on the INJECTED
//      keyspace must 403 customer B, while A gets past the same gate.
//   2. GUEST SECRET — a secret minted on the INJECTED keyspace must 403 a
//      WRONG credential, while the minted one gets past.
//   3. STREAM ACCESS — the SSE guard reads the same injected owner key and
//      denies a stranger, while the owner is let through.
//
// ── Where the requests stop ─────────────────────────────────────────────────
//
// `acquireWebAgentLock` is stubbed to refuse, so an ALLOWED POST answers 409
// immediately AFTER the seam has issued every command in the Pick and BEFORE
// the conductor turn. That is deliberate: 409 is the "got past every Redis
// gate" signal in this file, and it keeps the turn machinery — which has
// nothing to do with this seam — out of the suite entirely.
//
// ── Why the decoy/injected pair ──────────────────────────────────────────────
//
// A seam test that only injects a client proves NOTHING: the module could
// ignore the argument and resolve the singleton, and every assertion would
// still pass because the test's own double IS the singleton. Two DISTINCT
// clients run here — `decoy` (what `getRedisClient()` returns; untouchable in
// an injected case) and `injected` (what `deps.redis` hands over).
//
// The DEFAULT arms are what make the injected cases non-vacuous. They are NOT
// themselves seam evidence — a neutered route keeps them green by construction
// — and are EXCLUDED from the revert-to-red counts.
//
// ── Clock discipline ─────────────────────────────────────────────────────────
//
// TTLs are EXACT remaining lifetimes on a FROZEN clock: 86_400_000 ms for the
// owner key and the activity heartbeat (`EX: 86400`), 3_600_000 ms for the
// guest secret (`EX: 3600`). The owner-key TTL in particular is load-bearing
// rather than bookkeeping — the route's own comment records why: it SLIDES on
// every authenticated POST, which is what makes "owner key absent" mean
// "genuinely idle for 24h" instead of "claimed a day ago". `toBeGreaterThan(0)`
// cannot tell those apart.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

// Assigned in beforeEach. The `vi.mock` factory closes over it LAZILY — it is
// only read when `getRedisClient()` is actually CALLED, which in a correctly
// threaded + injected request is never.
let decoy: InMemoryRedis;

/** A frozen instant, so every TTL below is an exact equality. */
const FROZEN = 1_700_000_000_000;

/** `session:owner` and `session:lastActivity`: `EX: 86400`. */
const DAY_TTL_MS = 86_400_000;

/** `session:secret`: `EX: 3600`. */
const SECRET_TTL_MS = 3_600_000;

const SID = "11111111-2222-4333-8444-555555555555";
const CUSTOMER_A = "cust_alpha";
const CUSTOMER_B = "cust_beta";

const mockAcquireWebAgentLock = vi.hoisted(() => vi.fn());
const mockReleaseWebAgentLock = vi.hoisted(() => vi.fn());
const mockGetStream = vi.hoisted(() => vi.fn());
const mockSubscribeToStream = vi.hoisted(() => vi.fn());

// Spread the REAL module and replace ONLY `getRedisClient`. `rk` stays REAL —
// Hard Rule #7 — so every key under assertion is the key production writes.
// Under apps/api's vitest that prefix is `development:`, which is exactly what
// the pre-existing chat suites fake as `ibatexas:` — a prefix production has
// never written.
//
// `getOrCreateCart` is deliberately NOT replaced: it is one of the two
// Lua-bearing SELF-RESOLVING callees this seam leaves alone on purpose, and no
// case here reaches it (every POST stops at the 409).
vi.mock("@ibatexas/tools", async (orig) => {
  const real = await orig<typeof import("@ibatexas/tools")>();
  return { ...real, getRedisClient: vi.fn(async () => decoy.client) };
});

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

// The other Lua-bearing self-resolving callee. Stubbed to REFUSE so an allowed
// POST answers 409 right after the seam's commands — see the header.
vi.mock("../../streaming/execution-queue.js", () => ({
  acquireWebAgentLock: mockAcquireWebAgentLock,
  releaseWebAgentLock: mockReleaseWebAgentLock,
}));

vi.mock("../../streaming/emitter.js", () => ({
  createStream: vi.fn(),
  pushChunk: vi.fn(),
  getStream: mockGetStream,
  subscribeToStream: mockSubscribeToStream,
  cleanupStream: vi.fn(),
  chunkToWire: (chunk: unknown) => chunk,
}));

vi.mock("../../session/store.js", () => ({
  loadSession: vi.fn(async () => []),
  appendMessages: vi.fn(async () => undefined),
}));

vi.mock("@claustrum/core", () => ({ handleTurn: vi.fn() }));

vi.mock("../../claustrum-bootstrap.js", () => ({ getConductor: vi.fn() }));

function freshInjected(): InMemoryRedis {
  return createInMemoryRedis({ now: () => FROZEN });
}

/**
 * `injected` omitted ⇒ the DEFAULT arm: no `deps.redis`, so the route must
 * fall back to `getRedisClient()` — i.e. the decoy.
 */
async function buildServer(injected?: InMemoryRedis): Promise<FastifyInstance> {
  const { chatRoutes } = await import("../chat.js");
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(chatRoutes, {
    deps: injected
      ? { redis: async () => injected.client as unknown as never }
      : undefined,
  });
  await app.ready();
  return app;
}

interface InjectedResponse {
  readonly statusCode: number;
  readonly body: string;
}

async function postMessage(
  app: FastifyInstance,
  opts: { customerId?: string; secret?: string; sessionId?: string },
): Promise<InjectedResponse> {
  const headers: Record<string, string> = {};
  if (opts.customerId) headers["x-test-customer-id"] = opts.customerId;
  if (opts.secret) headers["x-session-secret"] = opts.secret;
  return app.inject({
    method: "POST",
    url: "/api/chat/messages",
    payload: { sessionId: opts.sessionId ?? SID, message: "oi", channel: "web" },
    headers,
  });
}

async function openStream(
  app: FastifyInstance,
  opts: { customerId?: string; secret?: string },
): Promise<InjectedResponse> {
  const headers: Record<string, string> = {};
  if (opts.customerId) headers["x-test-customer-id"] = opts.customerId;
  if (opts.secret) headers["x-session-secret"] = opts.secret;
  return app.inject({ method: "GET", url: `/api/chat/stream/${SID}`, headers });
}

/** A terminated local stream, so an ALLOWED consumer gets a real response. */
function armDeliverableStream(): void {
  mockGetStream.mockReturnValue({
    emitter: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
    buffer: [{ type: "done" }],
    done: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  decoy = createInMemoryRedis({ now: () => FROZEN });
  // Refuse the agent lock: an ALLOWED post stops at 409, right after the seam.
  mockAcquireWebAgentLock.mockResolvedValue(false);
  mockGetStream.mockReturnValue(undefined);
  mockSubscribeToStream.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  // Deliberately NO `vi.resetModules()`. Recorded by #548 at ~10 red cases of
  // diagnosis cost: resetting modules drops the audit-sink singleton that
  // `apps/api`'s `setupFiles` initialises ONCE — a PERFECT counterfeit of a
  // broken seam, reddening exactly the injected cases and leaving every
  // fallback arm green. If this file ever fails in that shape, check for a
  // `resetModules` before believing the seam is broken.
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/chat/messages — the authenticated half (`get` + `set`)
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — chat session ownership drives the INJECTED client", () => {
  it("[directional — OWNERSHIP REFUSED from the injected keyspace] a session owned by A rejects B with 403, while A gets past the same gate in the SAME test", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    // The owner key IS the decision on the fast path — `decideSessionClaim`
    // short-circuits on a non-empty owner and never reaches its durable
    // backstop, so this case is decided entirely by the injected keyspace.
    await injected.client.set(rk(`session:owner:${SID}`), CUSTOMER_A, { EX: 86400 });

    const app = await buildServer(injected);
    try {
      const intruder = await postMessage(app, { customerId: CUSTOMER_B });
      expect(intruder.statusCode).toBe(403);

      // The CONTROL, in the SAME test. Without it, "403" is equally satisfied
      // by a gate that refuses everyone — including the real owner.
      const owner = await postMessage(app, { customerId: CUSTOMER_A });
      // 409 = past every Redis gate, stopped at the agent lock.
      expect(owner.statusCode).toBe(409);

      // The seam: the whole decision ran on the injected keyspace.
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("SLIDES the owner key on the injected keyspace to exactly 24h on an authenticated post, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const ownerKey = rk(`session:owner:${SID}`);
    // Seeded with a SHORTER life than the re-assert writes, so the assertion
    // below distinguishes "the set ran" from "the seed is still here".
    await injected.client.set(ownerKey, CUSTOMER_A, { EX: 60 });

    const app = await buildServer(injected);
    try {
      const res = await postMessage(app, { customerId: CUSTOMER_A });
      expect(res.statusCode).toBe(409);

      expect(injected.peek(ownerKey)).toBe(CUSTOMER_A);
      // EXACT, on a frozen clock. This `set` is the backstop's clock — see the
      // header — so a wrong window is a security property, not cosmetics.
      expect(injected.ttlMs(ownerKey)).toBe(DAY_TTL_MS);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("writes the activity heartbeat to the injected keyspace at exactly 24h", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    await injected.client.set(rk(`session:owner:${SID}`), CUSTOMER_A, { EX: 86400 });

    const app = await buildServer(injected);
    try {
      const res = await postMessage(app, { customerId: CUSTOMER_A });
      expect(res.statusCode).toBe(409);

      const key = rk(`session:lastActivity:${SID}`);
      // The VALUE is `new Date().toISOString()` off the WALL clock — the
      // adapter's injected `now` drives TTLs, not the route's own timestamps —
      // so this asserts the shape written, and the TTL below carries the exact
      // equality. Asserting the value against FROZEN would be asserting a
      // clock the production line never reads.
      expect(injected.peek(key)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(injected.ttlMs(key)).toBe(DAY_TTL_MS);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — EXCLUDED from the RTR counts] with no deps.redis the ownership gate runs on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    await decoy.client.set(rk(`session:owner:${SID}`), CUSTOMER_A, { EX: 86400 });

    const app = await buildServer();
    try {
      const intruder = await postMessage(app, { customerId: CUSTOMER_B });
      expect(intruder.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/chat/messages — the guest half (`get` + `set`)
// ═══════════════════════════════════════════════════════════════════════════

describe("seam — chat guest secret drives the INJECTED client", () => {
  it("mints the guest secret on the INJECTED keyspace at exactly 1h, echoes it, and never touches the singleton", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    const app = await buildServer(injected);
    try {
      const res = await postMessage(app, {});
      expect(res.statusCode).toBe(409);

      const key = rk(`session:secret:${SID}`);
      const minted = injected.peek(key);
      // A real value on the injected keyspace, not a recorded call.
      expect(minted).toMatch(/^[0-9a-f-]{36}$/);
      expect(injected.ttlMs(key)).toBe(SECRET_TTL_MS);
      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — WRONG CREDENTIAL REFUSED from the injected keyspace] a bad x-session-secret gets 403, while the minted one gets past in the SAME test", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    await injected.client.set(rk(`session:secret:${SID}`), "the-real-secret", { EX: 3600 });

    const app = await buildServer(injected);
    try {
      const hijack = await postMessage(app, { secret: "not-the-secret" });
      expect(hijack.statusCode).toBe(403);

      // The CONTROL, in the SAME test — rules out "refuses every guest".
      const legit = await postMessage(app, { secret: "the-real-secret" });
      expect(legit.statusCode).toBe(409);

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — EXCLUDED from the RTR counts] with no deps.redis the guest secret is minted on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    const app = await buildServer();
    try {
      const res = await postMessage(app, {});
      expect(res.statusCode).toBe(409);
      expect(decoy.peek(rk(`session:secret:${SID}`))).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await app.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/chat/stream/:sessionId — the SSE access guard (`get`)
// ═══════════════════════════════════════════════════════════════════════════
//
// A SEPARATE site with a SEPARATE Pick (`get` only) and its own resolver
// parameter, so a seam proven on the POST says nothing about it.

describe("seam — chat SSE access guard drives the INJECTED client", () => {
  it("[directional — STREAM DENIED from the injected keyspace] a stranger is refused the owner's stream, while the owner is let through in the SAME test", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    await injected.client.set(rk(`session:owner:${SID}`), CUSTOMER_A, { EX: 86400 });

    const app = await buildServer(injected);
    try {
      const stranger = await openStream(app, { customerId: CUSTOMER_B });
      expect(stranger.body).toContain("Acesso negado");

      // The CONTROL, in the SAME test: the owner must NOT be denied, which is
      // what rules out a guard that refuses every stream.
      armDeliverableStream();
      const owner = await openStream(app, { customerId: CUSTOMER_A });
      expect(owner.body).not.toContain("Acesso negado");

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[directional — GUEST STREAM DENIED] a wrong x-session-secret cannot read a secret-bearing stream, while the right one can in the SAME test", async () => {
    const { rk } = await import("@ibatexas/tools");
    const injected = freshInjected();
    await injected.client.set(rk(`session:secret:${SID}`), "stream-secret", { EX: 3600 });

    const app = await buildServer(injected);
    try {
      const hijack = await openStream(app, { secret: "wrong" });
      expect(hijack.body).toContain("Acesso negado");

      armDeliverableStream();
      const legit = await openStream(app, { secret: "stream-secret" });
      expect(legit.body).not.toContain("Acesso negado");

      expect(decoy.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("[default arm — EXCLUDED from the RTR counts] with no deps.redis the stream guard runs on the SINGLETON", async () => {
    const { rk } = await import("@ibatexas/tools");
    await decoy.client.set(rk(`session:owner:${SID}`), CUSTOMER_A, { EX: 86400 });

    const app = await buildServer();
    try {
      const stranger = await openStream(app, { customerId: CUSTOMER_B });
      expect(stranger.body).toContain("Acesso negado");
    } finally {
      await app.close();
    }
  });
});
