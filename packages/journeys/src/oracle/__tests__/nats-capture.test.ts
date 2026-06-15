// Tests for oracle/nats-capture.ts — the publish-incapable NATS capture (T1b-2).
//
// The @ts-expect-error blocks are the TYPE-LEVEL half of the guarantee: they
// fail `tsc --noEmit` (the package lint) if `NatsCapture` or the
// `SubscribeOnlyConnection` slice ever grows a publish/request/jetstream
// escape hatch. The runtime assertions are the other half: the wrapper has no
// reachable publish member (own OR prototype chain), is frozen, and never
// invokes a publish-capable member on the underlying connection.
//
// CI's third half lives in scripts/check-bypass.sh leg 8 (no NATS publish
// API calls anywhere in packages/journeys outside this guard module + tests).
import { describe, expect, it, vi } from "vitest"

import {
  assertPublishUnreachable,
  createNatsCapture,
  NatsCaptureExpectationError,
  NatsCaptureGuardError,
  subjectMatchesPattern,
  type CaptureMessageLike,
  type NatsCapture,
  type SubscribeOnlyConnection,
} from "../nats-capture.js"

// ── In-memory NATS double ───────────────────────────────────────────────────

const encoder = new TextEncoder()

class MockSubscription implements AsyncIterable<CaptureMessageLike> {
  private readonly queue: CaptureMessageLike[] = []
  private readonly waiters: ((result: IteratorResult<CaptureMessageLike>) => void)[] = []
  private done = false

  constructor(readonly subject: string) {}

