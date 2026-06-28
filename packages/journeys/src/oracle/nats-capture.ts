// oracle/nats-capture.ts — publish-incapable NATS capture client (T1b-2, DR-2).
//
// Containment: journey oracles may OBSERVE the event bus (which subjects were
// — or were NOT — published during a run window) but must never inject events
// into the SUT. A test-plane publish would forge production signals
// (`payment.status_changed` → forged resume, `intent.defer.timeout` → forged
// LGPD anonymize — see packages/nats-client's W4 P0-12 header). Publishing is
// impossible here on three independent axes:
//
//   1. TYPE level — `NatsCapture` exposes ONLY `subscribe` / `expectSubjects`
//      / `drain` / `close`, and the structural `SubscribeOnlyConnection`
//      slice this module consumes deliberately omits `publish` / `request` /
//      `jetstream` (writing `capture.publish(...)` is a compile error —
//      pinned by @ts-expect-error blocks in the unit tests, which fail
//      `tsc --noEmit` if the surface ever grows a publish escape hatch).
//   2. RUNTIME — the capture WRAPS the connection (a frozen plain-object
//      literal closing over it — never a subclass, so no prototype-chain
//      leak), and construction runs `assertPublishUnreachable()`: every
//      publish-capable member name must be absent from the wrapper AND its
//      prototype chain, the prototype must be exactly `Object.prototype`,
//      and the wrapper is frozen so nothing can graft a publish on later.
//   3. CI — scripts/check-bypass.sh leg 8 greps packages/journeys for NATS
//      publish API calls (`.publish(`, `jetstream(`, `publishNatsEvent(`, …)
//      excluding only this module's guard internals + tests.
//
// Conventions (CLAUDE.md "NATS specifics"): subjects on the wire are
// `ibatexas.{domain}.{action}`; callers pass the SHORT form ("order.placed",
// wildcards "order.*" / ">") and this module adds/strips the prefix — same
// contract as @ibatexas/nats-client's publishNatsEvent/subscribeNatsEvent.
// Recorded + asserted subjects are always short-form.
//
// Live composition: `connectNatsCapture()` uses @ibatexas/nats-client
// (package→package import — sanctioned). T3-10 added the FOURTH axis —
// server-side enforcement: on an authed test stack the capture authenticates
// as a dedicated SUBSCRIBE-ONLY nkey user (IBX_TEST_NATS_CAPTURE_NKEY_SEED;
// infra/nats/nats-server.test-plane.conf denies its every publish at the
// server), opened via `openDedicatedNatsConnection` so it never rides the
// publish-capable app credential (NATS_NKEY_SEED) that also lives in the
// harness env. Fallback without capture creds: the env-driven singleton
// (`getNatsConnection()` — NATS_URL, NATS_CREDS_PATH, NATS_NKEY_SEED, …).

/** Thrown when the publish-incapability guard or input validation fails. */
export class NatsCaptureGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NatsCaptureGuardError"
  }
}

/** Thrown when an `expectSubjects()` window closes with violated expectations. */
export class NatsCaptureExpectationError extends Error {
  /** `published` patterns that matched no subject within the window. */
  readonly missing: readonly string[]
  /** `notPublished` patterns that DID match, with the offending subject. */
  readonly forbiddenSeen: readonly { pattern: string; subject: string }[]
  /** Distinct short-form subjects observed in the window (arrival order). */
  readonly observed: readonly string[]

  constructor(
    message: string,
    details: {
      missing: readonly string[]
      forbiddenSeen: readonly { pattern: string; subject: string }[]
      observed: readonly string[]
    },
  ) {
    super(message)
    this.name = "NatsCaptureExpectationError"
    this.missing = details.missing
    this.forbiddenSeen = details.forbiddenSeen
    this.observed = details.observed
  }
}

/** One recorded message — `subject` is short-form (prefix stripped). */
export interface CapturedMessage {
  subject: string
  /** UTF-8 decoded payload (domain events are JSON strings). */
  data: string
  receivedAt: number
}

