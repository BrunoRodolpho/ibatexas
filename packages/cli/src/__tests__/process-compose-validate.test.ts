// BKL-249 — the dev-stack process-compose profiles must LOAD. Nothing in the
// repo validated them end to end, so process-compose.yaml sat unloadable: a
// top-level `env_file:` key made every `--dry-run` bail with "Unknown field
// 'env_file' in project file" (and bound nothing at runtime — process-compose
// silently ignores it). `--dry-run` parses + validates the merged project
// without starting a single process, which makes it the cheapest real gate:
// no docker, no ports, no .env required.
//
// LIMITS of --dry-run — measured on v1.103.0, do NOT read a green run here as
// "the file is fully valid":
//   - unknown key at the TOP level     → exit 1, FTL "Unknown field 'x' in
//                                        project file"                 (CAUGHT)
//   - unknown key at the PROCESS level → exit 1, FTL "unknown key 'x' found in
//                                        process 'p'"                  (CAUGHT)
//   - unknown key nested INSIDE an availability / probe block → exit 0, output
//     unchanged: SILENTLY IGNORED. A typo'd `restart_policy:` or a misspelled
//     probe field inside those blocks passes this gate and still needs a real
//     dev-stack boot to surface.
// Nothing here asserts runtime behaviour (readiness probes, dependency order,
// env binding) — only that the assembled project is loadable.
//
// process-compose is an optional local binary (brew install
// f1bonacc1/tap/process-compose), same as the `ibx dev` precondition in
// commands/dev.ts, so this suite skips when it is absent rather than failing a
// machine that never boots the dev stack.

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execaSync } from "execa"
import { ROOT } from "../utils/root.js"
import { DEV_SUPERVISOR_LOG, disposableLogPath } from "../lib/process-compose-log.js"

// BKL-288 — every invocation in THIS file is a throwaway validator, never the
// live supervisor, so each one carries its own `-L`. Without it, running this
// suite (locally, or as the CI gate) truncates process-compose's shared
// `$TMPDIR/process-compose-$USER.log` and destroys the running dev stack's log.
// Built here from the test's own primitive rather than reused from
// process-compose-log.ts, so the isolation assertions below stay independent of
// the helper they are meant to keep honest.
const OWN_LOG = path.join(os.tmpdir(), `ibx-pc-validate-${process.pid}.log`)

function processComposeInstalled(): boolean {
  try {
    execaSync("process-compose", ["version", "-L", OWN_LOG], { reject: true })
    return true
  } catch {
    return false
  }
}

const PC_INSTALLED = processComposeInstalled()

/** `process-compose --dry-run` over one or more profile files, from the repo
 *  root (the profiles use root-relative paths). Never throws — the exit code is
 *  the signal: 0 + a "Validated N configured processes" line on stdout means the
 *  project loaded; a load failure exits non-zero and reports FTL on stderr. */
function dryRun(...files: string[]): { exitCode: number; stdout: string; stderr: string } {
  const args = ["--dry-run", "-L", OWN_LOG, ...files.flatMap((f) => ["-f", f])]
  const r = execaSync("process-compose", args, { cwd: ROOT, reject: false })
  return {
    exitCode: r.exitCode ?? 1,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
  }
}

const VALIDATED = /Validated \d+ configured processes/

describe.skipIf(!PC_INSTALLED)("process-compose profiles load (BKL-249)", () => {
  it("dev profile — process-compose.yaml", () => {
    const { exitCode, stdout, stderr } = dryRun("process-compose.yaml")
    expect(stderr).not.toMatch(/Failed to load project/)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(VALIDATED)
  })

  it("journey-test profile — process-compose.test.yaml", () => {
    const { exitCode, stdout, stderr } = dryRun("process-compose.test.yaml")
    expect(stderr).not.toMatch(/Failed to load project/)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(VALIDATED)
  })

  // The e2e file is an OVERLAY, not a standalone profile: it is only valid
  // merged onto the test profile, in this order — the same `-f` sequence
  // scripts/test-stack-up.sh passes under IBX_TEST_E2E=1.
  it("e2e overlay — merged onto the journey-test profile", () => {
    const { exitCode, stdout, stderr } = dryRun(
      "process-compose.test.yaml",
      "process-compose.e2e.yaml",
    )
    expect(stderr).not.toMatch(/Failed to load project/)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(VALIDATED)
  })

  // NON-VACUITY CONTROLS — these keep the three assertions above honest. Without
  // them a process-compose that stopped validating, or a dryRun() that silently
  // mis-invoked the binary, would let every test above pass green on an
  // unloadable file. Both controls run against a synthetic minimal profile so
  // they assert the DETECTOR, independent of the repo's own files.
  const MINIMAL = 'version: "0.5"\nprocesses:\n  probe:\n    command: "true"\n'

  function dryRunSynthetic(body: string): ReturnType<typeof dryRun> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibx-pc-249-"))
    try {
      const f = path.join(dir, "process-compose.synthetic.yaml")
      fs.writeFileSync(f, body)
      return dryRun(f)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it("REJECTS the top-level env_file key this ticket removed", () => {
    const { exitCode, stderr } = dryRunSynthetic(`env_file:\n  - ".env"\n${MINIMAL}`)
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/Unknown field 'env_file' in project file/)
  })

  it("REJECTS an unknown key at the process level", () => {
    const { exitCode, stderr } = dryRunSynthetic(`${MINIMAL}    bogus_process_key: 1\n`)
    expect(exitCode).not.toBe(0)
    expect(stderr).toMatch(/unknown key 'bogus_process_key' found in process 'probe'/)
  })

  // The documented blind spot, pinned as an executable fact rather than a claim
  // in the header above. If this test ever FAILS, process-compose learned to
  // validate availability-nested keys — that is good news: drop this test and
  // remove the corresponding LIMITS bullet from the header.
  it("does NOT catch an unknown key nested under availability (known limit)", () => {
    const { exitCode, stdout } = dryRunSynthetic(
      `${MINIMAL}    availability:\n      restart: "no"\n      totally_bogus_nested_key: 42\n`,
    )
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(VALIDATED)
  })
})

