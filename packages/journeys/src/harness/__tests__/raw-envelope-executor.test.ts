// Tests for the raw-envelope act executor (BKL-044) — mocked HTTP.
//
// The executor POSTs a raw, caller-controlled envelope to the test-plane
// forged-envelope ingress (POST /api/test/envelope-ingress) and passes iff
// the ingress status equals the act's expectStatus (default 400 — the forgery
// rejection). It NEVER loosens the ingress guard; these tests pin the request
// shape and the pass/fail contract with a stubbed fetch.
import { describe, it, expect } from "vitest"

import type { JourneyRunContext } from "../../runner/run-journey.js"
import type { RawEnvelopeAct } from "../../schema/index.js"
import {
  createRawEnvelopeExecutor,
  TEST_ENVELOPE_INGRESS_PATH,
  type RawEnvelopeFetch,
} from "../run-journey-cli.js"

type Call = {
  url: string
  init: { method: string; headers: Record<string, string>; body: string }
}

function stubFetch(
  status: number,
  body = `{"error":"Requisição inválida.","code":"forgery_attempt"}`,
): { fetchImpl: RawEnvelopeFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: RawEnvelopeFetch = async (url, init) => {
    calls.push({ url, init })
    return { status, text: async () => body }
  }
  return { fetchImpl, calls }
}

const API = "http://localhost:3001"

function ctx(vars: Record<string, unknown> = {}): JourneyRunContext {
  return { journeyId: "JOURNEY-008", runId: "run-test", vars, params: {} }
}

function forgedAct(over: Partial<RawEnvelopeAct> = {}): RawEnvelopeAct {
  return {
    kind: "raw-envelope",
    name: "forged-actor-probe",
    envelope: {
      kind: "order.cancel",
      payload: { orderId: "forged-order-target" },
      actor: { principal: "system", sessionId: "forged:system" },
      taint: "TRUSTED",
    },
    ...over,
  }
}

describe("createRawEnvelopeExecutor", () => {
  it("POSTs { envelope } verbatim to the test-plane ingress (forged actor/taint reach the guard)", async () => {
    const { fetchImpl, calls } = stubFetch(400)
    const exec = createRawEnvelopeExecutor({ apiBaseUrl: API, onProgress: () => {}, fetchImpl })

    const result = await exec(forgedAct(), ctx())

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${API}${TEST_ENVELOPE_INGRESS_PATH}`)
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.headers["content-type"]).toBe("application/json")
    const sent = JSON.parse(calls[0].init.body) as {
      envelope: { actor: { principal: string }; taint: string }
    }
    expect(sent.envelope.actor.principal).toBe("system")
    expect(sent.envelope.taint).toBe("TRUSTED")
    expect(result).toMatchObject({ ok: true })
  })

  it("defaults expectStatus to 400 — passes on the forgery rejection, fails on a 2xx", async () => {
    const rejected = createRawEnvelopeExecutor({
      apiBaseUrl: API,
      onProgress: () => {},
      fetchImpl: stubFetch(400).fetchImpl,
    })
    expect(await rejected(forgedAct(), ctx())).toMatchObject({ ok: true })

    // A 200 (envelope somehow accepted) is a FAILURE for a forgery probe —
    // the default is the forgery-rejection status, not a 2xx pass.
    const accepted = createRawEnvelopeExecutor({
      apiBaseUrl: API,
      onProgress: () => {},
      fetchImpl: stubFetch(200, "{}").fetchImpl,
    })
    expect(await accepted(forgedAct(), ctx())).toMatchObject({ ok: false })
  })

  it("honors a declared expectStatus", async () => {
    const exec = createRawEnvelopeExecutor({
      apiBaseUrl: API,
      onProgress: () => {},
      fetchImpl: stubFetch(422, "{}").fetchImpl,
    })
    expect(await exec(forgedAct({ expectStatus: 422 }), ctx())).toMatchObject({ ok: true })
  })

  it("resolves :name envelope leaves from ctx.vars (the http-body convention)", async () => {
    const { fetchImpl, calls } = stubFetch(400)
    const exec = createRawEnvelopeExecutor({ apiBaseUrl: API, onProgress: () => {}, fetchImpl })
    const act = forgedAct({
      envelope: {
        kind: "order.cancel",
        payload: { orderId: ":orderId" },
        actor: { principal: "system", sessionId: "forged:system" },
        taint: "TRUSTED",
      },
    })

    await exec(act, ctx({ orderId: "ord-real-123" }))

    const sent = JSON.parse(calls[0].init.body) as {
      envelope: { payload: { orderId: string } }
    }
    expect(sent.envelope.payload.orderId).toBe("ord-real-123")
  })
})
