// Tests for harness/preflight.ts — the T1a-10 environment handshake.
// All four checks with mocked fetch/env: refusal cases, the pass case, and
// the nonCertifying escape path. Also asserts every check is recorded into
// the trace (preflight.check events) and that the API key value never leaks.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { onEvent, type IbxEventBase } from "@ibatexas/tools"

import {
  CERTIFICATION_MODEL,
  NON_CERTIFYING_ENV,
  PreflightRefusalError,
  runPreflight,
  TEST_FINGERPRINT_ENV,
  type FetchLike,
} from "../preflight.js"

const FINGERPRINT = "fp-t1a10-unit"
const SECRET_KEY = "sk-ant-NEVER-LOG-THIS-VALUE-0000000000"

/** Env contract of a healthy ephemeral test stack (mirrors .env.test). */
function testEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    [TEST_FINGERPRINT_ENV]: FINGERPRINT,
    ANTHROPIC_MODEL: CERTIFICATION_MODEL,
    ANTHROPIC_API_KEY: SECRET_KEY,
    NEXT_PUBLIC_API_URL: "http://localhost:3001",
    MEDUSA_URL: "http://localhost:9000",
    DATABASE_URL: "postgresql://ibatexas:pw@localhost:5434/ibatexas_test",
    REDIS_URL: "redis://:pw@localhost:6380/1",
    TYPESENSE_HOST: "localhost",
    TYPESENSE_PORT: "8109",
    NATS_URL: "nats://localhost:4223",
    ...overrides,
  }
}

function healthFetch(body: unknown, status = 200): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

const okFetch = (): FetchLike => healthFetch({ status: "healthy", testFingerprint: FINGERPRINT })

