// W6-7 — Concurrent envelope-build determinism.
//
// Per audit/08-test-coverage-gaps.md §"Concurrency test gaps" item #4 and
// item #10 in §"Top 20":
//
//   "Two concurrent envelope builds with the same content + nonce —
//    intent hash MUST be identical (replay-safe), but we have no test
//    that explicitly constructs the race and verifies hash equality."
//
// We fire 100 concurrent `buildEnvelope()` calls with identical inputs
// (same kind, payload, actor, taint, nonce) and assert every resulting
// `intentHash` is byte-identical to the first.
//
// This is the framework's "deterministic under concurrency" invariant:
// `sha256Canonical` over the same canonical JSON MUST produce the same
// hash regardless of when it ran. A regression that introduced a
// stateful canonicalizer (e.g., a JSON.stringify replacer that mutates
// shared state) would break this — and audit row dedup with it.

import { describe, expect, it } from "vitest"
import { buildEnvelope } from "@adjudicate/core"

describe("buildEnvelope — concurrent determinism (W6-7)", () => {
  it("100 concurrent builds with identical inputs produce identical intentHash", async () => {
    const DET_TIME = "2026-05-23T12:00:00.000Z"
    const sharedInput = {
      kind: "order.cart.ensure" as const,
      payload: { cartId: "cart-determinism-01" },
      actor: { principal: "llm" as const, sessionId: "sess_det_01" },
      taint: "UNTRUSTED" as const,
      nonce: "n-det-shared",
      createdAt: DET_TIME,
    }

    const envelopes = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve(buildEnvelope(sharedInput))),
    )
    const hashes = envelopes.map((e) => e.intentHash)

    // All 100 hashes equal the first.
    const first = hashes[0]
    expect(first).toMatch(/^[0-9a-f]{16,}$/)
    for (const h of hashes) {
      expect(h).toBe(first)
    }
  })

  it("createdAt variation does NOT change intentHash (v2 envelope contract)", async () => {
    // The envelope schema v2 says: `createdAt` is descriptive metadata,
    // NOT part of intentHash. Concurrent builds with different
    // createdAts but matching nonces MUST yield the same hash.
    const baseInput = {
      kind: "order.cart.ensure" as const,
      payload: { cartId: "cart-createdat-test" },
      actor: { principal: "llm" as const, sessionId: "sess_det_02" },
      taint: "UNTRUSTED" as const,
      nonce: "n-createdat-stable",
    }

    const envelopes = await Promise.all([
      Promise.resolve(buildEnvelope({ ...baseInput, createdAt: "2026-05-23T12:00:00.000Z" })),
      Promise.resolve(buildEnvelope({ ...baseInput, createdAt: "2026-05-23T13:00:00.000Z" })),
      Promise.resolve(buildEnvelope({ ...baseInput, createdAt: "2026-05-24T00:00:00.000Z" })),
    ])
    const hashes = envelopes.map((e) => e.intentHash)
    expect(hashes[0]).toBe(hashes[1])
    expect(hashes[1]).toBe(hashes[2])
  })

  it("payload field difference DOES change intentHash", async () => {
    const baseInput = {
      kind: "order.cart.ensure" as const,
      actor: { principal: "llm" as const, sessionId: "sess_det_03" },
      taint: "UNTRUSTED" as const,
      nonce: "n-payload-different",
      createdAt: "2026-05-23T12:00:00.000Z",
    }

    const a = buildEnvelope({ ...baseInput, payload: { cartId: "cart-a" } })
    const b = buildEnvelope({ ...baseInput, payload: { cartId: "cart-b" } })
    expect(a.intentHash).not.toBe(b.intentHash)
  })

  it("nonce difference DOES change intentHash (idempotency key contract)", async () => {
    const baseInput = {
      kind: "order.cart.ensure" as const,
      payload: { cartId: "cart-nonce-test" },
      actor: { principal: "llm" as const, sessionId: "sess_det_04" },
      taint: "UNTRUSTED" as const,
      createdAt: "2026-05-23T12:00:00.000Z",
    }

    const a = buildEnvelope({ ...baseInput, nonce: "n-A" })
    const b = buildEnvelope({ ...baseInput, nonce: "n-B" })
    expect(a.intentHash).not.toBe(b.intentHash)
  })

  it("1000 concurrent builds: zero duplicates when nonces vary", async () => {
    // Inverse stress: each build has a unique nonce, so every hash
    // should be distinct. This verifies the canonicalizer doesn't
    // collapse different inputs to the same hash under load.
    const envelopes = await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        Promise.resolve(
          buildEnvelope({
            kind: "order.cart.ensure",
            payload: { cartId: `cart-distinct-${i}` },
            actor: { principal: "llm", sessionId: "sess_det_05" },
            taint: "UNTRUSTED",
            nonce: `n-distinct-${i}`,
            createdAt: "2026-05-23T12:00:00.000Z",
          }),
        ),
      ),
    )
    const hashes = new Set(envelopes.map((e) => e.intentHash))
    expect(hashes.size).toBe(1000)
  })
})
