// M2 — UNIT OBSERVATION for a Lua call site. The retirement of the
// eval-emulating doubles (census class (i)).
//
// Ruling: docs/architecture/redis-lua-testing-decision.md, qualification Q2 —
// "Call sites then need only unit-level observation (spy-delegate proof that
// the site issues the right script with the right args) — they inherit the
// shape's invariant from the contract suite."
//
// ── What this replaces ───────────────────────────────────────────────────────
//
// Seven test doubles re-implemented a production Lua script in JavaScript so a
// `Map` could answer `eval()`. That is W4 RULE 3 theater twice over:
//
//   1. The emulation can DRIFT from the script. The test then certifies a
//      behaviour production does not have.
//   2. Six of the seven ignored the `script` argument entirely (the census's
//      "script-blindness hazard"). CAD (`GET == ARGV[1] then DEL`) and CONSUME
//      (`GET; if value then DEL`) have OPPOSITE contracts — CAD deletes only on
//      an ownership match and returns 1/0; CONSUME deletes unconditionally and
//      returns the value. A script-blind CONSUME double handed a CAD script
//      answers "released, here is the value" for a lock the caller does NOT
//      own: the exact inverse of CLAUDE.md rule #10, asserted green.
//
// Both are structurally impossible here. This observer NEVER computes a reply
// from a keyspace — it records the call and returns a reply the TEST declared —
// and `expectLuaCall` requires the observed script to be byte-identical to the
// production text at a NAMED site anchor. A site that swapped CAD for CONSUME
// reds on the script comparison before any behavioural assertion runs.
//
// ── The division of labour, stated plainly ───────────────────────────────────
//
// WHAT THIS CATCHES (and the shape suites cannot):
//   * the site stopped issuing the script at all           → `calls` is empty
//   * the site issues a DIFFERENT script than the one the shape suite covers
//     — a wrong constant, an inline literal, a CAD where a CONSUME belongs
//   * the site issues the right script against the WRONG KEY or WRONG ARGV
//     — e.g. F-21's constant-value lock, where ARGV[1] was not the caller's
//     own token, so the ownership test could never discriminate
//
// WHAT THIS CANNOT CATCH (and the shape suites do):
//   * a semantic corruption of the script constant itself. `expectLuaCall`
//     compares the runtime value against the SOURCE TEXT it was compiled from,
//     so a consistent edit moves both sides and the comparison stays green.
//     That is deliberate, not an oversight: the conjunct's meaning is a
//     real-Redis property and it is held by `lua-shape-*-contract.test.ts`,
//     which EVALs those same bytes against a container. M1 measured that
//     directly — corrupting each production script reddened its shape suite at
//     that site's row.
//
// Neither half is sufficient; the pair is. Read them as one gate.
//
// ── On the declared reply ────────────────────────────────────────────────────
//
// `reply` / `replyOnce` state the script's POSTCONDITION as a test input
// ("this receipt was already redeemed, so the CONSUME script returns nil")
// rather than deriving it from a JS Map. The difference is not cosmetic: an
// emulation silently decides the invariant, whereas a declared reply makes the
// dependency visible at the call site and cites where the invariant is proven.
//
// There is deliberately NO throw-by-default mode. Several of these call sites
// swallow release failures by design (`releaseDeferResumingLock`'s catch, "TTL
// is the source-of-truth deadline"), so a throwing observer would be absorbed
// and the case would pass having observed nothing — which is precisely the
// class-(i-b) hole (F-37) wearing new clothes. The positive assertion on
// `calls` is what survives a swallowing caller, so it is the only mechanism
// offered.

import { expect } from "vitest"
import { extractLuaAfter } from "./lua-script-sources.js"

/** One recorded `eval(script, { keys, arguments })`. */
export interface ObservedLuaCall {
  readonly script: string
  readonly keys: readonly string[]
  readonly arguments: readonly string[]
}

