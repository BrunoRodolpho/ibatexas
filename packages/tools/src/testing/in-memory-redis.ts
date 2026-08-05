// @ibatexas/tools/testing — the canonical in-memory Redis-shaped client.
//
// ── What this is ──────────────────────────────────────────────────────────────
//
// A keyspace with Redis' COMMAND semantics, published as part of this package's
// test surface so every consumer shares ONE double instead of hand-rolling a
// `vi.fn()` per command per test file. Pass it where a module takes a client:
//
//     const redis = createInMemoryRedis()
//     await invalidateDeliveryCache({ client: redis.client })
//     expect(redis.keys()).toEqual([])
//
// R5-S6 scope: the commands `@ibatexas/tools` itself issues, censused across the
// package's 18 Redis-touching modules — strings (`get` `set` `setEx` `mGet`
// `incr` `del` `expire` `ttl` `exists`), the keyspace scan (`scan`), hashes
// (`hGet` `hSet` `hGetAll` `hDel`), sets (`sAdd` `sMembers` `sRem`) and sorted
// sets (`zAdd`). Later slices EXTEND this file — they do not fork it.
//
// R5-S7 adds exactly what the first apps/api consumers issue: `scanIterator`
// (the `for await` form of SCAN) and lists (`lPush` `lLen`). Deliberately NOT
// added: `getDel` `hScan` `zRangeByScore` `zRem`. They were candidates, but no
// migrated caller issues them — an unused command has no real caller pattern to
// model, so it would be guesswork validated by nothing.
//
// R5-S9 completes the list type with its FIFO half — `rPush` and `lPop` — for
// one consumer: `packages/audit-sink/src/redis-spill-storage.ts`, which RPUSHes
// every spilled audit record onto the tail and LPOPs one at a time off the head
// until it reads `null`. Both ends of that queue are therefore load-bearing, and
// so is the null terminator: a double that pushes and pops the same end turns
// the module's documented "strict FIFO ordering matches the framework contract"
// into LIFO with every ordering assertion still green. Deliberately NOT added:
// `lRange` `lTrim` `rPop` `lRem` `blPop` — same rule as R5-S7, no consumer.
//
// The R5 jobs/subscribers rollout adds the two the outreach family reaches, and
// both arrive with a NAMED consumer — the rule R5-S7 set and R5-S9 restated:
//
//   • `hScan` — `apps/api/src/jobs/abandoned-cart-checker.ts` walks the
//     `rk("active:carts")` HASH cursor-wise ("uses HSCAN (never KEYS *)"), and
//     the loop terminates on `cursor === 0`. A double that answers a constant
//     cursor either loops forever or visits one page; both are invisible to an
//     assertion on what the sweep PUBLISHED. Modelled on the same cursor-session
//     snapshot `scan` uses, for the same reason: the sweep DELETES fields
//     (`hDel`) while iterating, and an offset cursor over a shrinking hash
//     silently skips entries.
//   • `lRange` — R5-S9 listed it as "no consumer". It has one now, and NOT the
//     obvious way: `abandoned-cart-checker` never issues it, but it hands its
//     client to `session/store.ts`'s `loadSession`, whose client type is
//     `Pick<…, "lRange">`. That is the fail-closed Pick rule (R5-S12) in its
//     downstream-consumer form — see the seam comment in the checker.
//
// The R5 dedup-family slice adds the three the class-(d) remainder map named,
// each with the NAMED consumer that unblocked it:
//
//   • `lTrim`  — `apps/api/src/subscribers/dlq.ts`. Its cap is `lPush` → `if
//     (newLen > MAX_DLQ) lTrim(key, 0, MAX_DLQ - 1)`, so what the command must
//     model is not "was it called" but WHICH ENTRIES SURVIVE: LPUSH writes the
//     newest at the head, and the trim keeps the head. A double that dropped the
//     wrong end would keep the OLDEST failures and discard the ones ops is
//     paged about, with the call assertion still green.
//   • `zRangeByScore` + `zRem` — `apps/api/src/jobs/follow-up-poller.ts`, which
//     drains the `follow-up:scheduled` zset that
//     `packages/tools/src/intelligence/schedule-follow-up.ts` writes with
//     `zAdd`. Both ends of that queue are now in this adapter, so the poller's
//     due-vs-future boundary is a real SCORE comparison rather than a stubbed
//     array — see the deliberate refusals on `zRangeByScore` below.
//
// Still deliberately NOT added: `rPop` `lRem` `blPop` `hIncrBy` `hKeys` — each
// has a class-(d) caller enumerated in
// `apps/api/src/__tests__/helpers/redis-double-census.md`, but none is in the
// family this slice threads, and an unmodelled command is not guesswork this
// adapter is allowed to invent.
//
// ── rk() runs REAL through this adapter ───────────────────────────────────────
//
// This adapter knows nothing about key prefixes and rewrites no key. Callers
// reach it through the real `rk()`, so the keys it stores are `${APP_ENV}:…`
// exactly as production writes them. That is deliberate: the hand-rolled doubles
// this replaces re-implemented `rk` with six divergent fictions — including
// `ibatexas:${k}`, a prefix production has never written — and every assertion
// made against such a key was an assertion about a keyspace that does not exist.
// Never stub `rk`; it is pure, and letting it run is the point.
//
// ── Never benign-empty ────────────────────────────────────────────────────────
//
// Everything unimplemented THROWS `UnroutedRedisCall`, naming the exact command
// that was reached. That covers an unknown command (`client.hRandField`), an
// unsupported option on a known command (`set(k, v, { KEEPTTL: true })`), and a
// malformed argument. A double that answers `null` or `[]` to a call it cannot
// honour makes a test pass for the wrong reason; this one fails loudly instead.
//
// ARGUMENT VALIDATION RUNS BEFORE ANY KEYSPACE ACCESS. This is not a style
// preference — validating while walking the store makes every check VACUOUS on
// an empty store, which is the state most tests start in, so a malformed call
// would sail through the exact scenario that runs first. `empty-store` cases in
// the sibling test file pin it.
//
// Type errors mirror real Redis rather than inventing softer ones: reading a
// hash command against a string key throws `WrongTypeError` (real Redis:
// `WRONGTYPE Operation against a key holding the wrong kind of value`), and
// `incr` on a non-numeric string throws (real Redis: `ERR value is not an
// integer or out of range`).
//
// ── Explicitly NOT emulated (W4 RULE 3) ───────────────────────────────────────
//
// `eval` / `evalSha` / `multi` / `watch` / `exec` and every other atomicity
// primitive THROW `LuaAtomicityNotEmulated` instead of returning a plausible
// answer. Their whole contract is SERVER-SIDE ATOMICITY, and a JS Map cannot
// provide it — a Map-stub of `eval()` is, per W4 RULE 3, "theater in the most
// literal sense: it gives green tests against code paths that have no real
// coverage". The honest home for those paths is the real-Redis testcontainer
// harness at `apps/api/src/__tests__/helpers/redis-testcontainer.ts`. In THIS
// package that rules out the refund-cap check-and-increment, the Lua
// conditional lock release (Hard Rule #10, `src/redis/distributed-lock.ts`),
// the confirmation-store GET+DEL, and `atomicIncr`'s INCR+EXPIRE script.
//
// Also not modelled: keyspace notifications, blocking commands, pub/sub,
// clustering, RESP-level errors, and memory eviction.

