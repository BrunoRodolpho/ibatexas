// M1 — THE SESSION-ROLLOVER SHAPE CONTRACT. HGET/HSET idle rotation. REAL REDIS.
//
// Ruling: docs/architecture/redis-lua-testing-decision.md (Q2). Sibling:
// lua-shape-cad-contract.test.ts, whose header explains the source-text seam.
//
// SITE: apps/api/src/whatsapp/session.ts:75 `ROTATE_SESSION_SCRIPT` — one site,
// so this file is the shape.
//
// THE CONTRACT
//   1. Idle STRICTLY GREATER than the threshold rotates the session; anything
//      at or below it does not. The comparison is `>`, so the threshold itself
//      is a non-rotating value, and both sides of that edge are pinned below.
//   2. Every call stamps `lastMessageAt = now`, rotation or not.
//   3. A burst of concurrent messages after an idle gap produces ONE new
//      session, not one per message.
//
// Property 3 is the reason the script exists, in production's own words
// (`session.ts:113-116`): *"two concurrent messages after idle could both see
// stale lastMessageAt and both rotate, creating duplicate sessions. The Lua
// script does the check-and-rotate atomically in Redis."* A fragmented session
// is a customer whose cart and conversation state silently split in two.
//
// ── Clock discipline ─────────────────────────────────────────────────────────
//
// `now` is ARGV[2] and the threshold is ARGV[1] — both supplied by the caller,
// neither read from Redis's clock. So every case here drives time by passing
// it, and there is not one sleep in the file. Nothing is faked: the script
// genuinely has no other source of time.
//
// ── Coverage before this file ────────────────────────────────────────────────
//
// Zero real-Redis bytes. `apps/api/src/__tests__/whatsapp-session.test.ts:160`
// stubs the answer outright — `mockRedis.eval.mockResolvedValue("sess-cached")`
// — so the rotation decision under test is the mock's return value. That suite
// stays green with this script deleted.
//
// Gated by RUN_REAL_REDIS; enrolled in the M0 roll call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { extractLuaAfter } from "./helpers/lua-script-sources.js"
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js"

const SITE_FILE = "apps/api/src/whatsapp/session.ts"
const SITE_ANCHOR = "const ROTATE_SESSION_SCRIPT ="

const THRESHOLD_MS = 30 * 60 * 1000 // 30 min, the production shape of the value
const T0 = 1_700_000_000_000
const OLD_SESSION = "sess-old-0000"
const CANDIDATE = "sess-new-1111"

/**
 * Delete the idle comparison and nothing else — the conjunct-removal experiment
 * for this shape. Throws when there is nothing to remove.
 */
function stripIdleGuard(script: string): string {
  const guard = /lastMsg and \(now - tonumber\(lastMsg\)\) > threshold/
  if (!guard.test(script)) {
    throw new Error(`stripIdleGuard found no idle comparison to remove in: ${JSON.stringify(script)}`)
  }
  return script.replace(guard, "true")
}