/** A production Lua site, named the way the shape suites name it. */
export interface LuaSiteRef {
  /** Repo-relative path, e.g. "apps/api/src/routes/checkout-confirmation-store.ts". */
  readonly file: string
  /** Unique anchor preceding the script literal, e.g. "const CONSUME_RECEIPT_SCRIPT =". */
  readonly anchor: string
}

/**
 * The read side of an observer — all `expectLuaCall`/`expectLuaCallCount` need.
 *
 * It is a separate type because `vi.hoisted` callbacks run BEFORE a test file's
 * imports are evaluated, so a file whose double is installed through a
 * `vi.mock` factory (e.g. `order-cancel-confirm.test.ts`) cannot call
 * `createLuaCallObserver` and must inline an equivalent recorder. Those files
 * still get the script-identity gate by satisfying this narrower shape.
 */
export interface LuaCallLog {
  readonly calls: readonly ObservedLuaCall[]
}

export interface LuaCallObserver extends LuaCallLog {
  /**
   * Install as the double's `eval`. Records the call and returns the declared
   * reply. It does not read, write or delete anything.
   */
  eval(
    script: string,
    opts: { keys: string[]; arguments?: string[] },
  ): Promise<unknown>
  /** Every call, in order. */
  readonly calls: readonly ObservedLuaCall[]
  /** Replies to the NEXT call only; queued in FIFO order. Overrides the default. */
  replyOnce(value: unknown): void
  /** Replies to every call with no queued `replyOnce` left. */
  reply(value: unknown): void
  /** Forget every recorded call and every queued reply. */
  reset(): void
}

/**
 * Build an observer.
 *
 * `defaultReply` is REQUIRED and has no default value — the reply is the
 * script's postcondition, and leaving it implicit is how an emulation starts.
 * Pass `1` for a CAD whose caller owns the key, `0` for one that does not,
 * the receipt string for a CONSUME that finds one, `null` for one that does
 * not.
 */
export function createLuaCallObserver(defaultReply: unknown): LuaCallObserver {
  const calls: ObservedLuaCall[] = []
  const queued: unknown[] = []
  let fallback = defaultReply

  return {
    calls,
    async eval(script, opts) {
      calls.push({
        script,
        keys: [...opts.keys],
        arguments: [...(opts.arguments ?? [])],
      })
      return queued.length > 0 ? queued.shift() : fallback
    },
    replyOnce(value) {
      queued.push(value)
    },
    reply(value) {
      fallback = value
    },
    reset() {
      calls.length = 0
      queued.length = 0
    },
  }
}

/**
 * Assert that call `index` issued the PRODUCTION script at `site`, against the
 * expected keys and ARGV.
 *
 * The script comparison is the anti-script-blindness gate: it names WHICH
 * production site's bytes the SUT handed the client, and that is the same
 * anchor `lua-shape-*-contract.test.ts` reads when it proves the shape against
 * a real Redis. A site that starts eval'ing some other script stops matching
 * its anchor and reds here, even though the shape suite — still reading the
 * anchor — would stay green.
 *
 * Omit `arguments` to say nothing about ARGV; pass `[]` to require it EMPTY.
 */
export function expectLuaCall(
  observer: LuaCallLog,
  index: number,
  expected: {
    readonly site: LuaSiteRef
    readonly keys: readonly string[]
    readonly arguments?: readonly string[]
  },
): void {
  const call = observer.calls[index]
  expect(
    call,
    `no Lua call at index ${index} — the site issued ${observer.calls.length} eval(s). ` +
      `A site that stopped calling its script is the failure this observation exists to catch.`,
  ).toBeDefined()

  expect(call!.script).toBe(extractLuaAfter(expected.site.file, expected.site.anchor))
  expect(call!.keys).toEqual([...expected.keys])
  if (expected.arguments !== undefined) {
    expect(call!.arguments).toEqual([...expected.arguments])
  }
}

/** Assert the site issued EXACTLY this many Lua calls. */
export function expectLuaCallCount(observer: LuaCallLog, count: number): void {
  expect(observer.calls).toHaveLength(count)
}
