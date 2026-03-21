import { execSync } from "node:child_process"
import fs from "node:fs"

interface PkgJson {
  pnpm?: {
    overrides?: Record<string, string>
    overrideNotes?: Record<string, string>
  }
}

function getBaseOverrides(): Record<string, string> {
  try {
    const raw = execSync("git show origin/main:package.json", {
      encoding: "utf-8",
    })
    const pkg: PkgJson = JSON.parse(raw)
    return pkg.pnpm?.overrides ?? {}
  } catch {
    console.log("Could not read origin/main:package.json. Skipping check.")
    process.exit(0)
  }
}

const currentPkg: PkgJson = JSON.parse(
  fs.readFileSync("package.json", "utf-8"),
)
const currentOverrides = currentPkg.pnpm?.overrides ?? {}
const currentNotes = currentPkg.pnpm?.overrideNotes ?? {}
const baseOverrides = getBaseOverrides()

const isComment = (k: string): boolean => k.startsWith("//")

const currentKeys = Object.keys(currentOverrides).filter((k) => !isComment(k))
const baseKeys = Object.keys(baseOverrides).filter((k) => !isComment(k))

const added = currentKeys.filter((k) => !(k in baseOverrides))
const changed = currentKeys.filter(
  (k) => k in baseOverrides && currentOverrides[k] !== baseOverrides[k],
)
const removed = baseKeys.filter((k) => !(k in currentOverrides))

// Check if a new override has a corresponding note
function hasNote(dep: string): boolean {
  for (const [noteKey, noteValue] of Object.entries(currentNotes)) {
    if (
      noteKey === dep ||
      noteKey.split(",").some((k) => k.trim() === dep)
    ) {
      return noteValue.length > 0
    }
  }
  return false
}

console.log("=".repeat(50))
console.log("  Override Drift Check")
console.log("=".repeat(50))
console.log()

if (added.length === 0 && changed.length === 0 && removed.length === 0) {
  console.log("No override changes detected.")
  process.exit(0)
}

let hasErrors = false

if (removed.length > 0) {
  console.log("REMOVED")
  console.log("-".repeat(40))
  for (const dep of removed) {
    console.log(`  - ${dep}@${baseOverrides[dep]}`)
  }
  console.log()
}

if (changed.length > 0) {
  console.log("CHANGED (version updated)")
  console.log("-".repeat(40))
  for (const dep of changed) {
    console.log(`  ${dep}: ${baseOverrides[dep]} -> ${currentOverrides[dep]}`)
  }
  console.log()
}

if (added.length > 0) {
  console.log("ADDED")
  console.log("-".repeat(40))

  const unjustified: string[] = []

  for (const dep of added) {
    const noted = hasNote(dep)
    const status = noted ? "documented" : "MISSING JUSTIFICATION"
    console.log(`  + ${dep}@${currentOverrides[dep]} [${status}]`)
    if (!noted) {
      unjustified.push(dep)
    }
  }

  console.log()

  if (unjustified.length > 0) {
    hasErrors = true
    console.log("New overrides require justification.")
    console.log("Add an entry in pnpm.overrideNotes explaining why:")
    console.log()
    console.log('  "overrideNotes": {')
    for (const dep of unjustified) {
      console.log(`    "${dep}": "reason: ..."`)
    }
    console.log("  }")
    console.log()
  }
}

console.log("=".repeat(50))

if (hasErrors) {
  console.log("Override drift check failed.")
  process.exit(1)
} else {
  console.log("Override drift check passed.")
  process.exit(0)
}
