// FE-D05 regression — `ibx dev start [services] --no-tui -y` used to silently
// DROP both flags: the parent `dev` default action declares --no-tui / -y, and
// without positional-options enabled Commander v13 lets the parent shadow the
// `start` subcommand's identically-named options. The fix is
// program.enablePositionalOptions() (index.ts) + dev.enablePositionalOptions()
// (registerDevCommands). This test parses the EXACT failing invocation through
// the REAL command wiring and asserts both flags reach the start action.

import { describe, it, expect } from "vitest"
import { Command } from "commander"
import { registerDevCommands } from "../commands/dev.js"

/** Build the real dev command tree (mirroring index.ts's root wiring) and swap
 *  the `start` subcommand's action for a capture, so we assert PARSING without
 *  launching the stack. */
function parseDevStart(argv: string[]): Record<string, unknown> | undefined {
  const program = new Command()
  program.exitOverride()
  program.enablePositionalOptions() // index.ts root fix (FE-D05)
  const dev = program.command("dev")
  registerDevCommands(dev) // adds dev.enablePositionalOptions() + the start subcommand
  const start = dev.commands.find((c) => c.name() === "start")
  if (!start) throw new Error("start subcommand not registered")
  let captured: Record<string, unknown> | undefined
  start.exitOverride()
  // Re-set the action (last one wins in Commander) to a synchronous capture,
  // so pcStart never runs — we only assert the parsed options.
  start.action((_services: string[], opts: Record<string, unknown>) => {
    captured = opts
  })
  program.parse(["node", "ibx", ...argv])
  return captured
}

describe("FE-D05 — ibx dev start flag parsing", () => {
  it("routes --no-tui and -y to the start subcommand (not shadowed by the parent)", () => {
    const opts = parseDevStart(["dev", "start", "api", "--no-tui", "-y"])
    expect(opts).toBeDefined()
    // --no-tui → Commander negates the `tui` boolean.
    expect(opts!.tui).toBe(false)
    // -y / --yes → the confirm-skip flag.
    expect(opts!.yes).toBe(true)
  })

  it("still parses a plain `dev start api` (no flags) with tui defaulting on", () => {
    const opts = parseDevStart(["dev", "start", "api"])
    expect(opts).toBeDefined()
    // Absent --no-tui ⇒ tui stays the Commander default (true / undefined-truthy).
    expect(opts!.tui).not.toBe(false)
    expect(opts!.yes).toBeUndefined()
  })
})