/** Message shape the capture consumes (nats.js `Msg` satisfies it). */
export interface CaptureMessageLike {
  subject: string
  data: Uint8Array
}

/** Subscription shape the capture consumes (nats.js `Subscription` satisfies it). */
export interface CaptureSubscriptionLike extends AsyncIterable<CaptureMessageLike> {
  unsubscribe(): void
}

/**
 * Structural slice of a NATS connection — the type-level half of the
 * publish-incapability guarantee. `publish` / `request` / `jetstream` are
 * DELIBERATELY absent: the wrapper cannot even see them through this type.
 * The real `NatsConnection` (via @ibatexas/nats-client) satisfies the slice;
 * unit tests inject an in-memory double.
 */
export interface SubscribeOnlyConnection {
  subscribe(subject: string): CaptureSubscriptionLike
  drain(): Promise<void>
  /** Optional: awaited before `expectSubjects` acts (interest propagation). */
  flush?(): Promise<void>
  /** Optional: preferred by `close()`; falls back to `drain()`. */
  close?(): Promise<void>
}

/** Handle returned by `subscribe()` — read-only view of what was recorded. */
export interface CaptureSubscriptionHandle {
  /** Short-form subjects recorded so far, in arrival order (with repeats). */
  subjects(): readonly string[]
  /** Full recorded messages, in arrival order. */
  messages(): readonly CapturedMessage[]
  unsubscribe(): void
}

/** Positive + negative subject expectations (short-form, NATS wildcards ok). */
export interface SubjectExpectations {
  /** Patterns that MUST each match ≥1 published subject within the window. */
  published?: readonly string[]
  /** Patterns that must match NO published subject within the window. */
  notPublished?: readonly string[]
}

export interface ExpectSubjectsOptions {
  /** Run-window length in milliseconds (must be a positive finite number). */
  within: number
  /**
   * Optional act to run AFTER the recorder subscription is armed (and the
   * connection flushed, when supported) — guarantees subscribe-before-act
   * ordering without the caller juggling unawaited promises.
   */
  act?: () => void | Promise<void>
}

export interface ExpectSubjectsResult {
  /** Distinct short-form subjects observed in the window (arrival order). */
  observed: readonly string[]
  /** Per `published` pattern: the observed subjects that matched it. */
  matchedBy: Readonly<Record<string, readonly string[]>>
}

/**
 * The whole public surface: subscribe / expectSubjects / drain / close —
 * and NOTHING else. No publish, no request, no jetstream, ever.
 */
export interface NatsCapture {
  /** Record every message matching the short-form pattern (prefix added). */
  subscribe(pattern: string): CaptureSubscriptionHandle
  /**
   * Arm a recorder over the whole `ibatexas.>` namespace, run `opts.act`
   * (if given), then assert which subjects were (or were NOT) published
   * within `opts.within` ms. Resolves early when all `published` patterns
   * matched and no `notPublished` patterns are pending; rejects immediately
   * on a `notPublished` hit; rejects at window close on missing `published`.
   */
  expectSubjects(patterns: SubjectExpectations, opts: ExpectSubjectsOptions): Promise<ExpectSubjectsResult>
  /** Drain in-flight messages, then close the underlying connection. */
  drain(): Promise<void>
  /** Close the underlying connection (releases the package singleton when built via `connectNatsCapture`). */
  close(): Promise<void>
}

export interface NatsCaptureOptions {
  /** Wire prefix; defaults to the repo-wide `ibatexas.` (CLAUDE.md). */
  subjectPrefix?: string
  /** Override for `close()` — `connectNatsCapture` resets the nats-client singleton here. */
  onClose?: () => Promise<void>
}

const DEFAULT_SUBJECT_PREFIX = "ibatexas."

/**
 * Publish-capable member names that must be unreachable through the wrapper.
 * Covers Core NATS (`publish`, `request`, `requestMany`, `publishMessage`),
 * JetStream entry points, and the in-repo helper name.
 */
