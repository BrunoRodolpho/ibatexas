import { describe, expect, it } from "vitest"

import {
  CAPABILITY_DEFINITIONS,
  buildGuardResolutionMap,
  assertGuardRefsResolve,
  GuardRefResolutionError,
} from "../capability-definitions/index.js"
import type { CapabilityDefinition } from "../capability-definitions/index.js"

describe("capability-definitions — guard-ref boot assertion (FE-4.3)", () => {
  it("importing the module does not throw — the eager boot self-check passed", () => {
    // If `assertGuardRefsResolve` (called at module top-level in
    // `capability-definitions/index.ts`) had found a dangling guard-ref, the
    // import in this file's header would already have thrown before any
    // test body ran. Reaching this line IS the passing assertion.
    expect(CAPABILITY_DEFINITIONS.length).toBeGreaterThan(0)
  })

  it("assertGuardRefsResolve passes explicitly against a fresh resolution map built from the live composed packs", () => {
    expect(() => assertGuardRefsResolve(CAPABILITY_DEFINITIONS, buildGuardResolutionMap())).not.toThrow()
  })

  it("every authored guard-ref resolves to a distinct live guard in its pack+phase", () => {
    const map = buildGuardResolutionMap()
    for (const def of CAPABILITY_DEFINITIONS) {
      for (const ref of def.guardRefs) {
        expect(map.has(`${def.pack}::${ref.phase}::${ref.name}`)).toBe(true)
      }
    }
  })

  it("breaks: a renamed guard-ref fails the assertion (the negative direction the ticket requires)", () => {
    const broken: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def, i) =>
      i === 0
        ? {
            ...def,
            guardRefs: [
              { phase: "business", name: "this_guard_name_does_not_exist_anywhere" },
              ...def.guardRefs,
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
    expect(ordersDef.guardRefs.some((r) => r.name === "executeCartOps" && r.phase === "business")).toBe(true)

    const broken: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS.map((def) =>
      def.kind === "order.cart.ensure"
        ? { ...def, guardRefs: [{ phase: "state" as const, name: "executeCartOps" }, ...def.guardRefs] }
        : def,
    )
    expect(() => assertGuardRefsResolve(broken, buildGuardResolutionMap())).toThrow(/Unresolved guard-ref/)
  })

  it("known gap: requireTenantBindingGuard is unresolvable today and is correctly absent from every authored guard-ref list", () => {
    const map = buildGuardResolutionMap()
    for (const def of CAPABILITY_DEFINITIONS) {
      expect(map.has(`${def.pack}::auth::requireTenantBindingGuard`)).toBe(false)
      expect(def.guardRefs.some((r) => r.name === "requireTenantBindingGuard")).toBe(false)
    }
  })
})