describe.skipIf(!RUN_REAL_REDIS)(
  "Lua shape contract — WhatsApp session rollover (real Redis)",
  () => {
    let harness: RedisTestHarness
    let script: string

    beforeAll(async () => {
      harness = await setupRedisTestContainer()
      script = extractLuaAfter(SITE_FILE, SITE_ANCHOR)
    }, 120_000)

    afterAll(async () => {
      await harness?.teardown()
    })

    beforeEach(async () => {
      await harness.client.flushAll()
    })

    const KEY = "wa:session:rollover"

    /** Seed the hash the way `resolveWhatsAppSession` finds it. */
    const seed = async (lastMessageAt: number): Promise<void> => {
      await harness.client.hSet(KEY, {
        sessionId: OLD_SESSION,
        lastMessageAt: String(lastMessageAt),
      })
    }

    const rotate = async (
      now: number,
      candidate: string = CANDIDATE,
      threshold: number = THRESHOLD_MS,
    ): Promise<string | null> =>
      (await harness.client.eval(script, {
        keys: [KEY],
        arguments: [String(threshold), String(now), candidate],
      })) as string | null

    // ── 1. The idle boundary, from both sides ─────────────────────────────

    it("idle EXACTLY at the threshold does NOT rotate — the comparison is strict", async () => {
      await seed(T0)
      // now - lastMsg === threshold. `>` is false, so this is the LAST
      // non-rotating instant. An off-by-one to `>=` reds here and nowhere else.
      expect(await rotate(T0 + THRESHOLD_MS)).toBe(OLD_SESSION)
      expect(await harness.client.hGet(KEY, "sessionId")).toBe(OLD_SESSION)
    })

    it("idle ONE MILLISECOND past the threshold rotates", async () => {
      await seed(T0)
      expect(await rotate(T0 + THRESHOLD_MS + 1)).toBe(CANDIDATE)
      expect(await harness.client.hGet(KEY, "sessionId")).toBe(CANDIDATE)
    })

    it("a fresh message inside the window keeps the session and re-stamps the clock", async () => {
      await seed(T0)
      const now = T0 + 60_000
      expect(await rotate(now)).toBe(OLD_SESSION)
      expect(await harness.client.hGet(KEY, "sessionId")).toBe(OLD_SESSION)
      // Property 2: the clock is stamped on the NON-rotating path too. Without
      // it the window would be measured from the first message ever, and every
      // session would rotate exactly once and then never again.
      expect(await harness.client.hGet(KEY, "lastMessageAt")).toBe(String(now))
    })

    it("rotation stamps the clock and replaces the id in the same step", async () => {
      await seed(T0)
      const now = T0 + THRESHOLD_MS * 2
      expect(await rotate(now)).toBe(CANDIDATE)
      const after = await harness.client.hGetAll(KEY)
      expect(after["sessionId"]).toBe(CANDIDATE)
      expect(after["lastMessageAt"]).toBe(String(now))
    })

    it("the idle window is measured from the LAST message, not the first", async () => {
      await seed(T0)
      // A steady conversation: each message is inside the window relative to
      // the previous one, but the last is far past T0. Nothing may rotate.
      let now = T0
      for (let i = 0; i < 5; i += 1) {
        now += THRESHOLD_MS - 1_000
        expect(await rotate(now)).toBe(OLD_SESSION)
      }
      expect(now - T0).toBeGreaterThan(THRESHOLD_MS)
      expect(await harness.client.hGet(KEY, "sessionId")).toBe(OLD_SESSION)
    })

    it("a hash with no lastMessageAt does not rotate — an absent clock is not an idle one", async () => {
      // `lastMsg and …` short-circuits. A first-contact hash must keep the id
      // it was created with rather than being rotated on sight.
      await harness.client.hSet(KEY, { sessionId: OLD_SESSION })
      expect(await rotate(T0)).toBe(OLD_SESSION)
      expect(await harness.client.hGet(KEY, "lastMessageAt")).toBe(String(T0))
    })

    // ── 2. Atomicity — the defect production's comment names ──────────────

    it("a concurrent burst after an idle gap produces exactly ONE new session", async () => {
      // Q3: bounded iteration, invariant asserted per iteration.
      for (let round = 0; round < 5; round += 1) {
        await harness.client.del(KEY)
        await seed(T0)
        const now = T0 + THRESHOLD_MS + 5_000

        // 20 messages land at once, each carrying its OWN candidate id.
        const candidates = Array.from({ length: 20 }, (_, i) => `sess-cand-${round}-${i}`)
        const resolved = await Promise.all(candidates.map((c) => rotate(now, c)))

        // Exactly one candidate was adopted; every caller was told the same id.
        const adopted = [...new Set(resolved)]
        expect(adopted).toHaveLength(1)
        expect(candidates).toContain(adopted[0])
        expect(await harness.client.hGet(KEY, "sessionId")).toBe(adopted[0])
      }
    })

    it("control — a non-atomic read-then-rotate fragments the burst into many sessions", async () => {
      // The same 20 messages, with the check and the write done from the client
      // — production's "two concurrent messages could both see stale
      // lastMessageAt and both rotate". If the case above were passing for some
      // other reason, this would report one session too, and fail.
      await seed(T0)
      const now = T0 + THRESHOLD_MS + 5_000

      const rotateNonAtomically = async (candidate: string): Promise<string | null> => {
        const lastMsg = await harness.client.hGet(KEY, "lastMessageAt")
        if (lastMsg !== undefined && lastMsg !== null && now - Number(lastMsg) > THRESHOLD_MS) {
          await harness.client.hSet(KEY, {
            sessionId: candidate,
            lastMessageAt: String(now),
          })
          return candidate
        }
        await harness.client.hSet(KEY, { lastMessageAt: String(now) })
        return (await harness.client.hGet(KEY, "sessionId")) ?? null
      }

      const resolved = await Promise.all(
        Array.from({ length: 20 }, (_, i) => rotateNonAtomically(`sess-frag-${i}`)),
      )
      expect(new Set(resolved).size).toBeGreaterThan(1)
    })

    // ── 3. CONJUNCT-REMOVAL CONTROL ───────────────────────────────────────

    it("with the idle comparison REMOVED, every message rotates the session", async () => {
      const mutated = stripIdleGuard(script)
      expect(mutated).not.toBe(script)

      await seed(T0)
      // Byte-identical to the in-window case above, which must NOT rotate.
      const now = T0 + 60_000
      const result = (await harness.client.eval(mutated, {
        keys: [KEY],
        arguments: [String(THRESHOLD_MS), String(now), CANDIDATE],
      })) as string | null

      expect(result).toBe(CANDIDATE)
      expect(await harness.client.hGet(KEY, "sessionId")).toBe(CANDIDATE)
    })

    // ── 4. Blast radius ───────────────────────────────────────────────────

    it("the rotation writes only sessionId and lastMessageAt, leaving sibling fields alone", async () => {
      await harness.client.hSet(KEY, {
        sessionId: OLD_SESSION,
        lastMessageAt: String(T0),
        customerId: "cus_keepme",
        phone: "+5511999999999",
      })
      expect(await rotate(T0 + THRESHOLD_MS + 1)).toBe(CANDIDATE)

      const after = await harness.client.hGetAll(KEY)
      expect(after["customerId"]).toBe("cus_keepme")
      expect(after["phone"]).toBe("+5511999999999")
      expect(Object.keys(after).sort()).toEqual([
        "customerId",
        "lastMessageAt",
        "phone",
        "sessionId",
      ])
    })
  },
)
