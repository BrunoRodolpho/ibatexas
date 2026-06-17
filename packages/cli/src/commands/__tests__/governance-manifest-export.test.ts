// Tests for the governance artifact PRODUCERS (ERDS-055/056/057):
// AI-BOM, config-seal, and policy-coherence manifest builders.
//
// These exercise the PURE composition functions (no I/O, no CLI) against the
// live first-party packs, asserting:
//   1. determinism — same packs → byte-identical manifest (the property that
//      makes `--verify-file` meaningful),
//   2. reuse — the AI-BOM/seal digests match the same analyzers the
//      `ibx kernel pack-bom / seal` gates produce (no exporter/gate drift),
//   3. fail-closed roster drift surfaces as a throw.

import { describe, it, expect } from "vitest"
import {
  computeConfigDigest,
  extractSealableSurface,
} from "@adjudicate/conformance"
import { ordersPack } from "@ibatexas/pack-orders"
import { paymentsPack } from "@ibatexas/pack-payments"
import { reservationsPack } from "@ibatexas/pack-reservations"
import {
  buildAiBomManifest,
  buildConfigSealManifest,
  buildCoherenceManifest,
  type GovernancePackLike,
} from "../governance-manifest-export.js"

const PACKS = [
  ordersPack,
  paymentsPack,
  reservationsPack,
] as unknown as GovernancePackLike[]

describe("buildAiBomManifest", () => {
  it("is deterministic and excludes generatedAt from the serialized digest map", () => {
    const a = buildAiBomManifest({ packs: PACKS })
    const b = buildAiBomManifest({ packs: PACKS, generatedAt: "2030-01-01T00:00:00Z" })
    // generatedAt differs but the digest map + boms are identical.
    expect(a.digests).toEqual(b.digests)
    expect(a.boms).toEqual(b.boms)
  })

  it("sorts components by packId and stamps the shared kernel versions", () => {
    const m = buildAiBomManifest({ packs: PACKS })
    const ids = Object.keys(m.digests)
    expect([...ids]).toEqual([...ids].sort((x, y) => x.localeCompare(y)))
    expect(m.kernelMinVersion).toBe("1.0.0")
    expect(m.kernelVersion).toBe("1.3.0")
    expect(m.adopter).toBe("ibatexas")
    // Each bom is the reused @adjudicate/conformance AiBom shape.
    for (const bom of m.boms) {
      expect(bom.bomDigest).toMatch(/^[0-9a-f]{64}$/)
      expect("generatedAt" in bom).toBe(false)
    }
  })

  it("throws fail-closed when the agent roster drifts", () => {
    expect(() =>
      buildAiBomManifest({
        packs: PACKS,
        agents: {
          AGENT_REGISTRY: [],
          agentRosterDrift: () => [
            { agentId: "x", code: "MISSING", detail: "boom" },
          ],
          generateAgentAiBom: () => {
            throw new Error("unreachable")
          },
        },
      }),
    ).toThrow(/agent-roster drift/)
  })
})

describe("buildConfigSealManifest", () => {
  it("reuses computeConfigDigest(extractSealableSurface()) — same digest as ibx kernel seal", () => {
    const m = buildConfigSealManifest({ packs: PACKS })
    const expected = computeConfigDigest(
      extractSealableSurface(ordersPack as never),
    )
    expect(m.digests[ordersPack.id]).toBe(expected)
  })

  it("is deterministic and sorted", () => {
    const a = buildConfigSealManifest({ packs: PACKS })
    const b = buildConfigSealManifest({ packs: PACKS })
    expect(a).toEqual(b)
    const ids = a.seals.map((s) => s.packId)
    expect([...ids]).toEqual([...ids].sort((x, y) => x.localeCompare(y)))
  })
})

describe("buildCoherenceManifest", () => {
  it("elides analyzedAt and aggregates Tier-1 totals deterministically", () => {
    const a = buildCoherenceManifest({ packs: PACKS })
    const b = buildCoherenceManifest({ packs: PACKS })
    expect(a).toEqual(b)
    // analyzedAt (render-only wall clock) must not leak into the artifact.
    expect(JSON.stringify(a)).not.toContain("analyzedAt")
    const sum =
      a.totals.error + a.totals.warning + a.totals.note
    const perPack = a.packs.reduce(
      (n, p) => n + p.summary.error + p.summary.warning + p.summary.note,
      0,
    )
    expect(sum).toBe(perPack)
    expect(a.passed).toBe(a.totals.error === 0)
  })
})
