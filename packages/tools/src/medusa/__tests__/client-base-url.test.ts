// Tests for medusaBaseUrl() — the Medusa API base-URL resolver.
//
// FE-D26 regression: the client used to capture MEDUSA_URL into a module-level
// const AT IMPORT TIME. The CLI's runJourneyExtractionAccuracy dynamic-imports
// @ibatexas/journeys, whose barrel transitively evaluates @ibatexas/tools
// BEFORE the CLI's loadTestEnv() runs — so the const froze dev's :9000 default
// and every journeys+Medusa command silently targeted the WRONG stack (a
// cart-seeder 401 traced to real admin logins against DEV's commerce). The read
// is now lazy (call time), so a post-import MEDUSA_URL change is honored.

import { afterEach, describe, expect, it } from "vitest"
import { medusaBaseUrl } from "../client.js"

describe("medusaBaseUrl() — MEDUSA_URL read at call time (FE-D26)", () => {
  const original = process.env.MEDUSA_URL

  afterEach(() => {
    if (original === undefined) delete process.env.MEDUSA_URL
    else process.env.MEDUSA_URL = original
  })

  it("returns the current MEDUSA_URL", () => {
    process.env.MEDUSA_URL = "http://localhost:9013"
    expect(medusaBaseUrl()).toBe("http://localhost:9013")
  })

  it("honors a post-import MEDUSA_URL change (lazy, not frozen to the import-time value)", () => {
    // Module imported once at the top of this file; a module-level capture
    // would freeze the first value. A lazy read reflects each change.
    process.env.MEDUSA_URL = "http://localhost:9000"
    expect(medusaBaseUrl()).toBe("http://localhost:9000")

    process.env.MEDUSA_URL = "http://localhost:9013"
    expect(medusaBaseUrl()).toBe("http://localhost:9013")
  })

  it("defaults to http://localhost:9000 when MEDUSA_URL is unset", () => {
    delete process.env.MEDUSA_URL
    expect(medusaBaseUrl()).toBe("http://localhost:9000")
  })
})