const FORBIDDEN_PUBLISH_MEMBERS = [
  "publish",
  "publishMessage",
  "request",
  "requestMany",
  "jetstream",
  "jetstreamManager",
  "publishNatsEvent",
] as const

/**
 * Runtime half of the guard, run at construction: no publish-capable member
 * may be reachable through the wrapper — neither as an own property nor via
 * the prototype chain (`in` walks it, catching any subclass/Object.create
 * regression of the wrap-don't-subclass rule).
 */
export function assertPublishUnreachable(wrapper: object): void {
  const proto: unknown = Object.getPrototypeOf(wrapper)
  if (proto !== Object.prototype && proto !== null) {
    throw new NatsCaptureGuardError(
      "nats-capture must WRAP the connection in a plain object — a non-plain " +
        "prototype chain could leak the underlying connection's publish surface",
    )
  }
  for (const member of FORBIDDEN_PUBLISH_MEMBERS) {
    if (member in wrapper) {
      throw new NatsCaptureGuardError(
        `nats-capture is subscribe-only: "${member}" is reachable through the ` +
          "wrapper — the test plane must never be able to publish into the SUT",
      )
    }
  }
}

/**
 * Short-form NATS wildcard match: `*` matches exactly one token, `>` matches
 * one-or-more trailing tokens. Exported for oracle assertions over recorded
 * subject lists.
 */
export function subjectMatchesPattern(subject: string, pattern: string): boolean {
  const subjectTokens = subject.split(".")
  const patternTokens = pattern.split(".")
  for (let i = 0; i < patternTokens.length; i++) {
    const token = patternTokens[i]
    if (token === ">") return subjectTokens.length >= i + 1
    if (i >= subjectTokens.length) return false
    if (token !== "*" && token !== subjectTokens[i]) return false
  }
  return subjectTokens.length === patternTokens.length
}

function assertShortForm(pattern: string, prefix: string): void {
  if (pattern.length === 0) {
    throw new NatsCaptureGuardError("nats-capture: subject pattern must not be empty")
  }
  if (pattern.startsWith(prefix)) {
    throw new NatsCaptureGuardError(
      `nats-capture: pass SHORT-form subjects ("${pattern.slice(prefix.length)}") — ` +
        `the capture adds the "${prefix}" prefix, same as publishNatsEvent/subscribeNatsEvent`,
    )
  }
}

/**
 * Run one `expectSubjects` window. Defined at module scope (not nested inside
 * `createNatsCapture` → `expectSubjects`) so the recorder/timeout callbacks
 * stay within the function-nesting budget. The recorder is armed SYNCHRONOUSLY
 * inside the Promise executor — only messages delivered to it count for this
 * window — then `beforeWindow` (flush + caller act) runs; an act failure fails
 * the expectation.
 */