import type { RedisClientType } from "../redis/client.js"

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a call reaches a command or option this adapter does not
 * implement. The message names the path so the failure reads as "extend the
 * adapter" rather than "the code under test is broken".
 */
export class UnroutedRedisCall extends Error {
  constructor(path: string, detail?: string) {
    super(
      `[in-memory-redis] unrouted call: ${path}` +
        (detail ? ` — ${detail}` : "") +
        ". This adapter throws rather than answering with null/[]; add the" +
        " missing support to packages/tools/src/testing/in-memory-redis.ts.",
    )
    this.name = "UnroutedRedisCall"
  }
}

/**
 * Thrown for every server-side-atomicity command. Deliberately NOT implemented:
 * see the W4 RULE 3 note in this file's header.
 */
export class LuaAtomicityNotEmulated extends Error {
  constructor(command: string) {
    super(
      `[in-memory-redis] ${command} is deliberately NOT emulated (W4 RULE 3).` +
        " Its contract is Redis server-side atomicity, which a JS Map cannot" +
        " provide — emulating it would give a green test against a code path" +
        " with no real coverage. Drive this path through the real-Redis" +
        " testcontainer harness instead:" +
        " apps/api/src/__tests__/helpers/redis-testcontainer.ts.",
    )
    this.name = "LuaAtomicityNotEmulated"
  }
}

/** Stands in for Redis' `WRONGTYPE` reply. */
export class WrongTypeError extends Error {
  constructor(key: string, held: EntryKind, wanted: EntryKind) {
    super(
      `[in-memory-redis] WRONGTYPE Operation against a key holding the wrong kind of value` +
        ` — "${key}" holds a ${held}, command expects a ${wanted}`,
    )
    this.name = "WrongTypeError"
  }
}

/** Stands in for Redis' `ERR value is not an integer or out of range`. */
export class NotAnIntegerError extends Error {
  constructor(key: string, value: string) {
    super(
      `[in-memory-redis] ERR value is not an integer or out of range` +
        ` — "${key}" holds ${JSON.stringify(value)}`,
    )
    this.name = "NotAnIntegerError"
  }
}

// ── Keyspace ─────────────────────────────────────────────────────────────────

type EntryKind = "string" | "hash" | "set" | "zset" | "list"

interface Entry {
  kind: EntryKind
  /**
   * `string` → the value; `hash` → field→value; `set` → members;
   * `zset` → member→score; `list` → elements, HEAD FIRST (index 0 is the head,
   * which is what `lPush` prepends to and `lPop` removes; `rPush` appends to
   * the tail).
   */
  value: string | Map<string, string> | Set<string> | Map<string, number> | string[]
  /** Absolute expiry in ms, or `null` for no TTL. */
  expiresAtMs: number | null
}

export interface InMemoryRedisOptions {
  /**
   * Clock the TTL model reads. Defaults to `Date.now`. Inject a controllable one
   * to assert expiry without sleeping — TTLs here are enforced lazily on access,
   * the same observable behaviour real Redis gives.
   */
  readonly now?: () => number
  /** Seed the keyspace with plain string values. Keys are stored verbatim. */
  readonly seed?: Readonly<Record<string, string>>
}

/** What {@link createInMemoryRedis} hands back. */
export interface InMemoryRedis {
  /** The double itself — pass this where a module takes a Redis-shaped client. */
  readonly client: RedisClientType
  /** Live, expiry-filtered key list, sorted. For assertions. */
  keys(): string[]
  /** Raw string value, or `undefined` when absent/expired/not-a-string. */
  peek(key: string): string | undefined
  /** Remaining TTL in ms, `null` when the key has none, `undefined` when absent. */
  ttlMs(key: string): number | null | undefined
  /** Drop every key. */
  flush(): void
  /** Ordered log of every command the adapter served. For call assertions. */
  readonly calls: ReadonlyArray<{ command: string; args: readonly unknown[] }>
}

// ── Argument guards (ALL run before any keyspace access) ──────────────────────

function assertKey(command: string, key: unknown): asserts key is string {
  if (typeof key !== "string") {
    throw new UnroutedRedisCall(command, `key must be a string, got ${describe(key)}`)
  }
  if (key.length === 0) {
    throw new UnroutedRedisCall(command, "key must not be empty")
  }
}

function assertValue(command: string, value: unknown): asserts value is string {
  // node-redis coerces numbers, but a test double that silently accepts an
  // object would store "[object Object]" and make a broken caller look fine.
  if (typeof value !== "string" && typeof value !== "number") {
    throw new UnroutedRedisCall(
      command,
      `value must be a string or number, got ${describe(value)}`,
    )
  }
}

function assertPositiveIntSeconds(command: string, seconds: unknown): asserts seconds is number {
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
    throw new UnroutedRedisCall(
      command,
      `TTL must be a positive integer number of seconds, got ${describe(seconds)}`,
    )
  }
}

