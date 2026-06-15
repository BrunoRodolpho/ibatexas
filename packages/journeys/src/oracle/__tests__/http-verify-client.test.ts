// Tests for oracle/http-verify-client.ts — the GET-only containment guard.
//
// The @ts-expect-error blocks are the TYPE-LEVEL half of the guarantee: they
// fail `tsc --noEmit` (the package lint) if the surface ever grows a method
// escape hatch. The runtime assertions are the other half: a forged init
// (cast / plain-JS caller) never reaches fetch.
import { describe, it, expect } from "vitest"

import {
  createHttpVerifyClient,
  HttpVerifyMethodError,
  HttpVerifyOriginError,
  type HttpVerifyFetch,
  type HttpVerifyGetInit,
} from "../http-verify-client.js"

function stubFetch(
  body = `{"status":"ok","testFingerprint":"ibx-test-abc"}`,
  status = 200,
): { fetchImpl: HttpVerifyFetch; calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = []
  const fetchImpl: HttpVerifyFetch = async (url, init) => {
    calls.push({ url, init })
    return {
      status,
      headers: {
        forEach(callback: (value: string, key: string) => void) {
          callback("application/json", "Content-Type")
        },
      },
      text: async () => body,
    }
  }
  return { fetchImpl, calls }
}

describe("createHttpVerifyClient — GET path", () => {
  it("GETs a path resolved against baseUrl with hardcoded method GET", async () => {
    const { fetchImpl, calls } = stubFetch()
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })

    const response = await client.get("/health")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://localhost:3001/health")
    expect((calls[0]?.init as { method: string }).method).toBe("GET")
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.headers["content-type"]).toBe("application/json")
    expect(response.json()).toEqual({ status: "ok", testFingerprint: "ibx-test-abc" })
  })

  it("merges default headers with per-request headers (request wins)", async () => {
    const { fetchImpl, calls } = stubFetch()
    const client = createHttpVerifyClient({
      baseUrl: "http://localhost:3001",
      fetchImpl,
      defaultHeaders: { accept: "application/json", "x-base": "1" },
    })

    await client.get("/health", { headers: { accept: "text/plain" } })

    expect((calls[0]?.init as { headers: Record<string, string> }).headers).toEqual({
      accept: "text/plain",
      "x-base": "1",
    })
  })

  it("json() throws a descriptive error on a non-JSON body", async () => {
    const { fetchImpl } = stubFetch("plain text", 200)
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })

    const response = await client.get("/health")
    expect(() => response.json()).toThrow(/not valid JSON/)
  })

  it("flags non-2xx statuses as ok=false without throwing", async () => {
    const { fetchImpl } = stubFetch(`{"error":"degraded"}`, 503)
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })

    const response = await client.get("/health")
    expect(response.ok).toBe(false)
    expect(response.status).toBe(503)
  })
})

describe("createHttpVerifyClient — runtime GET-only guard", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH", "post", "HEAD", "OPTIONS"])(
    "throws HttpVerifyMethodError before fetching when init smuggles method %s",
    async (method) => {
      const { fetchImpl, calls } = stubFetch()
      const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })
      const forged = { method } as unknown as HttpVerifyGetInit

      await expect(client.get("/health", forged)).rejects.toBeInstanceOf(HttpVerifyMethodError)
      expect(calls).toHaveLength(0)
    },
  )

  it("tolerates a smuggled redundant method GET (still GET — not a violation)", async () => {
    const { fetchImpl, calls } = stubFetch()
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })
    const forged = { method: "GET" } as unknown as HttpVerifyGetInit

    await client.get("/health", forged)
    expect(calls).toHaveLength(1)
    expect((calls[0]?.init as { method: string }).method).toBe("GET")
  })

  it("throws HttpVerifyMethodError before fetching when init smuggles a body", async () => {
    const { fetchImpl, calls } = stubFetch()
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })
    const forged = { body: `{"mutate":true}` } as unknown as HttpVerifyGetInit

    await expect(client.get("/health", forged)).rejects.toBeInstanceOf(HttpVerifyMethodError)
    expect(calls).toHaveLength(0)
  })

  it("exposes no write-verb members at runtime (plain-JS callers find nothing to call)", () => {
    const { fetchImpl } = stubFetch()
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })
    const surface = client as unknown as Record<string, unknown>

    for (const verb of ["post", "put", "delete", "patch", "request", "fetch"]) {
      expect(surface[verb]).toBeUndefined()
    }
    expect(Object.keys(client).sort()).toEqual(["baseUrl", "get"])
  })
})

describe("createHttpVerifyClient — origin pinning", () => {
  it("refuses an absolute URL on a different origin", async () => {
    const { fetchImpl, calls } = stubFetch()
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })

    await expect(client.get("http://localhost:9000/health")).rejects.toBeInstanceOf(
      HttpVerifyOriginError,
    )
    expect(calls).toHaveLength(0)
  })

  it("accepts an absolute URL on the pinned origin", async () => {
    const { fetchImpl, calls } = stubFetch()
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })

    await client.get("http://localhost:3001/health?depth=full")
    expect(calls[0]?.url).toBe("http://localhost:3001/health?depth=full")
  })

  it("rejects an invalid baseUrl at construction", () => {
    const { fetchImpl } = stubFetch()
    expect(() => createHttpVerifyClient({ baseUrl: "not a url", fetchImpl })).toThrow(
      HttpVerifyOriginError,
    )
  })
})

describe("createHttpVerifyClient — type-level GET-only guarantee", () => {
  it("rejects non-GET surfaces at compile time (pinned by @ts-expect-error)", () => {
    const { fetchImpl } = stubFetch()
    const client = createHttpVerifyClient({ baseUrl: "http://localhost:3001", fetchImpl })

    // @ts-expect-error — the client has no `post` member.
    const post = client.post
    // @ts-expect-error — the client has no `put` member.
    const put = client.put
    // @ts-expect-error — the client has no `delete` member.
    const del = client.delete
    // @ts-expect-error — the client has no `patch` member.
    const patch = client.patch
    expect([post, put, del, patch]).toEqual([undefined, undefined, undefined, undefined])

    const initWithMethod: HttpVerifyGetInit = {
      // @ts-expect-error — HttpVerifyGetInit has no `method` member.
      method: "POST",
    }
    const initWithBody: HttpVerifyGetInit = {
      // @ts-expect-error — HttpVerifyGetInit has no `body` member.
      body: "{}",
    }
    expect(initWithMethod).toBeDefined()
    expect(initWithBody).toBeDefined()
  })
})
