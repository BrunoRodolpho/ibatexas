// Drift guard for lib/db-tables.ts — the registry that drives clean/provision/
// status. Checks the registry against the SOURCE of truth for each layer:
//   - domain → the Prisma schema's `model` declarations
//   - kernel → @adjudicate/audit-postgres `CREATE TABLE` statements
//   - memory → @claustrum/* `CREATE TABLE` statements
// Reads files only (no DB, no build), so adding a table without registering it
// fails CI — the root-cause fix for the original hardcoded clean list.
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  DOMAIN_DELETE_ORDER,
  DOMAIN_REFERENCE,
  KERNEL_TABLES,
  WRITER_OWNED_KERNEL_TABLES,
  MEMORY_TABLES,
} from "../lib/db-tables.js"
import { resolveAuditMigrationsDir } from "../lib/kernel-migrate.js"
import { resolveClaustrumMigrationsDirs } from "../lib/claustrum-migrate.js"

// Repo root from this test file: packages/cli/src/__tests__ → up 4.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../")

/** Prisma model name → client delegate accessor (lowercase first char). */
function toDelegate(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

function prismaModelDelegates(): string[] {
  const schema = fs.readFileSync(
    path.join(ROOT, "packages/domain/prisma/schema.prisma"),
    "utf8",
  )
  const names: string[] = []
  const re = /^model\s+(\w+)\s*\{/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(schema)) !== null) names.push(toDelegate(m[1]!))
  return names
}

/** Tables created by `CREATE TABLE` across the given migration dirs (comments stripped). */
function createdTables(dirs: string[]): Set<string> {
  const out = new Set<string>()
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const sql = fs
        .readFileSync(path.join(dir, file), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("--")) // skip commented partition examples
        .join("\n")
      const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(sql)) !== null) out.add(m[1]!)
    }
  }
  return out
}

describe("db-tables drift guard — domain (Prisma)", () => {
  it("registry matches the Prisma schema's models exactly", () => {
    const models = new Set(prismaModelDelegates())
    const registered = new Set<string>([...DOMAIN_DELETE_ORDER, ...DOMAIN_REFERENCE])

    // No unregistered model — the bug that started this work.
    for (const m of models) {
      expect(registered.has(m), `Prisma model "${m}" is missing from db-tables registry`).toBe(true)
    }
    // No stale registry entry pointing at a non-existent model.
    for (const r of registered) {
      expect(models.has(r), `registry entry "${r}" is not a Prisma model`).toBe(true)
    }
  })

  it("has no duplicate entries across domain + reference", () => {
    const all = [...DOMAIN_DELETE_ORDER, ...DOMAIN_REFERENCE]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe("db-tables drift guard — kernel (@adjudicate/audit-postgres)", () => {
  it("registry matches the migrations' CREATE TABLE set (tracking table excluded)", () => {
    const created = createdTables([resolveAuditMigrationsDir(ROOT)])
    created.delete("adjudicate_audit_migrations") // runner-owned bookkeeping, not data

    for (const t of created) {
      expect(KERNEL_TABLES as readonly string[]).toContain(t)
    }
    for (const t of KERNEL_TABLES) {
      // Writer-owned tables (Wire Truth) declare their DDL owner in
      // WRITER_OWNED_KERNEL_TABLES — exempt from the migrations bijection,
      // never silently.
      if (WRITER_OWNED_KERNEL_TABLES.has(t)) continue
      expect(created.has(t), `KERNEL_TABLES entry "${t}" is not created by any migration`).toBe(true)
    }
    // The exemption list may not name tables that a migration DOES create
    // (that would hide a real drift) or tables absent from the registry.
    for (const t of WRITER_OWNED_KERNEL_TABLES) {
      expect(created.has(t), `writer-owned "${t}" is ALSO created by a migration — drop the exemption`).toBe(false)
      expect(KERNEL_TABLES as readonly string[]).toContain(t)
    }
  })
})

describe("db-tables drift guard — memory (@claustrum/*)", () => {
  it("registry matches the migrations' CREATE TABLE set (tracking table excluded)", () => {
    const created = createdTables(resolveClaustrumMigrationsDirs(ROOT))
    created.delete("claustrum_migrations") // runner-owned bookkeeping, not data

    for (const t of created) {
      expect(MEMORY_TABLES as readonly string[]).toContain(t)
    }
    for (const t of MEMORY_TABLES) {
      expect(created.has(t), `MEMORY_TABLES entry "${t}" is not created by any migration`).toBe(true)
    }
  })
})