// ── BKL-288 — the gate above must not destroy the live supervisor's log ──────
//
// process-compose keeps its own supervisor log (probe results, restart
// decisions, exit codes) at ONE shared per-user default,
// $TMPDIR/process-compose-$USER.log, and TRUNCATES it on every invocation that
// initialises the logger — `up`, `--dry-run` and `version` alike. So the gate
// above, run while a dev stack is up, used to wipe exactly the forensics that
// diagnosed the BKL-287 probe-kill class.
//
// Both arms run below because only the pair is meaningful: the SURVIVES arm
// alone would stay green if process-compose stopped truncating at all (nothing
// left to protect against), and the TRUNCATES arm alone proves no fix. Every
// invocation here overrides $TMPDIR to a scratch dir, so the "default" path
// under test is disposable and the developer's real supervisor log is never
// touched.
describe.skipIf(!PC_INSTALLED)("process-compose log-path isolation (BKL-288)", () => {
  const SENTINEL = "SENTINEL-LIVE-SUPERVISOR-FORENSICS"

  /** Fresh scratch $TMPDIR with a sentinel already sitting at the path
   *  process-compose will compute as its shared default. */
  function withScratchTmp<T>(fn: (dir: string, defaultLog: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ibx-pc-288-"))
    try {
      const defaultLog = path.join(dir, `process-compose-${os.userInfo().username}.log`)
      fs.writeFileSync(defaultLog, `${SENTINEL}\n`)
      return fn(dir, defaultLog)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  function runWithTmp(dir: string, args: string[]): number {
    const env = { ...process.env, TMPDIR: dir }
    // A stray PC_LOG_FILE in the ambient environment would redirect the log and
    // make BOTH arms pass vacuously.
    delete env.PC_LOG_FILE
    const r = execaSync("process-compose", args, {
      cwd: ROOT,
      reject: false,
      env,
      extendEnv: false,
    })
    return r.exitCode ?? 1
  }

  const PROFILE = "process-compose.yaml"

  it("CONTROL — a --dry-run with no log path TRUNCATES the shared default log", () => {
    withScratchTmp((dir, defaultLog) => {
      expect(runWithTmp(dir, ["--dry-run", "-f", PROFILE])).toBe(0)
      expect(fs.readFileSync(defaultLog, "utf8")).not.toContain(SENTINEL)
    })
  })

  it("a --dry-run with an explicit -L leaves the shared default log intact", () => {
    withScratchTmp((dir, defaultLog) => {
      const own = path.join(dir, "dry-run.log")
      expect(runWithTmp(dir, ["--dry-run", "-L", own, "-f", PROFILE])).toBe(0)
      expect(fs.readFileSync(defaultLog, "utf8")).toContain(SENTINEL)
      expect(fs.existsSync(own)).toBe(true)
    })
  })

  it("a `version` probe with an explicit -L leaves the shared default log intact", () => {
    withScratchTmp((dir, defaultLog) => {
      // `ibx dev stop` / `ibx dev restart` run this probe against a LIVE stack.
      const own = path.join(dir, "version.log")
      expect(runWithTmp(dir, ["version", "-L", own])).toBe(0)
      expect(fs.readFileSync(defaultLog, "utf8")).toContain(SENTINEL)
    })
  })

  it("CONTROL — the same `version` probe without -L truncates it", () => {
    withScratchTmp((dir, defaultLog) => {
      expect(runWithTmp(dir, ["version"])).toBe(0)
      expect(fs.readFileSync(defaultLog, "utf8")).not.toContain(SENTINEL)
    })
  })

  // This suite's OWN invocations must obey the doctrine they assert. If
  // `-L OWN_LOG` is ever dropped from dryRun()/processComposeInstalled(), the
  // file stops writing its own log and this goes red.
  it("this suite writes its own log, not the shared default", () => {
    expect(fs.existsSync(OWN_LOG)).toBe(true)
    expect(OWN_LOG).not.toBe(path.join(os.tmpdir(), `process-compose-${os.userInfo().username}.log`))
  })
})

// Structural half — runs with or without the binary installed.
describe("the live dev supervisor names its own log path (BKL-288)", () => {
  const SHARED_DEFAULT = path.join(os.tmpdir(), `process-compose-${os.userInfo().username}.log`)

  it("`ibx dev start` passes -L with a path of its own", async () => {
    const { buildPcUpArgs } = await import("../commands/dev.js")
    const args = buildPcUpArgs(["api"], false)
    const i = args.indexOf("-L")
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe(DEV_SUPERVISOR_LOG)
    // …and it still starts the stack it was asked to start.
    expect(args[0]).toBe("up")
    expect(args).toContain("api")
    expect(args).toContain("-t=false")
  })

  it("the supervisor path is NOT the shared per-user default anything else truncates", () => {
    expect(DEV_SUPERVISOR_LOG).not.toBe(SHARED_DEFAULT)
    expect(disposableLogPath("probe")).not.toBe(SHARED_DEFAULT)
    expect(disposableLogPath("probe")).not.toBe(DEV_SUPERVISOR_LOG)
  })
})
