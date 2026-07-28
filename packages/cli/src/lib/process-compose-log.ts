// BKL-288 — process-compose log-path isolation.
//
// process-compose writes its OWN supervisor log (startup, probe results, exit
// codes, restart decisions) to ONE shared default path:
//
//     $TMPDIR/process-compose-$USER.log
//
// and it TRUNCATES that file on every invocation that initialises the logger —
// measured on v1.103.0 (`--dry-run` and `version` included, `up` obviously).
// The default is per-USER, not per-invocation, so a throwaway validation run
// silently destroys the log of the supervisor that is CURRENTLY RUNNING. That
// is not hypothetical: the BKL-249 gate shells out `process-compose --dry-run`,
// `ibx dev stop` / `ibx dev restart` probe with `process-compose version`, and
// the test stack boots a SECOND supervisor — every one of them wiped the dev
// supervisor's log, i.e. exactly the forensics that diagnosed the BKL-287
// probe-kill incident class.
//
// Measured truncation behaviour (v1.103.0, scratch $TMPDIR, sentinel line):
//   process-compose up                 → TRUNCATES the shared default
//   process-compose --dry-run          → TRUNCATES the shared default
//   process-compose version            → TRUNCATES the shared default
//   process-compose process list -p N  → leaves it alone (HTTP client only)
//   process-compose down -p N          → leaves it alone (HTTP client only)
//   any of the above with -L <path>    → leaves it alone, writes <path>
//
// Doctrine, enforced by process-compose-validate.test.ts:
//   - THE live dev supervisor (`ibx dev start`) writes to an EXPLICIT, stable
//     path of its own — never to the shared default, so nothing else can be
//     pointed at it by accident.
//   - Every other invocation (validation, version probe, a second supervisor)
//     passes its own throwaway path.
//
// `-L` is also readable as PC_LOG_FILE, but the flag is preferred: `ibx dev`
// echoes its argv, so the log location stays visible in the console.

import os from "node:os"
import path from "node:path"

/** Explicit, stable log path for THE live dev supervisor (`ibx dev start`).
 *  Distinct from process-compose's shared `process-compose-$USER.log` default
 *  precisely so that no validation/probe invocation can land on it. */
export const DEV_SUPERVISOR_LOG = path.join(os.tmpdir(), "ibx-dev-supervisor.log")

/** A throwaway log path for an invocation that is NOT the live supervisor —
 *  version probes, `--dry-run` validation, one-off inspection. Keyed by tag +
 *  pid so concurrent runs (turbo fan-out, parallel vitest files) never collide
 *  with each other either. */
export function disposableLogPath(tag: string): string {
  return path.join(os.tmpdir(), `ibx-pc-${tag}-${process.pid}.log`)
}

/** `-L <path>` argv pair. Accepted before or after the subcommand — measured on
 *  v1.103.0 for `up`, `--dry-run` and `version`. */
export function logFileArgs(logPath: string): [string, string] {
  return ["-L", logPath]
}