function awaitSubjectExpectations(args: {
  within: number
  published: string[]
  notPublished: string[]
  pump: (
    shortFormPattern: string,
    onMessage: (message: CapturedMessage) => void,
  ) => { unsubscribe(): void }
  beforeWindow: () => Promise<void>
}): Promise<ExpectSubjectsResult> {
  const { within, published, notPublished, pump, beforeWindow } = args
  const observed: string[] = []
  const observedSet = new Set<string>()
  const matchedBy: Record<string, string[]> = {}
  for (const pattern of published) matchedBy[pattern] = []
  const forbiddenSeen: { pattern: string; subject: string }[] = []

  return new Promise<ExpectSubjectsResult>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // Idempotent settle guard: claims the single resolution, clears the timer,
    // and tears down the recorder. Returns false if already settled.
    const settleGuard = (): boolean => {
      if (settled) return false
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      recorder.unsubscribe()
      return true
    }

    const succeed = (): void => {
      if (settleGuard()) {
        resolve({ observed: [...observed], matchedBy: { ...matchedBy } })
      }
    }

    const fail = (message: string): void => {
      if (!settleGuard()) return
      reject(
        new NatsCaptureExpectationError(message, {
          missing: published.filter((pattern) => matchedBy[pattern].length === 0),
          forbiddenSeen: [...forbiddenSeen],
          observed: [...observed],
        }),
      )
    }

    const recorder = pump(">", (message) => {
      if (settled) return
      if (!observedSet.has(message.subject)) {
        observedSet.add(message.subject)
        observed.push(message.subject)
      }
      for (const pattern of notPublished) {
        if (subjectMatchesPattern(message.subject, pattern)) {
          forbiddenSeen.push({ pattern, subject: message.subject })
          fail(
            `expectSubjects: forbidden subject "${message.subject}" was published ` +
              `(matches notPublished pattern "${pattern}")`,
          )
          return
        }
      }
      for (const pattern of published) {
        if (subjectMatchesPattern(message.subject, pattern)) {
          matchedBy[pattern].push(message.subject)
        }
      }
      // Early resolve only when no absence assertions are pending — a
      // notPublished expectation needs the FULL window to prove absence.
      if (
        notPublished.length === 0 &&
        published.every((pattern) => matchedBy[pattern].length > 0)
      ) {
        succeed()
      }
    })

    timer = setTimeout(() => {
      const missing = published.filter((pattern) => matchedBy[pattern].length === 0)
      if (missing.length > 0) {
        fail(
          `expectSubjects: window (${within}ms) closed with unmatched published ` +
            `pattern(s): ${missing.join(", ")} — observed: [${observed.join(", ")}]`,
        )
      } else {
        succeed()
      }
    }, within)

    void beforeWindow().catch((error: unknown) => {
      fail(
        `expectSubjects: act threw before the window closed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    })
  })
}

/** Wrap a subscribe-only connection slice into a publish-incapable capture. */
export function createNatsCapture(
  connection: SubscribeOnlyConnection,
  options?: NatsCaptureOptions,
): NatsCapture {
  const prefix = options?.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX
  const decoder = new TextDecoder()
  let closed = false

  function assertOpen(operation: string): void {
    if (closed) {
      throw new NatsCaptureGuardError(`nats-capture: ${operation} after drain()/close()`)
    }
  }

  /** Start one recorder subscription; pump decoded short-form messages to `onMessage`. */
  function pump(
    shortFormPattern: string,
    onMessage: (message: CapturedMessage) => void,
  ): { unsubscribe(): void } {
    const sub = connection.subscribe(prefix + shortFormPattern)
    void (async () => {
      for await (const msg of sub) {
        const subject = msg.subject.startsWith(prefix) ? msg.subject.slice(prefix.length) : msg.subject
        onMessage({ subject, data: decoder.decode(msg.data), receivedAt: Date.now() })
      }
    })().catch(() => {
      // Subscription iterator ended/errored during teardown — expected.
    })
    return { unsubscribe: () => sub.unsubscribe() }
  }

  function subscribe(pattern: string): CaptureSubscriptionHandle {
    assertOpen("subscribe()")
    assertShortForm(pattern, prefix)
    const log: CapturedMessage[] = []
    const sub = pump(pattern, (message) => log.push(message))
    return {
      subjects: () => log.map((message) => message.subject),
      messages: () => [...log],
      unsubscribe: () => sub.unsubscribe(),
    }
  }

  function expectSubjects(
    patterns: SubjectExpectations,
    opts: ExpectSubjectsOptions,
  ): Promise<ExpectSubjectsResult> {
    assertOpen("expectSubjects()")
    if (!Number.isFinite(opts.within) || opts.within <= 0) {
      throw new NatsCaptureGuardError(
        `nats-capture: expectSubjects "within" must be a positive finite ms count (got ${String(opts.within)})`,
      )
    }
    const published = [...(patterns.published ?? [])]
    const notPublished = [...(patterns.notPublished ?? [])]
    if (published.length === 0 && notPublished.length === 0) {
      throw new NatsCaptureGuardError(
        "nats-capture: expectSubjects needs at least one published/notPublished pattern",
      )
    }
    for (const pattern of [...published, ...notPublished]) {
      assertShortForm(pattern, prefix)
    }

    // Subscribe-before-act ordering: the recorder is armed synchronously, then
    // interest is flushed (when supported) and the act runs — without the
    // caller juggling unawaited promises. `connection.flush` / `opts.act` are
    // called as methods so their `this` binding is preserved.
    return awaitSubjectExpectations({
      within: opts.within,
      published,
      notPublished,
      pump,
      beforeWindow: async () => {
        await connection.flush?.()
        if (opts.act) await opts.act()
      },
    })
  }

  async function drain(): Promise<void> {
    if (closed) return
    closed = true
    await connection.drain()
  }

  async function close(): Promise<void> {
    if (closed) return
    closed = true
    if (options?.onClose) {
      await options.onClose()
      return
    }
    if (connection.close) {
      await connection.close()
      return
    }
    await connection.drain()
  }

  // Wrap, don't subclass: a frozen plain-object literal closing over the
  // connection. Construction-time guard + freeze = no publish, ever.
  const capture: NatsCapture = Object.freeze({ subscribe, expectSubjects, drain, close })
  assertPublishUnreachable(capture)
  return capture
}

/**
 * Live composition: wrap a NATS connection into a publish-incapable capture.
 *
 * T3-10 — per-role test-plane credentials (server-side enforcement): when the
 * capture credential is provisioned (`IBX_TEST_NATS_CAPTURE_CREDS_PATH` or
 * `IBX_TEST_NATS_CAPTURE_NKEY_SEED`, written by scripts/gen-env-test.sh), the
 * capture opens a DEDICATED connection authenticated as the SUBSCRIBE-ONLY
 * capture user (infra/nats/nats-server.test-plane.conf: `publish: deny ">"`).
 * It must NOT ride the package singleton on an authed stack: the harness env
 * also carries the app seed (NATS_NKEY_SEED via .env.test), so the singleton
 * would authenticate as the publish-capable app user — the server-side half
 * of the publish-incapability guarantee would be silently lost. `close()`
 * closes the dedicated connection (the singleton is untouched).
 *
 * Fallback (no capture credential in the env — unit doubles, pre-T3-10
 * stacks): the repo's env-driven singleton via `getNatsConnection()`, with
 * `close()` routed through `closeNatsConnection()` so the package singleton
 * resets cleanly. The wrapper's client-side guarantees (type slice + runtime
 * guard + check-bypass leg 8) hold on both paths.
 */
export async function connectNatsCapture(
  options?: Pick<NatsCaptureOptions, "subjectPrefix">,
): Promise<NatsCapture> {
  const captureCredsPath = process.env.IBX_TEST_NATS_CAPTURE_CREDS_PATH
  const captureNkeySeed = process.env.IBX_TEST_NATS_CAPTURE_NKEY_SEED
  const prefixOption =
    options?.subjectPrefix === undefined ? {} : { subjectPrefix: options.subjectPrefix }

  if (
    (captureCredsPath !== undefined && captureCredsPath.length > 0) ||
    (captureNkeySeed !== undefined && captureNkeySeed.length > 0)
  ) {
    const { openDedicatedNatsConnection } = await import("@ibatexas/nats-client")
    const connection = await openDedicatedNatsConnection({
      ...(captureCredsPath ? { credsPath: captureCredsPath } : {}),
      ...(captureNkeySeed ? { nkeySeed: captureNkeySeed } : {}),
    })
    return createNatsCapture(connection, {
      ...prefixOption,
      onClose: async () => {
        await connection.close()
      },
    })
  }

  const { getNatsConnection, closeNatsConnection } = await import("@ibatexas/nats-client")
  const connection = await getNatsConnection()
  return createNatsCapture(connection, {
    ...prefixOption,
    onClose: () => closeNatsConnection(),
  })
}
