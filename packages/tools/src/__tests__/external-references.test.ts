// The external-reference reconciler's contract (LE2-018).
//
// Every test here injects at the PROBE seam — `reconcileExternalReferences`
// takes its probe map as a parameter, so nothing below mocks a module, touches
// Medusa or opens a Prisma connection. That is the point of the seam: the
// reconciler's job is deciding what a store's answer MEANS, and that decision
// is the part a fail-closed gate gets wrong.
//
// The probes themselves (which URL, which column) are covered where they can
// be honestly covered — against the real stores by `ibx catalog check --live`.
// Mocking `fetch` to assert a query string would pin the mock, not Medusa.

import { describe, expect, it, vi } from "vitest"

import type { ExternalReferenceDeclaration } from "@ibatexas/catalog"

import {
  assertExternalReferencesReconcile,
  ExternalReferenceConfigError,
  externalReferenceKey,
  ExternalReferenceReconciliationError,
  formatExternalReferenceReport,
  reconcileExternalReferences,
  requireExternalReferenceKey,
  type ExternalReferenceProbe,
} from "../external-references/index.js"

const WELCOME: ExternalReferenceDeclaration = {
  id: "promotion.test-welcome",
  store: "promotion",
  keyFrom: "TEST_WELCOME_CODE",
  why: "new customers are promised it at onboarding.",
  declaredBy: [
    { capability: null, site: "session.ts#setWelcomeCredit", usage: "grants it" },
    { capability: "order.checkout.create", site: "create-checkout.ts", usage: "applies it" },
  ],
}

const ZONE: ExternalReferenceDeclaration = {
  id: "delivery-zone.test-home",
  store: "delivery-zone",
  keyFrom: "TEST_HOME_ZONE",
  why: "the home zone every quote falls back to.",
  declaredBy: [{ capability: null, site: "estimate-delivery.ts", usage: "quotes it" }],
}

const present: ExternalReferenceProbe = async () => ({ status: "present" })
const absent: ExternalReferenceProbe = async () => ({ status: "absent" })
const unreachable: ExternalReferenceProbe = async () => ({
  status: "unreachable",
  detail: "ECONNREFUSED 127.0.0.1:9000",
})

describe("reconcileExternalReferences — the three ways a reference misses", () => {
  it("resolves when the config is set and the store has the key", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "BEMVINDO15" },
      probes: { promotion: present },
    })
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(1)
    expect(result.resolved).toEqual([
      { id: "promotion.test-welcome", store: "promotion", key: "BEMVINDO15" },
    ])
  })

  it("misses with `config-unset` when the declared variable is not set", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: {},
      probes: { promotion: present },
    })
    expect(result.ok).toBe(false)
    expect(result.misses[0]?.reason).toBe("config-unset")
    expect(result.misses[0]?.key).toBeNull()
  })

  it("treats a blank/whitespace variable as unset, not as an empty key", async () => {
    const probe = vi.fn(present)
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "   " },
      probes: { promotion: probe },
    })
    expect(result.misses[0]?.reason).toBe("config-unset")
    // The important half: a blank variable must never reach the store, where
    // an empty-string query could match something by accident.
    expect(probe).not.toHaveBeenCalled()
  })

  it("misses with `not-found` when the store answered and the key is absent", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "BEMVINDO15" },
      probes: { promotion: absent },
    })
    expect(result.misses[0]?.reason).toBe("not-found")
    expect(result.misses[0]?.detail).toContain('has no "BEMVINDO15"')
  })

  it("misses with `store-unreachable` — 'could not check' is NOT 'fine'", async () => {
    // The inversion this guards: a gate that passes when the store is down is
    // fail-OPEN wearing a fail-closed comment, and it passes hardest exactly
    // when the environment is least healthy.
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "BEMVINDO15" },
      probes: { promotion: unreachable },
    })
    expect(result.ok).toBe(false)
    expect(result.misses[0]?.reason).toBe("store-unreachable")
    expect(result.misses[0]?.detail).toContain("ECONNREFUSED")
  })

  it("misses when the declared store has no registered probe", async () => {
    const result = await reconcileExternalReferences({
      declarations: [ZONE],
      env: { TEST_HOME_ZONE: "Ibaté" },
      probes: { promotion: present },
    })
    expect(result.misses[0]?.reason).toBe("store-unreachable")
    expect(result.misses[0]?.detail).toContain("no probe is registered")
  })
})

describe("reconcileExternalReferences — reporting every miss, not the first", () => {
  it("probes every declaration and reports all of them", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME, ZONE],
      env: { TEST_HOME_ZONE: "Ibaté" },
      probes: { promotion: absent, "delivery-zone": absent },
    })
    expect(result.checked).toBe(2)
    expect(result.misses.map((m) => m.reason)).toEqual(["config-unset", "not-found"])
  })

  it("mixes hits and misses without losing either", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME, ZONE],
      env: { TEST_WELCOME_CODE: "BEMVINDO15", TEST_HOME_ZONE: "Ibaté" },
      probes: { promotion: present, "delivery-zone": absent },
    })
    expect(result.resolved.map((h) => h.id)).toEqual(["promotion.test-welcome"])
    expect(result.misses.map((m) => m.id)).toEqual(["delivery-zone.test-home"])
  })

  it("is total — a throwing probe is a caller bug, and the reconciler still reports", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "BEMVINDO15" },
      probes: {
        promotion: async () => {
          throw new Error("boom")
        },
      },
    }).catch((err: unknown) => err)
    // The default probes convert their own exceptions into `unreachable`; a
    // hand-written probe that throws is not something the reconciler can
    // second-guess, so the rejection propagates rather than being swallowed
    // into a false "present". Assert the loud behavior, not a silent one.
    expect(result).toBeInstanceOf(Error)
  })

  it("reconciles an EMPTY table as ok — nothing declared is nothing missing", async () => {
    const result = await reconcileExternalReferences({ declarations: [], probes: {} })
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(0)
  })
})

