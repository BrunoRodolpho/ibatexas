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
   * which is what `lPush` prepends to).
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

    async lLen(key: unknown): Promise<number> {
      assertKey("lLen", key)
      record("lLen", [key])
      const entry = typed(key, "list")
      return entry === undefined ? 0 : (entry.value as string[]).length
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
