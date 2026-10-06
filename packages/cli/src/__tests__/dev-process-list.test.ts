// BKL-266 — the dev-stack's DEFAULT process set, and specifically the
// membership of `observability` in it, had ZERO test coverage. That matters
// because VictoriaLogs is the only record of a zero-call funnel turn
// (L0/L1/L2-fallback/ALIAS write no turn_trace row by design), so silently
// dropping the obs one-shot from the default loses that evidence permanently —
// never-written, not late. These tests pin the property that was unpinned, plus
// the new dedicated opt-out.
//
// Scope note: this asserts the RESOLVED PROCESS LIST only — what `ibx dev` hands
// process-compose. It does not start anything and says nothing about whether the
// containers then come up (docker-compose.observability.yml's healthcheck and
// restart policy own that).

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { parse } from "yaml"
import {
  resolveProcessList,
  CORE_PROCESSES,
  OPTIONAL_PROCESSES,
} from "../commands/dev.js"
import { ROOT } from "../utils/root.js"

/** Options as commander materializes them for a bare `ibx dev` — note
 *  `observability: true`, which is what `--no-observability` flips to false. */
const DEFAULT_OPTS = { tui: true, observability: true }

describe("resolveProcessList — default membership", () => {
  it("includes `observability` in the DEFAULT set (bare `ibx dev`)", () => {
    expect(resolveProcessList([], DEFAULT_OPTS, undefined)).toContain("observability")
  })

  it("includes `observability` when only optional extras are requested", () => {
    const withExtras = resolveProcessList(
      [],
      { ...DEFAULT_OPTS, withTunnel: true, withStripe: true },
      undefined,
    )
    expect(withExtras).toContain("observability")
    expect(withExtras).toContain("tunnel")
    expect(withExtras).toContain("stripe")
  })

  it("`all` starts everything — an empty filter, which process-compose reads as no filter", () => {
    expect(resolveProcessList(["all"], DEFAULT_OPTS, undefined)).toEqual([])
  })
})

describe("resolveProcessList — the --no-observability opt-out", () => {
  it("drops `observability` from the default set", () => {
    const opted = resolveProcessList([], { ...DEFAULT_OPTS, observability: false }, undefined)
    expect(opted).not.toContain("observability")
  })

  it("drops ONLY `observability` — infra and every app process survive", () => {
    const kept = resolveProcessList([], DEFAULT_OPTS, undefined)
    const opted = resolveProcessList([], { ...DEFAULT_OPTS, observability: false }, undefined)
    expect(opted).toEqual(kept.filter((p) => p !== "observability"))
    expect(opted).toContain("infra")
    expect(opted).toContain("api")
  })

  it("materializes the `all` set so the opt-out is not swallowed by the empty filter", () => {
    // The bug this guards: `all` normally resolves to [] (= start everything),
    // and "everything except observability" cannot be expressed as an empty
    // filter — so the opt-out would silently do nothing.
    const opted = resolveProcessList(["all"], { ...DEFAULT_OPTS, observability: false }, undefined)
    expect(opted).not.toEqual([])
    expect(opted).not.toContain("observability")
    expect(opted).toContain("tunnel")
    expect(opted).toContain("stripe")
  })

  it("is a no-op when observability was already absent (named services)", () => {
    const named = resolveProcessList(["api"], { ...DEFAULT_OPTS, observability: false }, undefined)
    expect(named).toEqual(["api"])
  })
})

describe("resolveProcessList — --skip-docker", () => {
  it("drops BOTH docker one-shots (unchanged pre-existing behaviour)", () => {
    const skipped = resolveProcessList([], DEFAULT_OPTS, true)
    expect(skipped).not.toContain("infra")
    expect(skipped).not.toContain("observability")
    expect(skipped).toContain("api")
  })

  it("combines with the opt-out without double-splicing", () => {
    const both = resolveProcessList([], { ...DEFAULT_OPTS, observability: false }, true)
    expect(both).not.toContain("observability")
    expect(both.filter((p) => p === "observability")).toHaveLength(0)
  })
})

describe("resolveProcessList — named services", () => {
  it("honours named args verbatim and does not inject observability", () => {
    expect(resolveProcessList(["commerce", "api"], DEFAULT_OPTS, undefined)).toEqual([
      "commerce",
      "api",
    ])
  })
})

describe("CORE_PROCESSES + OPTIONAL_PROCESSES vs process-compose.yaml", () => {
  // The `all` + opt-out path materializes CORE ∪ OPTIONAL as a stand-in for "every
  // process in the YAML". That substitution is only faithful while the two sets
  // are equal — if someone adds a process to the YAML and not to CORE, then
  // `ibx dev all --no-observability` would silently stop starting it.
  it("covers exactly the process set declared in the YAML", () => {
    const yaml = parse(fs.readFileSync(path.join(ROOT, "process-compose.yaml"), "utf8")) as {
      processes: Record<string, unknown>
    }
    const declared = Object.keys(yaml.processes).sort()
    const known = [...CORE_PROCESSES, ...OPTIONAL_PROCESSES].sort()
    expect(known).toEqual(declared)
  })

  it("declares `observability` as a CORE (default) process, not an optional one", () => {
    expect(CORE_PROCESSES).toContain("observability")
    expect(OPTIONAL_PROCESSES).not.toContain("observability")
  })
})