  push(message: CaptureMessageLike): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: message, done: false })
      return
    }
    this.queue.push(message)
  }

  unsubscribe(): void {
    this.done = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CaptureMessageLike> {
    return {
      next: (): Promise<IteratorResult<CaptureMessageLike>> => {
        const queued = this.queue.shift()
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

/**
 * Full-form wildcard match for the double's delivery fan-out — reuses the
 * module's matcher (token semantics are identical on prefixed subjects).
 */
function deliveryMatches(subject: string, subscriptionSubject: string): boolean {
  return subjectMatchesPattern(subject, subscriptionSubject)
}

class MockNatsConnection {
  readonly subscriptions: MockSubscription[] = []
  publishCalls = 0
  drainCalls = 0
  closeCalls = 0
  flushCalls = 0

  subscribe(subject: string): MockSubscription {
    const sub = new MockSubscription(subject)
    this.subscriptions.push(sub)
    return sub
  }

  /** The SUT side of the double — tests act through it, never the capture. */
  publish(subject: string, data: Uint8Array): void {
    this.publishCalls += 1
    for (const sub of this.subscriptions) {
      if (deliveryMatches(subject, sub.subject)) {
        sub.push({ subject, data })
      }
    }
  }

  publishJson(shortFormSubject: string, payload: Record<string, unknown> = {}): void {
    this.publish(`ibatexas.${shortFormSubject}`, encoder.encode(JSON.stringify(payload)))
  }

  flush(): Promise<void> {
    this.flushCalls += 1
    return Promise.resolve()
  }

  drain(): Promise<void> {
    this.drainCalls += 1
    for (const sub of this.subscriptions) sub.unsubscribe()
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closeCalls += 1
    for (const sub of this.subscriptions) sub.unsubscribe()
    return Promise.resolve()
  }
}

function makeCapture(): { mock: MockNatsConnection; capture: NatsCapture } {
  const mock = new MockNatsConnection()
  return { mock, capture: createNatsCapture(mock) }
}

// ── Recording ───────────────────────────────────────────────────────────────

describe("createNatsCapture — recording", () => {
  it("records short-form subjects and subscribes with the ibatexas. prefix added", async () => {
    const { mock, capture } = makeCapture()
    const handle = capture.subscribe("order.*")

    // Short form in → prefixed on the wire (CLAUDE.md NATS convention).
    expect(mock.subscriptions[0].subject).toBe("ibatexas.order.*")

    mock.publishJson("order.placed", { orderId: "ord_1" })
    mock.publishJson("order.canceled", { orderId: "ord_1" })
    mock.publishJson("payment.status_changed", {}) // does not match order.*

    await vi.waitFor(() => expect(handle.subjects()).toHaveLength(2))
    // Short form out — recorded subjects have the prefix stripped.
    expect(handle.subjects()).toEqual(["order.placed", "order.canceled"])
    expect(handle.messages()[0].data).toBe(JSON.stringify({ orderId: "ord_1" }))

    handle.unsubscribe()
    mock.publishJson("order.placed")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(handle.subjects()).toHaveLength(2)
  })

  it("rejects full-prefixed patterns (short-form convention) and empty patterns", () => {
    const { capture } = makeCapture()
    expect(() => capture.subscribe("ibatexas.order.placed")).toThrow(NatsCaptureGuardError)
    expect(() => capture.subscribe("")).toThrow(NatsCaptureGuardError)
  })

  it("refuses to subscribe after drain/close", async () => {
    const { mock, capture } = makeCapture()
    await capture.drain()
    expect(mock.drainCalls).toBe(1)
    expect(() => capture.subscribe("order.placed")).toThrow(NatsCaptureGuardError)
  })
})

// ── expectSubjects ──────────────────────────────────────────────────────────

describe("expectSubjects — positive", () => {
  it("resolves when an expected subject is published in the window (subscribe-before-act)", async () => {
    const { mock, capture } = makeCapture()

    const result = await capture.expectSubjects(
      { published: ["order.placed", "order.*"] },
      {
        within: 1000,
        act: () => {
          // The recorder is already armed (and flushed) when act runs.
          expect(mock.subscriptions.length).toBeGreaterThan(0)
          expect(mock.flushCalls).toBe(1)
          mock.publishJson("order.placed", { orderId: "ord_1" })
        },
      },
    )

    expect(result.observed).toEqual(["order.placed"])
    expect(result.matchedBy["order.placed"]).toEqual(["order.placed"])
    expect(result.matchedBy["order.*"]).toEqual(["order.placed"])
  })

  it("rejects with the missing patterns when an expected subject is never published", async () => {
    const { mock, capture } = makeCapture()

    const expectation = capture.expectSubjects(
      { published: ["payment.status_changed"] },
      { within: 30, act: () => mock.publishJson("order.placed") },
    )

    await expect(expectation).rejects.toThrow(NatsCaptureExpectationError)
    const error = (await expectation.then(
      () => undefined,
      (caught: unknown) => caught,
    )) as NatsCaptureExpectationError
    expect(error.missing).toEqual(["payment.status_changed"])
    expect(error.observed).toEqual(["order.placed"])
    expect(error.forbiddenSeen).toEqual([])
  })

  it("only counts messages published inside the run window (pre-arm publishes invisible)", async () => {
    const { mock, capture } = makeCapture()

    // Published BEFORE arming — must not satisfy the expectation.
    mock.publishJson("order.placed")

    await expect(
      capture.expectSubjects({ published: ["order.placed"] }, { within: 30 }),
    ).rejects.toThrow(NatsCaptureExpectationError)
  })
})

describe("expectSubjects — negative (subject NOT published)", () => {
  it("resolves after the full window when forbidden subjects stay silent", async () => {
    const { mock, capture } = makeCapture()

    const result = await capture.expectSubjects(
      { published: ["order.placed"], notPublished: ["order.canceled", "payment.>"] },
      { within: 30, act: () => mock.publishJson("order.placed") },
    )

    expect(result.observed).toEqual(["order.placed"])
  })

  it("rejects immediately when a forbidden subject IS published", async () => {
    const { mock, capture } = makeCapture()

    const expectation = capture.expectSubjects(
      { notPublished: ["order.*"] },
      // Window is long on purpose: the forbidden hit must NOT wait it out.
      { within: 60_000, act: () => mock.publishJson("order.canceled") },
    )

    await expect(expectation).rejects.toThrow(NatsCaptureExpectationError)
    const error = (await expectation.then(
      () => undefined,
      (caught: unknown) => caught,
    )) as NatsCaptureExpectationError
    expect(error.forbiddenSeen).toEqual([{ pattern: "order.*", subject: "order.canceled" }])
  })

  it("fails the expectation when the act itself throws", async () => {
    const { capture } = makeCapture()
    await expect(
      capture.expectSubjects(
        { published: ["order.placed"] },
        {
          within: 60_000,
          act: () => {
            throw new Error("act exploded")
          },
        },
      ),
    ).rejects.toThrow(/act exploded/)
  })

  it("validates within and requires at least one expectation", () => {
    const { capture } = makeCapture()
    expect(() => capture.expectSubjects({ published: ["x"] }, { within: 0 })).toThrow(
      NatsCaptureGuardError,
    )
    expect(() => capture.expectSubjects({ published: ["x"] }, { within: Number.NaN })).toThrow(
      NatsCaptureGuardError,
    )
    expect(() => capture.expectSubjects({}, { within: 10 })).toThrow(NatsCaptureGuardError)
  })
})

// ── Wildcard matcher ────────────────────────────────────────────────────────

describe("subjectMatchesPattern", () => {
  it("matches literals, * (one token) and > (one-or-more trailing tokens)", () => {
    expect(subjectMatchesPattern("order.placed", "order.placed")).toBe(true)
    expect(subjectMatchesPattern("order.placed", "order.*")).toBe(true)
    expect(subjectMatchesPattern("order.placed", "*.placed")).toBe(true)
    expect(subjectMatchesPattern("order.placed", ">")).toBe(true)
    expect(subjectMatchesPattern("order.placed", "order.>")).toBe(true)
    expect(subjectMatchesPattern("order.placed.v1", "order.*")).toBe(false)
    expect(subjectMatchesPattern("order.placed.v1", "order.>")).toBe(true)
    expect(subjectMatchesPattern("order", "order.>")).toBe(false)
    expect(subjectMatchesPattern("payment.status_changed", "order.*")).toBe(false)
  })
})

// ── Runtime publish-incapability guard ──────────────────────────────────────

describe("createNatsCapture — publish unreachable at RUNTIME", () => {
  it("exposes no publish-capable member, on the wrapper or its prototype chain", () => {
    const { capture } = makeCapture()
    const surface = capture as unknown as Record<string, unknown>

    for (const member of [
      "publish",
      "publishMessage",
      "request",
      "requestMany",
      "jetstream",
      "jetstreamManager",
      "publishNatsEvent",
    ]) {
      expect(member in surface, `"${member}" must be unreachable through the wrapper`).toBe(false)
      expect(surface[member]).toBeUndefined()
    }

    // Wrap, don't subclass: plain-object prototype, nothing leaks through.
    expect(Object.getPrototypeOf(capture)).toBe(Object.prototype)
    expect(Object.keys(capture).sort()).toEqual(["close", "drain", "expectSubjects", "subscribe"])
  })

  it("is frozen — a publish member cannot be grafted on after construction", () => {
    const { capture } = makeCapture()
    expect(Object.isFrozen(capture)).toBe(true)
    expect(() => {
      ;(capture as unknown as Record<string, unknown>).publish = () => undefined
    }).toThrow(TypeError)
  })

  it("never invokes the underlying connection's publish surface", async () => {
    const mock = new MockNatsConnection()
    const poisoned = new Proxy(mock, {
      get(target, property, receiver) {
        if (property === "publish" || property === "request" || property === "jetstream") {
          throw new Error(`capture touched forbidden member "${String(property)}"`)
        }
        return Reflect.get(target, property, receiver)
      },
    })

    const capture = createNatsCapture(poisoned as unknown as SubscribeOnlyConnection)
    const handle = capture.subscribe("order.*")
    // Publish through the raw mock (the SUT), never through the capture path.
    mock.publishJson("order.placed")
    await vi.waitFor(() => expect(handle.subjects()).toEqual(["order.placed"]))
    await capture.drain()
  })

  it("assertPublishUnreachable rejects wrappers that leak a publish surface", () => {
    expect(() => assertPublishUnreachable({ publish: () => undefined })).toThrow(
      NatsCaptureGuardError,
    )
    // Prototype-chain leak (the subclass/Object.create regression).
    expect(() =>
      assertPublishUnreachable(Object.create({ publish: () => undefined }) as object),
    ).toThrow(NatsCaptureGuardError)
    // Non-plain prototype is refused even without a visible publish member.
    class Wrapper {}
    expect(() => assertPublishUnreachable(new Wrapper())).toThrow(NatsCaptureGuardError)
    expect(() => assertPublishUnreachable({ subscribe: () => undefined })).not.toThrow()
  })
})

// ── Type-level publish-incapability guarantee ───────────────────────────────

describe("createNatsCapture — publish does not TYPECHECK", () => {
  it("rejects publish/request/jetstream at compile time (pinned by @ts-expect-error)", () => {
    const { mock, capture } = makeCapture()

    // @ts-expect-error — NatsCapture has no `publish` member.
    const publish = capture.publish
    // @ts-expect-error — NatsCapture has no `publishMessage` member.
    const publishMessage = capture.publishMessage
    // @ts-expect-error — NatsCapture has no `request` member.
    const request = capture.request
    // @ts-expect-error — NatsCapture has no `jetstream` member.
    const jetstream = capture.jetstream
    // @ts-expect-error — NatsCapture has no `jetstreamManager` member.
    const jetstreamManager = capture.jetstreamManager
    expect([publish, publishMessage, request, jetstream, jetstreamManager]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])

    // The structural connection slice can't see publish either — the wrapper
    // could not call it even on a connection that has one (type-level wrap).
    const slice: SubscribeOnlyConnection = mock
    // @ts-expect-error — SubscribeOnlyConnection deliberately omits `publish`.
    void slice.publish
    // @ts-expect-error — SubscribeOnlyConnection deliberately omits `request`.
    void slice.request
    // @ts-expect-error — SubscribeOnlyConnection deliberately omits `jetstream`.
    void slice.jetstream
  })
})