/** Reject any option key the adapter does not model, so a silent drop is impossible. */
function assertKnownOptions(
  command: string,
  options: unknown,
  allowed: readonly string[],
): void {
  if (options === undefined) return
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new UnroutedRedisCall(command, `options must be an object, got ${describe(options)}`)
  }
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new UnroutedRedisCall(
        command,
        `unsupported option ${JSON.stringify(key)} (modelled: ${allowed.join(", ") || "none"})`,
      )
    }
  }
}

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v)
  if (v === null) return "null"
  if (Array.isArray(v)) return `an array`
  return `${typeof v} ${String(v)}`
}

/** Redis glob → RegExp. Supports `*`, `?` and `[…]`; everything else is literal. */
function globToRegExp(pattern: string): RegExp {
  let out = "^"
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === "*") out += ".*"
    else if (ch === "?") out += "."
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1)
      if (close === -1) {
        out += "\\["
      } else {
        out += `[${pattern.slice(i + 1, close).replace(/\\/g, "\\\\")}]`
        i = close
      }
    } else if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      i++
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`${out}$`)
}

// ── The commands this adapter refuses on purpose (W4 RULE 3) ─────────────────

const ATOMICITY_COMMANDS = [
  "eval",
  "evalRo",
  "evalSha",
  "evalShaRo",
  "multi",
  "exec",
  "watch",
  "unwatch",
  "scriptLoad",
  "fCall",
  "fCallRo",
  "MULTI",
  "EVAL",
  "EVALSHA",
] as const

/**
 * Language-level property probes that are not Redis commands and must answer
 * `undefined` rather than throw. Kept deliberately SHORT — every entry is a
 * hole in throw-on-unrouted, so add one only for a genuine JS protocol.
 */
const JS_PROTOCOL_PROPS = new Set([
  "then", // thenable check when an async fn resolves to the client
  "catch",
  "finally",
  "toJSON", // structured serialization (vitest diffing, JSON.stringify)
  "asymmetricMatch", // vitest/jest matcher probing
  "$$typeof", // React element check
  "nodeType",
  "@@__IMMUTABLE_ITERABLE__@@",
  "@@__IMMUTABLE_RECORD__@@",
])

// ── Factory ──────────────────────────────────────────────────────────────────

