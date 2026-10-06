import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "@ibatexas/catalog"
import type { CapabilityDefinition, ChatCapabilityDefinition } from "@ibatexas/catalog"

import {
  buildGuardResolutionMap,
  assertGuardRefsResolve,
  GuardRefResolutionError,
} from "../capability-definitions/index.js"

/** Narrow a `CapabilityDefinition` to its chat-tier variant, or fail the
 *  test loudly — every helper below expects a `guardRefs`-bearing def. */
function assertChatTier(def: CapabilityDefinition): ChatCapabilityDefinition {
  if (def.tier !== "chat") {
    throw new Error(`test fixture assumption violated: "${def.kind}" is tier:"${def.tier}", expected "chat"`)
  }
  return def
}

describe("capability-definitions — guard-ref boot assertion (FE-4.3)", () => {
  it("importing the module does not throw — the eager boot self-check passed", () => {
    // If `assertGuardRefsResolve` (called at module top-level in
    // `capability-definitions/index.ts`) had found a dangling guard-ref, this
    // file's header import of that module would already have thrown before
    // any test body ran. Reaching this line IS the passing assertion.
    expect(CAPABILITY_DEFINITIONS.length).toBeGreaterThan(0)
  })

  it("assertGuardRefsResolve passes explicitly against a fresh resolution map built from the live composed packs", () => {
    expect(() => assertGuardRefsResolve(CAPABILITY_DEFINITIONS, buildGuardResolutionMap())).not.toThrow()
  })

  it("every authored guard-ref resolves to a distinct live guard in its pack+phase", () => {
    const map = buildGuardResolutionMap()
    for (const def of CAPABILITY_DEFINITIONS) {
      // FE-T20: `guardRefs` exists ONLY on the chat-tier union member —
      // identity-tier defs have nothing to resolve, not a failure.
      if (def.tier !== "chat") continue
      for (const ref of def.guardRefs) {
        expect(map.has(`${def.pack}::${ref.phase}::${ref.name}`)).toBe(true)
      }
    }
  })

  it("FE-T20: identity-tier definitions carry no guardRefs property at all — valid-by-absence, not dangling", () => {
    const identityDefs = CAPABILITY_DEFINITIONS.filter((d) => d.tier === "identity")
    expect(identityDefs.length).toBeGreaterThan(0)
    for (const def of identityDefs) {
      // Structural, not just a value check: the discriminated union means
      // `guardRefs` is not a declared property on this variant at all —
      // `"guardRefs" in def` is the honest way to assert that at runtime
      // (a plain `.guardRefs` access wouldn't even compile here).
      expect("guardRefs" in def).toBe(false)
    }
    expect(() => assertGuardRefsResolve(identityDefs, buildGuardResolutionMap())).not.toThrow()
  })

  it("breaks: a renamed guard-ref fails the assertion (the negative direction the ticket requires)", () => {
    const broken: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def, i) =>
      i === 0
        ? {
            ...assertChatTier(def),
            guardRefs: [
              { phase: "business", name: "this_guard_name_does_not_exist_anywhere" },
              ...assertChatTier(def).guardRefs,
            ],
          }
        : def,
    )
    expect(() => assertGuardRefsResolve(broken, buildGuardResolutionMap())).toThrow(
      GuardRefResolutionError,
    )
    expect(() => assertGuardRefsResolve(broken, buildGuardResolutionMap())).toThrow(
      /Unresolved guard-ref/,
    )
  })

  it("breaks: a guard-ref moved to the wrong phase also fails (phase is part of the resolution key)", () => {
    // `executeCartOps` is a real, resolvable pack-orders guard — but only in
    // the "business" phase. Re-declaring it under "state" must fail, proving
    // resolution is keyed on (pack, phase, name), not just (pack, name).
    const ordersDef = CAPABILITY_DEFINITIONS.find((d) => d.kind === "order.cart.ensure")
    if (ordersDef === undefined) throw new Error("test fixture assumption violated: order.cart.ensure not found")
    const ordersChatDef = assertChatTier(ordersDef)
    expect(ordersChatDef.guardRefs.some((r) => r.name === "executeCartOps" && r.phase === "business")).toBe(true)

    const broken: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.cart.ensure"
        ? {
            ...assertChatTier(def),
            guardRefs: [{ phase: "state" as const, name: "executeCartOps" }, ...assertChatTier(def).guardRefs],
          }
        : def,
    )
    expect(() => assertGuardRefsResolve(broken, buildGuardResolutionMap())).toThrow(/Unresolved guard-ref/)
  })

  it("known gap: requireTenantBindingGuard is unresolvable today and is correctly absent from every authored guard-ref list", () => {
    const map = buildGuardResolutionMap()
    for (const def of CAPABILITY_DEFINITIONS) {
      expect(map.has(`${def.pack}::auth::requireTenantBindingGuard`)).toBe(false)
      if (def.tier !== "chat") continue
      expect(def.guardRefs.some((r) => r.name === "requireTenantBindingGuard")).toBe(false)
    }
  })
})