describe("runPreflight", () => {
  let events: IbxEventBase[]
  let unsub: () => void

  beforeEach(() => {
    events = []
    unsub = onEvent((e) => events.push(e))
  })

  afterEach(() => {
    unsub()
  })

  const traceChecks = () => events.filter((e) => e.type === "preflight.check")

  // ── Pass case ───────────────────────────────────────────────────────────────

  it("passes against a matching test stack and marks the run certifying", async () => {
    const result = await runPreflight({
      env: testEnv(),
      fetchImpl: okFetch(),
      journeyId: "JOURNEY-001",
      runId: "run-pf-1",
    })

    expect(result.ok).toBe(true)
    expect(result.certifying).toBe(true)
    expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
      ["fingerprint", true],
      ["hostnames", true],
      ["model", true],
      ["api-key", true],
    ])

    // every check recorded into the trace, stamped with journey/run ids
    expect(traceChecks().map((e) => [e.check, e.outcome])).toEqual([
      ["fingerprint", "pass"],
      ["hostnames", "pass"],
      ["model", "pass"],
      ["api-key", "pass"],
    ])
    for (const e of traceChecks()) {
      expect(e).toMatchObject({ journey: "JOURNEY-001", runId: "run-pf-1" })
    }
  })

  it("accepts a degraded (non-2xx) /health as long as the fingerprint matches", async () => {
    // identity check, not a health check — a 503 boot still names itself
    const result = await runPreflight({
      env: testEnv(),
      fetchImpl: healthFetch({ status: "unhealthy", testFingerprint: FINGERPRINT }, 503),
    })
    expect(result.ok).toBe(true)
  })

  // ── (a) fingerprint refusals ───────────────────────────────────────────────

  it("refuses when /health exposes no testFingerprint (non-test stack)", async () => {
    const promise = runPreflight({
      env: testEnv(),
      fetchImpl: healthFetch({ status: "healthy" }), // dev stack: no fingerprint
    })

    await expect(promise).rejects.toThrow(PreflightRefusalError)
    await expect(
      runPreflight({ env: testEnv(), fetchImpl: healthFetch({ status: "healthy" }) }),
    ).rejects.toThrow(/preflight_refused.*\[fingerprint\].*no testFingerprint/)
  })

  it("refuses on testFingerprint mismatch (someone else's test stack)", async () => {
    await expect(
      runPreflight({
        env: testEnv(),
        fetchImpl: healthFetch({ testFingerprint: "fp-someone-else" }),
      }),
    ).rejects.toThrow(/\[fingerprint\].*mismatch/)
  })

  it("refuses when the harness env itself lacks IBX_TEST_FINGERPRINT", async () => {
    await expect(
      runPreflight({
        env: testEnv({ [TEST_FINGERPRINT_ENV]: undefined }),
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(new RegExp(`\\[fingerprint\\].*${TEST_FINGERPRINT_ENV}`))
  })

  it("refuses when GET /health is unreachable", async () => {
    const failingFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:3001")
    }
    await expect(
      runPreflight({ env: testEnv(), fetchImpl: failingFetch }),
    ).rejects.toThrow(/\[fingerprint\].*GET http:\/\/localhost:3001\/health failed/)
  })

  // ── (b) hostname denylist refusals ─────────────────────────────────────────

  it("refuses a denylisted prod DB hostname", async () => {
    await expect(
      runPreflight({
        env: testEnv({
          DATABASE_URL: "postgresql://app:pw@db.prod.ibatexas.com.br:5432/ibatexas",
        }),
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(/\[hostnames\].*PostgreSQL=db\.prod\.ibatexas\.com\.br.*denylisted/)
  })

  it("refuses a non-local api host even when not on the denylist (fail-closed)", async () => {
    await expect(
      runPreflight({
        env: testEnv({ NEXT_PUBLIC_API_URL: "http://some-random-box.internal:3001" }),
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(/\[hostnames\].*api=some-random-box\.internal.*not a local\/ephemeral host/)
  })

  it("refuses a cloud Redis (denylisted fragment) resolved via infraEndpoints", async () => {
    await expect(
      runPreflight({
        env: testEnv({ REDIS_URL: "redis://default:pw@fly-ibx.upstash.io:6379" }),
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(/\[hostnames\].*Redis=fly-ibx\.upstash\.io.*denylisted/)
  })

  it("accepts loopback variants (127.0.0.1) and checks api/commerce/infra hosts", async () => {
    const result = await runPreflight({
      env: testEnv({
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:3001",
        MEDUSA_URL: "http://127.0.0.1:9000",
      }),
      fetchImpl: okFetch(),
    })
    const hostnames = result.checks.find((c) => c.name === "hostnames")
    expect(hostnames?.ok).toBe(true)
    // the check covers api + commerce + the four infra endpoints
    for (const name of ["api=", "commerce=", "PostgreSQL=", "Redis=", "Typesense=", "NATS="]) {
      expect(hostnames?.detail).toContain(name)
    }
  })

  // ── (c) model pin + nonCertifying escape ───────────────────────────────────

  it("refuses a non-certification model without the escape flag", async () => {
    await expect(
      runPreflight({
        env: testEnv({ ANTHROPIC_MODEL: "claude-haiku-4-5" }),
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(
      new RegExp(`\\[model\\].*claude-haiku-4-5.*${CERTIFICATION_MODEL}`),
    )
  })

  it("nonCertifying option: tolerates a cheap model and marks the run NON-certifying", async () => {
    const result = await runPreflight({
      env: testEnv({ ANTHROPIC_MODEL: "claude-haiku-4-5" }),
      fetchImpl: okFetch(),
      nonCertifying: true,
    })
    expect(result.ok).toBe(true)
    expect(result.certifying).toBe(false)
    expect(traceChecks().find((e) => e.check === "model")).toMatchObject({
      outcome: "pass",
    })
    expect(
      result.checks.find((c) => c.name === "model")?.detail,
    ).toContain("NON-certifying")
  })

  it(`nonCertifying env escape (${NON_CERTIFYING_ENV}=1) works like the option`, async () => {
    const result = await runPreflight({
      env: testEnv({ ANTHROPIC_MODEL: "claude-haiku-4-5", [NON_CERTIFYING_ENV]: "1" }),
      fetchImpl: okFetch(),
    })
    expect(result.ok).toBe(true)
    expect(result.certifying).toBe(false)
  })

  it("the escape marks the run non-certifying even on the certification model", async () => {
    const result = await runPreflight({
      env: testEnv({ [NON_CERTIFYING_ENV]: "true" }),
      fetchImpl: okFetch(),
    })
    expect(result.ok).toBe(true)
    expect(result.certifying).toBe(false)
  })

  it("refuses when ANTHROPIC_MODEL is unset, even with the escape", async () => {
    await expect(
      runPreflight({
        env: testEnv({ ANTHROPIC_MODEL: undefined }),
        fetchImpl: okFetch(),
        nonCertifying: true,
      }),
    ).rejects.toThrow(/\[model\].*ANTHROPIC_MODEL is not set/)
  })

  // ── (d) API key presence ───────────────────────────────────────────────────

  it("refuses when ANTHROPIC_API_KEY is missing", async () => {
    await expect(
      runPreflight({
        env: testEnv({ ANTHROPIC_API_KEY: undefined }),
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(/\[api-key\].*ANTHROPIC_API_KEY is missing or empty/)
  })

  it("refuses when ANTHROPIC_API_KEY is empty", async () => {
    await expect(
      runPreflight({
        env: testEnv({ ANTHROPIC_API_KEY: "" }),
        fetchImpl: okFetch(),
      }),
    ).rejects.toThrow(PreflightRefusalError)
  })

  it("NEVER leaks the API key value into checks, traces, or errors", async () => {
    // pass case
    const result = await runPreflight({ env: testEnv(), fetchImpl: okFetch() })
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY)
    expect(JSON.stringify(events)).not.toContain(SECRET_KEY)

    // refusal case (other checks failing must not echo the key either)
    events.length = 0
    const refusal = await runPreflight({
      env: testEnv({ ANTHROPIC_MODEL: "claude-haiku-4-5" }),
      fetchImpl: okFetch(),
    }).catch((err: unknown) => err as PreflightRefusalError)
    expect(refusal).toBeInstanceOf(PreflightRefusalError)
    expect((refusal as Error).message).not.toContain(SECRET_KEY)
    expect(JSON.stringify((refusal as PreflightRefusalError).checks)).not.toContain(SECRET_KEY)
    expect(JSON.stringify(events)).not.toContain(SECRET_KEY)
  })

  // ── Completeness: every check recorded even when several fail ─────────────

  it("runs and records ALL checks even when the first one already failed", async () => {
    const err = await runPreflight({
      env: testEnv({
        [TEST_FINGERPRINT_ENV]: undefined,
        ANTHROPIC_MODEL: "claude-haiku-4-5",
        ANTHROPIC_API_KEY: undefined,
        DATABASE_URL: "postgresql://app:pw@db.prod.ibatexas.com.br:5432/ibatexas",
      }),
      fetchImpl: okFetch(),
    }).catch((e: unknown) => e as PreflightRefusalError)

    expect(err).toBeInstanceOf(PreflightRefusalError)
    const refusal = err as PreflightRefusalError
    expect(refusal.checks).toHaveLength(4)
    expect(refusal.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "fingerprint",
      "hostnames",
      "model",
      "api-key",
    ])
    // the named error lists every failure
    for (const name of ["fingerprint", "hostnames", "model", "api-key"]) {
      expect(refusal.message).toContain(`[${name}]`)
    }
    // and the trace carries all four fail records
    expect(traceChecks().map((e) => e.outcome)).toEqual(["fail", "fail", "fail", "fail"])
  })
})
