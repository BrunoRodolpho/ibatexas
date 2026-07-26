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

function processComposeInstalled(): boolean {
  try {
    execaSync("process-compose", ["version"], { reject: true })
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
  const args = ["--dry-run", ...files.flatMap((f) => ["-f", f])]
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