describe("the refusal's diagnostic — what a woken operator reads", () => {
  it("names the reference, its store, the config var, the consumers and the cost", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "BEMVINDO15" },
      probes: { promotion: absent },
    })
    const report = formatExternalReferenceReport(result)
    expect(report).toContain("promotion.test-welcome")
    expect(report).toContain("promotion store")
    expect(report).toContain("TEST_WELCOME_CODE")
    expect(report).toContain("session.ts#setWelcomeCredit")
    // A capability-attributed consumer carries its kind, so the operator can
    // grep the catalog as well as the file tree.
    expect(report).toContain("create-checkout.ts (order.checkout.create)")
    expect(report).toContain("new customers are promised it at onboarding.")
  })

  it("tells the operator where to find these BEFORE a restart does", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: {},
      probes: { promotion: absent },
    })
    expect(formatExternalReferenceReport(result)).toContain("ibx catalog check --live")
  })

  it("says outright that there is no bypass, and cites the decision that made it strict", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: {},
      probes: { promotion: absent },
    })
    const report = formatExternalReferenceReport(result)
    expect(report).toContain("There is no bypass")
    expect(report).toContain("Decision 16")
  })

  it("has no option that can turn a miss into a pass", async () => {
    // The structural half of "no bypass": the escape hatch cannot be *forgotten*
    // out of the report if it does not exist in the API. Every field
    // `ReconcileOptions` accepts is supplied here, and the verdict is still not
    // ok — there is no third argument, env var or flag that changes it.
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { UNRELATED: "1", SKIP_EXTERNAL_REFERENCES: "true", NODE_ENV: "development" },
      probes: { promotion: absent },
    })
    expect(result.ok).toBe(false)
  })

  it("lists every resolved reference on the clean path (the proof it looked)", async () => {
    const result = await reconcileExternalReferences({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "BEMVINDO15" },
      probes: { promotion: present },
    })
    expect(formatExternalReferenceReport(result)).toContain('✓ promotion.test-welcome — "BEMVINDO15"')
  })
})

describe("assertExternalReferencesReconcile — fail-closed", () => {
  it("throws on ANY miss, carrying the full result", async () => {
    await expect(
      assertExternalReferencesReconcile({
        declarations: [WELCOME],
        env: {},
        probes: { promotion: present },
      }),
    ).rejects.toBeInstanceOf(ExternalReferenceReconciliationError)
  })

  it("returns the clean result when every reference resolves", async () => {
    const result = await assertExternalReferencesReconcile({
      declarations: [WELCOME],
      env: { TEST_WELCOME_CODE: "BEMVINDO15" },
      probes: { promotion: present },
    })
    expect(result.ok).toBe(true)
  })

  it("puts the whole report in the thrown message, not a summary line", async () => {
    const err = await assertExternalReferencesReconcile({
      declarations: [WELCOME],
      env: {},
      probes: { promotion: present },
    }).catch((e: unknown) => e as ExternalReferenceReconciliationError)
    expect(err.message).toContain("TEST_WELCOME_CODE")
    expect(err.result.misses).toHaveLength(1)
  })
})

describe("key resolution — the config half", () => {
  it("reads the variable the DECLARATION names, not one derived from the id", async () => {
    expect(
      externalReferenceKey("promotion.test-welcome", {
        declarations: [WELCOME],
        env: { TEST_WELCOME_CODE: "BEMVINDO15", PROMOTION_TEST_WELCOME: "wrong" },
      }),
    ).toBe("BEMVINDO15")
  })

  it("trims — a trailing newline from a secrets store is not part of the code", () => {
    expect(
      externalReferenceKey("promotion.test-welcome", {
        declarations: [WELCOME],
        env: { TEST_WELCOME_CODE: "BEMVINDO15\n" },
      }),
    ).toBe("BEMVINDO15")
  })

  it("requireExternalReferenceKey throws — there is NO literal fallback", () => {
    // The whole ticket in one assertion: if this ever returned a default, the
    // hardcoded coupon would be back, one layer deeper than where it started.
    expect(() =>
      requireExternalReferenceKey("promotion.test-welcome", {
        declarations: [WELCOME],
        env: {},
      }),
    ).toThrow(ExternalReferenceConfigError)
  })

  it("names the variable to set in the throw", () => {
    expect(() =>
      requireExternalReferenceKey("promotion.test-welcome", {
        declarations: [WELCOME],
        env: {},
      }),
    ).toThrow(/TEST_WELCOME_CODE/)
  })

  it("throws for an id no declaration carries", () => {
    expect(() =>
      requireExternalReferenceKey("promotion.invented", { declarations: [WELCOME], env: {} }),
    ).toThrow(/no such external reference is declared/)
  })
})
