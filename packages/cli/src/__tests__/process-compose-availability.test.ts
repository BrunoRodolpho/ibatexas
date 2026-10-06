// BKL-287 — the STRUCTURAL complement to BKL-249's dry-run gate.
//
// BKL-249 proved `--dry-run` loads the profile. It also measured, and pinned as
// an executable fact in process-compose-validate.test.ts, that process-compose
// SILENTLY IGNORES unknown keys nested inside an `availability:` or probe block.
// So the entire restart/probe policy is invisible to that gate: a typo'd
// `restart_polciy:`, a `restart: on_failure` regression, or a probe budget
// quietly shrunk back to 5 seconds all validate green and change behaviour.
//
// This suite asserts the policy itself, straight off the YAML.
//
// The doctrine it enforces (measured on process-compose v1.103.0 — see the
// header of process-compose.yaml for the full transcript):
//
//   • A long-running process gets `restart: always`, never `on_failure`.
//     on_failure is structurally useless here: when a readiness probe exhausts
//     failure_threshold, process-compose SIGTERMs the process, and a
//     well-behaved app (apps/api/src/index.ts registers a SIGTERM handler;
//     `next dev` does too) shuts down gracefully and exits ZERO. on_failure sees
//     a zero exit and correctly declines — the process stays dead, silently.
//     That is the BKL-287 outage: Completed / restarts:0 / exit:0.
//
//   • A one-shot gets `restart: "no"`, always. Completing IS its success
//     condition. Measured: a one-shot under `always` re-ran its side effect 4
//     more times, and build-packages/web-clean/admin-clean would rebuild every
//     package or `rm -rf .next` underneath already-booted dev servers.
//
//   • A long-runner's readiness probe is a KILL SWITCH, so it must be sized for
//     a loaded box: timeout_seconds <= period_seconds (otherwise a slow probe
//     overlaps the next one and manufactures its own backlog of failures), and
//     the kill budget (failure_threshold x period_seconds) must stay generous.
//     A healthy `web` was measured answering GET / in 16.3s under fleet CPU load
//     against a 5s timeout — that is what killed it.
//
// A process NOT listed in ONE_SHOTS is treated as a long-runner. That is
// deliberate: adding a new process to the profile without giving it a policy
// fails this suite and forces the author to make the call explicitly.

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { ROOT } from "../utils/root.js"

/** Processes that are SUPPOSED to run to completion and exit 0. */
const ONE_SHOTS = new Set(["infra", "observability", "build-packages", "web-clean", "admin-clean"])

/** Floor for a long-runner's kill budget, in seconds. The pre-BKL-287 profile
 *  ran budgets of 60-90s on the processes that died; nothing may go back there. */
const MIN_KILL_BUDGET_SECONDS = 120

interface Probe {
  period_seconds?: number
  timeout_seconds?: number
  failure_threshold?: number
}
interface Proc {
  availability?: { restart?: string; max_restarts?: number; backoff_seconds?: number }
  readiness_probe?: Probe
}
interface Profile {
  processes: Record<string, Proc>
}

/** Pure checker so the real profile and the synthetic controls run the SAME
 *  code. Returns a list of human-readable violations; empty means compliant. */
function policyViolations(profile: Profile): string[] {
  const out: string[] = []
  for (const [name, cfg] of Object.entries(profile.processes ?? {})) {
    const restart = cfg.availability?.restart
    const isOneShot = ONE_SHOTS.has(name)

    if (isOneShot) {
      if (restart !== "no") {
        out.push(`${name}: one-shot must be restart:"no", got ${JSON.stringify(restart)}`)
      }
      continue // one-shot probes are out of scope; they complete in ~1s
    }

    if (restart !== "always") {
      out.push(`${name}: long-runner must be restart:"always", got ${JSON.stringify(restart)}`)
    }

    const probe = cfg.readiness_probe
    if (probe) {
      const period = probe.period_seconds ?? 0
      const timeout = probe.timeout_seconds ?? 0
      const threshold = probe.failure_threshold ?? 0
      if (timeout > period) {
        out.push(`${name}: probe timeout ${timeout}s > period ${period}s (probes can overlap)`)
      }
      const budget = threshold * period
      if (budget < MIN_KILL_BUDGET_SECONDS) {
        out.push(
          `${name}: kill budget ${budget}s is below the ${MIN_KILL_BUDGET_SECONDS}s floor ` +
            `(failure_threshold ${threshold} x period ${period}s)`,
        )
      }
    }
  }
  return out
}

function loadDevProfile(): Profile {
  return parseYaml(fs.readFileSync(path.join(ROOT, "process-compose.yaml"), "utf8")) as Profile
}

describe("process-compose availability policy (BKL-287)", () => {
  it("the dev profile satisfies the whole doctrine", () => {
    expect(policyViolations(loadDevProfile())).toEqual([])
  })

  it("every long-running app process is restart:always — none regressed to on_failure", () => {
    const { processes } = loadDevProfile()
    const longRunners = Object.keys(processes).filter((n) => !ONE_SHOTS.has(n))
    // guards against the whole set being renamed/emptied, which would make the
    // filter vacuous and every assertion below trivially true
    expect(longRunners).toEqual(
      expect.arrayContaining(["api", "web", "admin", "adj-console", "adjutant", "commerce"]),
    )
    for (const n of longRunners) {
      expect(processes[n]?.availability?.restart, `${n} restart policy`).toBe("always")
    }
  })

  it("every one-shot still has NO restart policy", () => {
    const { processes } = loadDevProfile()
    for (const n of ONE_SHOTS) {
      expect(processes[n], `${n} missing from the profile`).toBeDefined()
      expect(processes[n]?.availability?.restart, `${n} restart policy`).toBe("no")
    }
  })

  // ── NON-VACUITY CONTROLS ──────────────────────────────────────────────────
  // Without these, a policyViolations() that silently stopped checking anything
  // would let every assertion above pass green on a fully regressed profile.
  // Each control feeds the checker a synthetic profile with exactly one defect.

  it("CONTROL: catches a long-runner regressed to on_failure (the BKL-287 bug)", () => {
    const v = policyViolations({
      processes: { api: { availability: { restart: "on_failure", max_restarts: 3 } } },
    })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/api: long-runner must be restart:"always", got "on_failure"/)
  })

  it("CONTROL: catches a long-runner with no availability block at all", () => {
    const v = policyViolations({ processes: { web: {} } })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/web: long-runner must be restart:"always", got undefined/)
  })

  it("CONTROL: catches a one-shot that was given a restart policy", () => {
    const v = policyViolations({
      processes: { "build-packages": { availability: { restart: "always" } } },
    })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/build-packages: one-shot must be restart:"no", got "always"/)
  })

  it("CONTROL: catches a probe whose timeout exceeds its period", () => {
    const v = policyViolations({
      processes: {
        web: {
          availability: { restart: "always" },
          readiness_probe: { period_seconds: 3, timeout_seconds: 30, failure_threshold: 60 },
        },
      },
    })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/web: probe timeout 30s > period 3s/)
  })

  it("CONTROL: catches the pre-BKL-287 probe budget (20 x 3s = 60s)", () => {
    const v = policyViolations({
      processes: {
        web: {
          availability: { restart: "always" },
          readiness_probe: { period_seconds: 3, timeout_seconds: 3, failure_threshold: 20 },
        },
      },
    })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/web: kill budget 60s is below the 120s floor/)
  })
})
