// Tests for rk() — the centralized Redis key factory.
//
// FE-D26 regression: rk() used to prefix keys with a module-level ENV_PREFIX
// captured from process.env.APP_ENV AT IMPORT TIME. Out-of-process tooling
// (the CLI's loadTestEnv) sets APP_ENV AFTER @ibatexas/tools is transitively
// evaluated, so the capture froze the stale `development` default — the CLI
// wrote `development:`-prefixed keys while the api read `test:`-prefixed ones
// (invisible seeded carts + a phantom token-budget reset). The read is now
// lazy (call time), so a post-import APP_ENV change is honored.

import { afterEach, describe, expect, it } from "vitest"
import { rk } from "../key.js"

describe("rk() — APP_ENV read at call time (FE-D26)", () => {
  const original = process.env.APP_ENV

  afterEach(() => {
    if (original === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = original
  })

  it("prefixes keys with the current APP_ENV value", () => {
    process.env.APP_ENV = "test"
    expect(rk("customer:profile:c1")).toBe("test:customer:profile:c1")
  })

  it("honors a post-import APP_ENV change on the very next call (lazy, not frozen)", () => {
    // The module was imported once at the top of this file. A module-level
    // capture would freeze whatever APP_ENV was at that moment; a lazy read
    // reflects each subsequent change.
    process.env.APP_ENV = "development"
    expect(rk("k")).toBe("development:k")

    process.env.APP_ENV = "test"
    expect(rk("k")).toBe("test:k")

    process.env.APP_ENV = "staging"
    expect(rk("k")).toBe("staging:k")
  })

  it("defaults to 'development' when APP_ENV is unset", () => {
    delete process.env.APP_ENV
    expect(rk("k")).toBe("development:k")
  })
})