export function createInMemoryRedis(options?: InMemoryRedisOptions): InMemoryRedis {
  const now = options?.now ?? Date.now
  const store = new Map<string, Entry>()
  const calls: Array<{ command: string; args: readonly unknown[] }> = []
  /** Live SCAN sessions: cursor → the snapshot still to be walked. */
  const scanSessions = new Map<number, string[]>()
  /**
   * Live HSCAN sessions: cursor → the hash it belongs to and the fields still to
   * be walked. Separate from `scanSessions` because the two walk different
   * things, but they SHARE `nextScanCursor` so a cursor minted by one can never
   * be mistaken for one minted by the other.
   */
  const hScanSessions = new Map<number, { readonly key: string; readonly rest: string[] }>()
  let nextScanCursor = 1

  for (const [key, value] of Object.entries(options?.seed ?? {})) {
    store.set(key, { kind: "string", value, expiresAtMs: null })
  }

  // ── Keyspace core ──────────────────────────────────────────────────────────

  /** Read an entry, evicting it first if its TTL has passed (lazy expiry). */
  function live(key: string): Entry | undefined {
    const entry = store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= now()) {
      store.delete(key)
      return undefined
    }
    return entry
  }

  function typed(key: string, kind: EntryKind): Entry | undefined {
    const entry = live(key)
    if (entry === undefined) return undefined
    if (entry.kind !== kind) throw new WrongTypeError(key, entry.kind, kind)
    return entry
  }

  function liveKeys(): string[] {
    const out: string[] = []
    for (const key of [...store.keys()]) {
      if (live(key) !== undefined) out.push(key)
    }
    return out.sort()
  }

  function record(command: string, args: readonly unknown[]): void {
    calls.push({ command, args })
  }

  // ── SCAN internals, shared by `scan` and `scanIterator` ────────────────────
  //
  // ONE implementation on purpose: `scanIterator` is SCAN in node-redis too, and
  // a second copy of the filter/snapshot rules is a place for the two to drift
  // into disagreeing about MATCH.

  interface ScanOptions {
    readonly match?: string
    readonly count: number
    readonly type?: string
  }

  /** Validates MATCH/COUNT/TYPE. Runs BEFORE any keyspace access — see the header. */
  function assertScanOptions(command: string, opts: unknown): ScanOptions {
    assertKnownOptions(command, opts, ["MATCH", "COUNT", "TYPE"])
    const o = (opts ?? {}) as { MATCH?: unknown; COUNT?: unknown; TYPE?: unknown }
    if (o.MATCH !== undefined && typeof o.MATCH !== "string") {
      throw new UnroutedRedisCall(command, `MATCH must be a string, got ${describe(o.MATCH)}`)
    }
    if (
      o.COUNT !== undefined &&
      (typeof o.COUNT !== "number" || !Number.isInteger(o.COUNT) || o.COUNT <= 0)
    ) {
      throw new UnroutedRedisCall(command, `COUNT must be a positive integer, got ${describe(o.COUNT)}`)
    }
    if (o.TYPE !== undefined && typeof o.TYPE !== "string") {
      throw new UnroutedRedisCall(command, `TYPE must be a string, got ${describe(o.TYPE)}`)
    }
    return {
      match: o.MATCH as string | undefined,
      count: (o.COUNT as number | undefined) ?? 10,
      type: o.TYPE as string | undefined,
    }
  }

  /** The cursor-0 snapshot: every live key passing MATCH and TYPE. */
  function buildScanSnapshot(o: ScanOptions): string[] {
    const matcher = o.match === undefined ? null : globToRegExp(o.match)
    return liveKeys().filter((k) => {
      if (matcher !== null && !matcher.test(k)) return false
      if (o.type !== undefined && live(k)?.kind !== o.type) return false
      return true
    })
  }

  // ── Commands ───────────────────────────────────────────────────────────────
  //
  // Every handler validates its arguments COMPLETELY before touching `store`.

  // `unknown` rather than a call signature: the table also carries the
  // lifecycle no-ops and the `isOpen` getter that consumers read as a property.
  const commands: Record<string, unknown> = {
    async get(key: unknown): Promise<string | null> {
      assertKey("get", key)
      record("get", [key])
      const entry = typed(key, "string")
      return entry === undefined ? null : (entry.value as string)
    },

    async set(key: unknown, value: unknown, opts?: unknown): Promise<string | null> {
      assertKey("set", key)
      assertValue("set", value)
      assertKnownOptions("set", opts, ["EX", "PX", "NX", "XX"])
      const o = (opts ?? {}) as { EX?: unknown; PX?: unknown; NX?: unknown; XX?: unknown }
      if (o.EX !== undefined) assertPositiveIntSeconds("set", o.EX)
      if (o.PX !== undefined && (typeof o.PX !== "number" || !Number.isInteger(o.PX) || o.PX <= 0)) {
        throw new UnroutedRedisCall("set", `PX must be a positive integer, got ${describe(o.PX)}`)
      }
      if (o.EX !== undefined && o.PX !== undefined) {
        throw new UnroutedRedisCall("set", "EX and PX are mutually exclusive")
      }
      if (o.NX === true && o.XX === true) {
        throw new UnroutedRedisCall("set", "NX and XX are mutually exclusive")
      }
      record("set", [key, value, opts])

      const existing = live(key)
      if (o.NX === true && existing !== undefined) return null
      if (o.XX === true && existing === undefined) return null

      const ttlMs =
        o.EX !== undefined
          ? (o.EX as number) * 1000
          : o.PX !== undefined
            ? (o.PX as number)
            : null
      store.set(key, {
        kind: "string",
        value: String(value),
        expiresAtMs: ttlMs === null ? null : now() + ttlMs,
      })
      return "OK"
    },

    async setEx(key: unknown, seconds: unknown, value: unknown): Promise<string> {
      assertKey("setEx", key)
      assertPositiveIntSeconds("setEx", seconds)
      assertValue("setEx", value)
      record("setEx", [key, seconds, value])
      store.set(key, {
        kind: "string",
        value: String(value),
        expiresAtMs: now() + (seconds as number) * 1000,
      })
      return "OK"
    },

    async mGet(keys: unknown): Promise<Array<string | null>> {
      if (!Array.isArray(keys)) {
        throw new UnroutedRedisCall("mGet", `expects an array of keys, got ${describe(keys)}`)
      }
      for (const k of keys) assertKey("mGet", k)
      record("mGet", [keys])
      return (keys as string[]).map((k) => {
        const entry = typed(k, "string")
        return entry === undefined ? null : (entry.value as string)
      })
    },

    async del(keys: unknown): Promise<number> {
      const list = Array.isArray(keys) ? keys : [keys]
      if (list.length === 0) {
        throw new UnroutedRedisCall("del", "requires at least one key")
      }
      for (const k of list) assertKey("del", k)
      record("del", [keys])
      let removed = 0
      for (const k of list as string[]) {
        if (live(k) !== undefined) {
          store.delete(k)
          removed++
        }
      }
      return removed
    },

    async exists(keys: unknown): Promise<number> {
      const list = Array.isArray(keys) ? keys : [keys]
      if (list.length === 0) {
        throw new UnroutedRedisCall("exists", "requires at least one key")
      }
      for (const k of list) assertKey("exists", k)
      record("exists", [keys])
      return (list as string[]).filter((k) => live(k) !== undefined).length
    },

    async incr(key: unknown): Promise<number> {
      assertKey("incr", key)
      record("incr", [key])
      const entry = typed(key, "string")
      if (entry === undefined) {
        store.set(key, { kind: "string", value: "1", expiresAtMs: null })
        return 1
      }
      const current = entry.value as string
      if (!/^-?\d+$/.test(current)) throw new NotAnIntegerError(key, current)
      const next = Number.parseInt(current, 10) + 1
      entry.value = String(next)
      return next
    },

    /**
     * `incr`'s mirror, and a real DECR in the one way that matters here: it
     * goes NEGATIVE rather than flooring at zero. The backing consumer is
     * `@adjudicate/runtime`'s `resumeDeferredIntent`, which decrements the
     * per-session parked-envelope quota counter on a successful resume. A
     * double that floored at 0 would hide a double-decrement — exactly the
     * accounting bug the counter exists to make visible — so an over-release
     * shows up as a negative count, the way Redis reports it.
     */
    async decr(key: unknown): Promise<number> {
      assertKey("decr", key)
      record("decr", [key])
      const entry = typed(key, "string")
      if (entry === undefined) {
        store.set(key, { kind: "string", value: "-1", expiresAtMs: null })
        return -1
      }
      const current = entry.value as string
      if (!/^-?\d+$/.test(current)) throw new NotAnIntegerError(key, current)
      const next = Number.parseInt(current, 10) - 1
      entry.value = String(next)
      return next
    },

    async expire(key: unknown, seconds: unknown): Promise<boolean> {
      assertKey("expire", key)
      assertPositiveIntSeconds("expire", seconds)
      record("expire", [key, seconds])
      const entry = live(key)
      if (entry === undefined) return false
      entry.expiresAtMs = now() + (seconds as number) * 1000
      return true
    },

    async ttl(key: unknown): Promise<number> {
      assertKey("ttl", key)
      record("ttl", [key])
      const entry = live(key)
      if (entry === undefined) return -2 // real Redis: key does not exist
      if (entry.expiresAtMs === null) return -1 // real Redis: no TTL
      return Math.ceil((entry.expiresAtMs - now()) / 1000)
    },

    /**
     * Cursor-based iteration. Modelled with per-session snapshots rather than an
     * offset into the live key list, because the caller pattern in this package
     * is scan-then-DELETE-what-was-returned (`invalidateDeliveryCache`), and an
     * offset cursor over a shrinking list silently SKIPS keys. A snapshot taken
     * at cursor 0 and filtered for still-live keys on each step reproduces real
     * SCAN's guarantee — every key present throughout the iteration is returned.
     */
    async scan(
      cursor: unknown,
      opts?: unknown,
    ): Promise<{ cursor: number; keys: string[] }> {
      if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
        throw new UnroutedRedisCall(
          "scan",
          `cursor must be a non-negative integer, got ${describe(cursor)}`,
        )
      }
      const o = assertScanOptions("scan", opts)
      if (cursor !== 0 && !scanSessions.has(cursor)) {
        throw new UnroutedRedisCall(
          "scan",
          `unknown cursor ${cursor} — a SCAN cursor must come from a previous scan() on this client`,
        )
      }
      record("scan", [cursor, opts])

      const count = o.count
      let remaining: string[]
      if (cursor === 0) {
        remaining = buildScanSnapshot(o)
      } else {
        remaining = scanSessions.get(cursor)!
        scanSessions.delete(cursor)
      }

      // Drop anything deleted since the snapshot — real SCAN never returns a
      // key that no longer exists.
      remaining = remaining.filter((k) => live(k) !== undefined)

      const batch = remaining.slice(0, count)
      const rest = remaining.slice(count)
      if (rest.length === 0) return { cursor: 0, keys: batch }

      const next = ++nextScanCursor
      scanSessions.set(next, rest)
      return { cursor: next, keys: batch }
    },

    /**
     * `for await (const key of client.scanIterator({ MATCH, COUNT }))`.
     *
     * NOT an `async function*`. A generator body does not run until the first
     * `next()`, so writing it that way would defer argument validation until
     * iteration — a malformed MATCH would sail through the CALL and only
     * surface (or not, if the caller never iterates) later. Validating eagerly
     * and returning the generator keeps the header's validate-before-keyspace
     * -access rule true for this command too; the sibling suite pins it.
     *
     * Yields keys one at a time over the same cursor-0 snapshot `scan` uses, so
     * the package's scan-then-DELETE callers keep SCAN's real guarantee: a key
     * deleted mid-iteration is never handed back.
     */
    scanIterator(opts?: unknown): AsyncIterable<string> {
      const o = assertScanOptions("scanIterator", opts)
      record("scanIterator", [opts])
      const snapshot = buildScanSnapshot(o)
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<string> {
          for (const key of snapshot) {
            if (live(key) === undefined) continue
            yield key
          }
        },
      }
    },

    /**
     * Prepend to a list (real LPUSH: index 0 is the head). This is the seeding
     * path for list-reading tests BY DESIGN — production writes these lists with
     * LPUSH (`apps/api/src/subscribers/dlq.ts`), so a test seeds a DLQ exactly
     * the way the real producer does rather than through a test-only affordance
     * that no production code path can reach.
     */
    async lPush(key: unknown, values: unknown): Promise<number> {
      assertKey("lPush", key)
      const list = Array.isArray(values) ? values : [values]
      if (list.length === 0) throw new UnroutedRedisCall("lPush", "requires at least one value")
      for (const v of list) assertValue("lPush", v)
      record("lPush", [key, values])
      const entry = typed(key, "list")
      const arr = entry === undefined ? [] : (entry.value as string[])
      // Real LPUSH pushes each value in turn, so a multi-value push lands
      // REVERSED relative to the argument order.
      for (const v of list) arr.unshift(String(v))
      if (entry === undefined) store.set(key, { kind: "list", value: arr, expiresAtMs: null })
      return arr.length
    },

    /**
     * Append to a list's TAIL (real RPUSH) — `lPush`'s mirror, and the write
     * half of the FIFO queue in `packages/audit-sink/src/redis-spill-storage.ts`
     * ("RPUSH on append, LPOP on read — strict FIFO ordering matches the
     * framework contract"). Which END a value lands on is the whole contract
     * there, so it is modelled rather than aliased onto `lPush`.
     */
    async rPush(key: unknown, values: unknown): Promise<number> {
      assertKey("rPush", key)
      const list = Array.isArray(values) ? values : [values]
      if (list.length === 0) throw new UnroutedRedisCall("rPush", "requires at least one value")
      for (const v of list) assertValue("rPush", v)
      record("rPush", [key, values])
      const entry = typed(key, "list")
      const arr = entry === undefined ? [] : (entry.value as string[])
      // Real RPUSH appends each value in turn, so a multi-value push KEEPS
      // argument order — the opposite of lPush, which reverses it.
      for (const v of list) arr.push(String(v))
      if (entry === undefined) store.set(key, { kind: "list", value: arr, expiresAtMs: null })
      return arr.length
    },

    /**
     * Remove and return the list's HEAD (real LPOP), or `null` when the list is
     * absent or empty. `null` is the drain terminator the spill storage's
     * `readAll()` loop rides on — it LPOPs `for (;;)` and stops on `null`, so a
     * double answering anything else for an exhausted queue spins forever.
     *
     * Emptying a list DELETES the key, as real Redis does. Leaving an empty list
     * behind would keep `exists` at 1 and a TTL alive on a key production has
     * already removed.
     *
     * The COUNT form (`lPop(key, n)`) is NOT modelled: no migrated consumer
     * issues it, and silently ignoring the count would pop one element where the
     * caller asked for n — the benign-empty failure this adapter exists to avoid.
     */
    async lPop(key: unknown, count?: unknown): Promise<string | null> {
      assertKey("lPop", key)
      if (count !== undefined) {
        throw new UnroutedRedisCall(
          "lPop",
          `the COUNT form is not modelled (got ${describe(count)}); no consumer issues it`,
        )
      }
      record("lPop", [key])
      const entry = typed(key, "list")
      if (entry === undefined) return null
      const arr = entry.value as string[]
      const head = arr.shift()
      if (head === undefined) return null
      if (arr.length === 0) store.delete(key)
      return head
    },

    async lLen(key: unknown): Promise<number> {
      assertKey("lLen", key)
      record("lLen", [key])
      const entry = typed(key, "list")
      return entry === undefined ? 0 : (entry.value as string[]).length
    },

    /**
     * `lRange(key, start, stop)` — an INCLUSIVE slice, with real Redis' negative
     * indices counting back from the tail (`-1` is the last element). An absent
     * key is an empty list, not an error.
     *
     * The whole-list form `lRange(key, 0, -1)` is what `session/store.ts`'s
     * `loadSession` issues, and inclusivity is load-bearing there: a JS
     * `slice(0, -1)` — the obvious mistranslation — drops the newest message
     * from every history it returns, silently.
     */
    async lRange(key: unknown, start: unknown, stop: unknown): Promise<string[]> {
      assertKey("lRange", key)
      for (const [name, v] of [
        ["start", start],
        ["stop", stop],
      ] as const) {
        if (typeof v !== "number" || !Number.isInteger(v)) {
          throw new UnroutedRedisCall("lRange", `${name} must be an integer, got ${describe(v)}`)
        }
      }
      record("lRange", [key, start, stop])
      const entry = typed(key, "list")
      if (entry === undefined) return []
      const arr = entry.value as string[]
      const len = arr.length
      // Negative indices count from the tail; out-of-range clamps, as Redis does.
      const from = Math.max(0, (start as number) < 0 ? len + (start as number) : (start as number))
      const to = Math.min(len - 1, (stop as number) < 0 ? len + (stop as number) : (stop as number))
      if (from > to) return []
      return arr.slice(from, to + 1)
    },

    /**
     * `lTrim(key, start, stop)` — keep ONLY the inclusive range, discard the
     * rest. Same index rules as `lRange` (negatives count from the tail,
     * out-of-range clamps), and the same reason for modelling them rather than
     * reaching for a JS `slice`.
     *
     * The consumer is `apps/api/src/subscribers/dlq.ts`'s cap, and WHICH END
     * survives is its entire contract: `pushToDlq` LPUSHes so index 0 is the
     * NEWEST failure, then trims to `(0, MAX_DLQ - 1)`. Keeping the wrong end
     * would silently retain the oldest entries and drop the ones ops is paged
     * about — invisible to any assertion that only checks LTRIM was called.
     *
     * An empty result DELETES the key, as real Redis does: LTRIM that leaves a
     * list empty removes it, and a double that left an empty list behind would
     * keep `exists` at 1 and a TTL alive on a key production has removed.
     * An absent key is a no-op `"OK"`, not an error.
     */
    async lTrim(key: unknown, start: unknown, stop: unknown): Promise<string> {
      assertKey("lTrim", key)
      for (const [name, v] of [
        ["start", start],
        ["stop", stop],
      ] as const) {
        if (typeof v !== "number" || !Number.isInteger(v)) {
          throw new UnroutedRedisCall("lTrim", `${name} must be an integer, got ${describe(v)}`)
        }
      }
      record("lTrim", [key, start, stop])
      const entry = typed(key, "list")
      if (entry === undefined) return "OK"
      const arr = entry.value as string[]
      const len = arr.length
      const from = Math.max(0, (start as number) < 0 ? len + (start as number) : (start as number))
      const to = Math.min(len - 1, (stop as number) < 0 ? len + (stop as number) : (stop as number))
      const kept = from > to ? [] : arr.slice(from, to + 1)
      if (kept.length === 0) {
        store.delete(key)
        return "OK"
      }
      // Mutate IN PLACE — `lPush`/`rPush` hold a live reference to this array.
      arr.length = 0
      arr.push(...kept)
      return "OK"
    },

    async hGet(key: unknown, field: unknown): Promise<string | undefined> {
      assertKey("hGet", key)
      assertKey("hGet", field)
      record("hGet", [key, field])
      const entry = typed(key, "hash")
      if (entry === undefined) return undefined
      return (entry.value as Map<string, string>).get(field as string)
    },

    async hSet(key: unknown, field: unknown, value?: unknown): Promise<number> {
      assertKey("hSet", key)
      // node-redis accepts hSet(key, {f: v}) as well as hSet(key, f, v).
      const pairs: Array<[string, string]> = []
      if (typeof field === "object" && field !== null && !Array.isArray(field)) {
        if (value !== undefined) {
          throw new UnroutedRedisCall("hSet", "object form takes no third argument")
        }
        for (const [f, v] of Object.entries(field)) {
          assertValue("hSet", v)
          pairs.push([f, String(v)])
        }
      } else {
        assertKey("hSet", field)
        assertValue("hSet", value)
        pairs.push([field as string, String(value)])
      }
      record("hSet", [key, field, value])

      const entry = typed(key, "hash")
      const map =
        entry === undefined ? new Map<string, string>() : (entry.value as Map<string, string>)
      let added = 0
      for (const [f, v] of pairs) {
        if (!map.has(f)) added++
        map.set(f, v)
      }
      if (entry === undefined) store.set(key, { kind: "hash", value: map, expiresAtMs: null })
      return added
    },

    async hGetAll(key: unknown): Promise<Record<string, string>> {
      assertKey("hGetAll", key)
      record("hGetAll", [key])
      const entry = typed(key, "hash")
      if (entry === undefined) return {}
      return Object.fromEntries(entry.value as Map<string, string>)
    },

    async hDel(key: unknown, fields: unknown): Promise<number> {
      assertKey("hDel", key)
      const list = Array.isArray(fields) ? fields : [fields]
      if (list.length === 0) throw new UnroutedRedisCall("hDel", "requires at least one field")
      for (const f of list) assertKey("hDel", f)
      record("hDel", [key, fields])
      const entry = typed(key, "hash")
      if (entry === undefined) return 0
      const map = entry.value as Map<string, string>
      let removed = 0
      for (const f of list as string[]) if (map.delete(f)) removed++
      if (map.size === 0) store.delete(key)
      return removed
    },

    /**
     * Cursor-wise hash walk — node-redis v4's shape:
     * `hScan(key, cursor, { COUNT, MATCH }) → { cursor, tuples: [{field, value}] }`,
     * with `cursor === 0` meaning "the walk is complete".
     *
     * The cursor is a SESSION HANDLE over a snapshot taken at cursor 0, not an
     * offset — same design as `scan`, and for the same measured reason. The one
     * consumer (`jobs/abandoned-cart-checker.ts`) `hDel`s fields WHILE iterating,
     * and an offset cursor over a shrinking hash silently skips the entry that
     * slid into the vacated slot. Fields deleted since the snapshot are dropped
     * rather than returned, which is real HSCAN's guarantee.
     *
     * MATCH filters the FIELD (real HSCAN matches the field, not the value).
     */
    async hScan(
      key: unknown,
      cursor: unknown,
      opts?: unknown,
    ): Promise<{ cursor: number; tuples: Array<{ field: string; value: string }> }> {
      assertKey("hScan", key)
      if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
        throw new UnroutedRedisCall(
          "hScan",
          `cursor must be a non-negative integer, got ${describe(cursor)}`,
        )
      }
      // TYPE is meaningless for a hash walk — every value is a string — so it is
      // NOT accepted here even though `scan` takes it.
      assertKnownOptions("hScan", opts, ["MATCH", "COUNT"])
      const o = (opts ?? {}) as { MATCH?: unknown; COUNT?: unknown }
      if (o.MATCH !== undefined && typeof o.MATCH !== "string") {
        throw new UnroutedRedisCall("hScan", `MATCH must be a string, got ${describe(o.MATCH)}`)
      }
      if (
        o.COUNT !== undefined &&
        (typeof o.COUNT !== "number" || !Number.isInteger(o.COUNT) || o.COUNT <= 0)
      ) {
        throw new UnroutedRedisCall(
          "hScan",
          `COUNT must be a positive integer, got ${describe(o.COUNT)}`,
        )
      }
      if (cursor !== 0 && !hScanSessions.has(cursor)) {
        throw new UnroutedRedisCall(
          "hScan",
          `unknown cursor ${cursor} — an HSCAN cursor must come from a previous hScan() on this client`,
        )
      }
      record("hScan", [key, cursor, opts])

      const count = (o.COUNT as number | undefined) ?? 10
      const matcher = o.MATCH === undefined ? null : globToRegExp(o.MATCH as string)

      let remaining: string[]
      if (cursor === 0) {
        const entry = typed(key as string, "hash")
        const fields = entry === undefined ? [] : [...(entry.value as Map<string, string>).keys()]
        remaining = matcher === null ? fields : fields.filter((f) => matcher.test(f))
      } else {
        const session = hScanSessions.get(cursor)!
        hScanSessions.delete(cursor)
        if (session.key !== key) {
          throw new UnroutedRedisCall(
            "hScan",
            `cursor ${cursor} belongs to key ${JSON.stringify(session.key)}, not ${describe(key)}`,
          )
        }
        remaining = session.rest
      }

      // Re-read the hash on every step so a field `hDel`'d mid-walk is dropped.
      const entryNow = typed(key as string, "hash")
      const map =
        entryNow === undefined ? new Map<string, string>() : (entryNow.value as Map<string, string>)
      remaining = remaining.filter((f) => map.has(f))

      const batch = remaining.slice(0, count)
      const rest = remaining.slice(count)
      const tuples = batch.map((field) => ({ field, value: map.get(field)! }))
      if (rest.length === 0) return { cursor: 0, tuples }

      const next = ++nextScanCursor
      hScanSessions.set(next, { key: key as string, rest })
      return { cursor: next, tuples }
    },

    async sAdd(key: unknown, members: unknown): Promise<number> {
      assertKey("sAdd", key)
      const list = Array.isArray(members) ? members : [members]
      if (list.length === 0) throw new UnroutedRedisCall("sAdd", "requires at least one member")
      for (const m of list) assertValue("sAdd", m)
      record("sAdd", [key, members])
      const entry = typed(key, "set")
      const set = entry === undefined ? new Set<string>() : (entry.value as Set<string>)
      let added = 0
      for (const m of list) {
        const s = String(m)
        if (!set.has(s)) {
          set.add(s)
          added++
        }
      }
      if (entry === undefined) store.set(key, { kind: "set", value: set, expiresAtMs: null })
      return added
    },

    async sMembers(key: unknown): Promise<string[]> {
      assertKey("sMembers", key)
      record("sMembers", [key])
      const entry = typed(key, "set")
      return entry === undefined ? [] : [...(entry.value as Set<string>)]
    },

    async sRem(key: unknown, members: unknown): Promise<number> {
      assertKey("sRem", key)
      const list = Array.isArray(members) ? members : [members]
      if (list.length === 0) throw new UnroutedRedisCall("sRem", "requires at least one member")
      for (const m of list) assertValue("sRem", m)
      record("sRem", [key, members])
      const entry = typed(key, "set")
      if (entry === undefined) return 0
      const set = entry.value as Set<string>
      let removed = 0
      for (const m of list) if (set.delete(String(m))) removed++
      if (set.size === 0) store.delete(key)
      return removed
    },

    async zAdd(key: unknown, members: unknown): Promise<number> {
      assertKey("zAdd", key)
      const list = Array.isArray(members) ? members : [members]
      if (list.length === 0) throw new UnroutedRedisCall("zAdd", "requires at least one member")
      for (const m of list) {
        if (typeof m !== "object" || m === null) {
          throw new UnroutedRedisCall("zAdd", `member must be {score, value}, got ${describe(m)}`)
        }
        const { score, value } = m as { score?: unknown; value?: unknown }
        if (typeof score !== "number" || !Number.isFinite(score)) {
          throw new UnroutedRedisCall("zAdd", `score must be a finite number, got ${describe(score)}`)
        }
        assertValue("zAdd", value)
      }
      record("zAdd", [key, members])
      const entry = typed(key, "zset")
      const zset =
        entry === undefined ? new Map<string, number>() : (entry.value as Map<string, number>)
      let added = 0
      for (const m of list as Array<{ score: number; value: string }>) {
        if (!zset.has(String(m.value))) added++
        zset.set(String(m.value), m.score)
      }
      if (entry === undefined) store.set(key, { kind: "zset", value: zset, expiresAtMs: null })
      return added
    },

    /**
     * `zRangeByScore(key, min, max)` — the members whose score is in the
     * INCLUSIVE range `[min, max]`, ordered by score ascending and, for equal
     * scores, by member lexicographically (real Redis' tie-break).
     *
     * The consumer is `apps/api/src/jobs/follow-up-poller.ts`
     * (`zRangeByScore(rk("follow-up:scheduled"), 0, Date.now())` — "fetch all
     * entries whose fire time has passed"). Paired with `zAdd`, which
     * `packages/tools/src/intelligence/schedule-follow-up.ts` uses to schedule
     * them, that makes the due-vs-future boundary a REAL score comparison. The
     * retired double answered a per-case `mockResolvedValue`, so the poller's
     * "future entries are not published" case asserted nothing about scores at
     * all — the test simply handed back an empty array and called it proof.
     *
     * THREE forms are deliberately REFUSED rather than approximated, because
     * each one silently changes which members a caller sees:
     *
     *   • `"-inf"` / `"+inf"` / any string bound. Real Redis takes them; no
     *     migrated consumer issues one, and coercing `"-inf"` through `Number`
     *     would quietly become `NaN` and match nothing.
     *   • The exclusive `"(5"` spelling, for the same reason and worse: it
     *     LOOKS numeric after a strip, so a wrong answer would be plausible.
     *   • `LIMIT`. Its only in-repo caller is `jobs/review-prompt-poller.ts`
     *     (`{ LIMIT: { offset: 0, count: BATCH_CAP } }`), which is owner-gated
     *     on `multi` and cannot migrate here. Ignoring a batch cap would hand
     *     the caller the WHOLE due set while its own test asserted a bounded
     *     one — the benign-answer failure this adapter exists to refuse.
     */
    async zRangeByScore(
      key: unknown,
      min: unknown,
      max: unknown,
      opts?: unknown,
    ): Promise<string[]> {
      assertKey("zRangeByScore", key)
      for (const [name, v] of [
        ["min", min],
        ["max", max],
      ] as const) {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new UnroutedRedisCall(
            "zRangeByScore",
            `${name} must be a finite number, got ${describe(v)} — the "-inf"/"+inf"` +
              ` and exclusive "(score" spellings are NOT modelled (no consumer issues them)`,
          )
        }
      }
      if (opts !== undefined) {
        throw new UnroutedRedisCall(
          "zRangeByScore",
          `options are not modelled (got ${describe(opts)}); LIMIT in particular` +
            ` would silently return an UNBOUNDED range to a caller that asked for a` +
            ` bounded one — its only in-repo caller, jobs/review-prompt-poller.ts,` +
            ` is owner-gated on multi and does not run against this adapter`,
        )
      }
      record("zRangeByScore", [key, min, max])
      const entry = typed(key, "zset")
      if (entry === undefined) return []
      const zset = entry.value as Map<string, number>
      return [...zset.entries()]
        .filter(([, score]) => score >= (min as number) && score <= (max as number))
        .sort(([aMember, aScore], [bMember, bScore]) =>
          aScore === bScore ? (aMember < bMember ? -1 : aMember > bMember ? 1 : 0) : aScore - bScore,
        )
        .map(([member]) => member)
    },

    /**
     * `zRem(key, member | member[])` — remove members, answering how many were
     * actually there. `sRem`'s shape, and it empties the key the same way real
     * Redis does: a zset with no members no longer exists.
     *
     * The count matters to the drain pattern in `jobs/follow-up-poller.ts`: it
     * `zRem`s a member it has just published, and a double that answered a
     * constant `1` could not tell a real removal from a member the poller never
     * held — which is exactly what "processed twice" would look like.
     */
    async zRem(key: unknown, members: unknown): Promise<number> {
      assertKey("zRem", key)
      const list = Array.isArray(members) ? members : [members]
      if (list.length === 0) throw new UnroutedRedisCall("zRem", "requires at least one member")
      for (const m of list) assertValue("zRem", m)
      record("zRem", [key, members])
      const entry = typed(key, "zset")
      if (entry === undefined) return 0
      const zset = entry.value as Map<string, number>
      let removed = 0
      for (const m of list) if (zset.delete(String(m))) removed++
      if (zset.size === 0) store.delete(key)
      return removed
    },

    // ── Connection lifecycle — no-ops, so a consumer that closes is fine ──────
    async connect(): Promise<void> {},
    async quit(): Promise<void> {},
    async disconnect(): Promise<void> {},
    on(): unknown {
      return proxy
    },
    get isOpen(): boolean {
      return true
    },
  }

  // ── The double ─────────────────────────────────────────────────────────────
  //
  // A Proxy so an unimplemented command throws on ACCESS, naming itself, rather
  // than surfacing as `undefined is not a function` at the call site.

  const proxy = new Proxy(commands, {
    get(target, prop) {
      if (typeof prop === "symbol") return Reflect.get(target, prop) as unknown
      // JS protocol probes, NOT Redis commands. `then` is the load-bearing one:
      // resolving an `async` function to this object makes the runtime read
      // `.then` to decide whether it is a thenable, and a throw there is
      // indistinguishable from a Redis failure to the caller's try/catch — the
      // adapter would silently look like a dead Redis on every injected path.
      // Answering `undefined` is the honest reply: this object is not a
      // thenable and has no JSON form.
      if (JS_PROTOCOL_PROPS.has(prop)) return undefined
      if ((ATOMICITY_COMMANDS as readonly string[]).includes(prop)) {
        return () => {
          throw new LuaAtomicityNotEmulated(prop)
        }
      }
      if (prop in target) return Reflect.get(target, prop) as unknown
      throw new UnroutedRedisCall(prop, "command not implemented by this adapter")
    },
    has(target, prop) {
      return prop in target
    },
  }) as unknown as RedisClientType

  return {
    client: proxy,
    keys: () => liveKeys(),
    peek(key: string): string | undefined {
      const entry = live(key)
      if (entry === undefined || entry.kind !== "string") return undefined
      return entry.value as string
    },
    ttlMs(key: string): number | null | undefined {
      const entry = live(key)
      if (entry === undefined) return undefined
      return entry.expiresAtMs === null ? null : entry.expiresAtMs - now()
    },
    flush(): void {
      store.clear()
      scanSessions.clear()
    },
    calls,
  }
}
