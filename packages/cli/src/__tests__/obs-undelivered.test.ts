// LE2-030 — `ibx obs undelivered`.
//
// Two pins, both file-reads only (no DB, no build):
//   1. the command is registered and carries its flags;
//   2. the failure vocabulary the CLI binds does NOT drift from the writer's
//      exported FAILED_WHATSAPP_STATUSES — the CLI is a separate workspace and
//      cannot import from apps/api, so the shared truth needs a guard.
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { durationToMs, registerObsCommands } from "../commands/obs.js"

// Repo root from this test file: packages/cli/src/__tests__ → up 4.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../")

const OBS_SRC = path.join(ROOT, "packages/cli/src/commands/obs.ts")
const STORE_SRC = path.join(ROOT, "apps/api/src/whatsapp/delivery-store.ts")

/** Extract a `["a", "b"]`-shaped string array literal following `name`. */
function statusLiteral(source: string, name: string): string[] {
  const re = new RegExp(`${name}[^=]*=\\s*(?:Object\\.freeze\\()?\\[([^\\]]*)\\]`)
  const m = re.exec(source)
  expect(m, `could not find the ${name} array literal`).not.toBeNull()
  return [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!)
}

describe("ibx obs undelivered — registration", () => {
  it("registers the subcommand with its threshold / since / limit flags", () => {
    const obs = new Command("obs")
    registerObsCommands(obs)

    const cmd = obs.commands.find((c) => c.name() === "undelivered")
    expect(cmd, "`ibx obs undelivered` is not registered").toBeDefined()
    const flags = cmd!.options.map((o) => o.long)
    expect(flags).toContain("--threshold")
    expect(flags).toContain("--since")
    expect(flags).toContain("--limit")
  })
})

describe("ibx obs undelivered — no drift from the writer's vocabulary", () => {
  it("binds exactly the statuses apps/api treats as 'did not reach the customer'", () => {
    const cli = statusLiteral(fs.readFileSync(OBS_SRC, "utf8"), "UNDELIVERED_STATUSES")
    const api = statusLiteral(fs.readFileSync(STORE_SRC, "utf8"), "FAILED_WHATSAPP_STATUSES")

    expect(cli).not.toHaveLength(0)
    expect([...cli].sort()).toEqual([...api].sort())
  })

  it("queries the same writer-owned table the registry pins", () => {
    const obs = fs.readFileSync(OBS_SRC, "utf8")
    expect(obs).toContain("FROM whatsapp_delivery")
    // The silent case — the one that used to be invisible — is part of the query.
    expect(obs).toContain("status IS NULL AND sent_at <")
  })
})

describe("durationToMs", () => {
  it("converts the ibx duration shapes", () => {
    expect(durationToMs("30s")).toBe(30_000)
    expect(durationToMs("5m")).toBe(300_000)
    expect(durationToMs("2h")).toBe(7_200_000)
    expect(durationToMs("7d")).toBe(604_800_000)
  })
})
