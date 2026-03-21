import { execSync } from "node:child_process"
import fs from "node:fs"

interface PkgJson {
  pnpm?: {
    overrides?: Record<string, string>
  }
}

interface DepNode {
  version?: string
  dependencies?: Record<string, DepNode>
}

interface PnpmListEntry {
  dependencies?: Record<string, DepNode>
  devDependencies?: Record<string, DepNode>
}

const NON_DETERMINISTIC = /[>=<^~*|]/

const pkg: PkgJson = JSON.parse(fs.readFileSync("package.json", "utf-8"))
const overrides = pkg.pnpm?.overrides

if (!overrides) {
  console.log("No pnpm overrides found.")
  process.exit(0)
}

const entries = Object.entries(overrides).filter(([k]) => !k.startsWith("//"))

// Build installed package set from pnpm list
function getInstalledPackages(): Map<string, string[]> {
  const installed = new Map<string, string[]>()

  try {
    const raw = execSync("pnpm list --json --depth=Infinity --recursive", {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    })
    const projects: PnpmListEntry[] = JSON.parse(raw)

    function walk(deps: Record<string, DepNode> | undefined): void {
      if (!deps) return
      for (const [name, node] of Object.entries(deps)) {
        if (node.version) {
          const versions = installed.get(name) ?? []
          if (!versions.includes(node.version)) {
            versions.push(node.version)
          }
          installed.set(name, versions)
        }
        walk(node.dependencies)
      }
    }

    for (const project of projects) {
      walk(project.dependencies)
      walk(project.devDependencies)
    }
  } catch {
    console.error("Failed to run pnpm list. Falling back to pnpm why.\n")

    for (const [dep] of entries) {
      try {
        const out = execSync(`pnpm why ${dep} 2>&1`, { encoding: "utf-8" })
        const versionMatch = out.match(new RegExp(`${dep}@([^\\s]+)`))
        if (versionMatch?.[1]) {
          installed.set(dep, [versionMatch[1]])
        }
      } catch {
        // not installed
      }
    }
  }

  return installed
}

const installed = getInstalledPackages()

const unused: string[] = []
const nonDeterministic: [string, string][] = []
const versionDrift: [string, string, string[]][] = []
const active: [string, string, string[]][] = []

for (const [dep, version] of entries) {
  const versions = installed.get(dep)

  if (!versions || versions.length === 0) {
    unused.push(dep)
    continue
  }

  if (NON_DETERMINISTIC.test(version)) {
    nonDeterministic.push([dep, version])
  }

  if (versions.length === 1 && versions[0] === version) {
    active.push([dep, version, versions])
  } else {
    versionDrift.push([dep, version, versions])
  }
}

let hasIssues = false

console.log("=".repeat(50))
console.log("  pnpm Override Audit")
console.log("=".repeat(50))
console.log()

if (unused.length > 0) {
  hasIssues = true
  console.log("UNUSED (not in dependency tree)")
  console.log("-".repeat(40))
  for (const dep of unused) {
    console.log(`  ${dep}`)
  }
  console.log()
}

if (nonDeterministic.length > 0) {
  hasIssues = true
  console.log("NON-DETERMINISTIC (use exact versions)")
  console.log("-".repeat(40))
  for (const [dep, version] of nonDeterministic) {
    console.log(`  ${dep}: ${version}`)
  }
  console.log()
}

if (versionDrift.length > 0) {
  console.log("VERSION DRIFT (installed differs from override)")
  console.log("-".repeat(40))
  for (const [dep, override, versions] of versionDrift) {
    console.log(`  ${dep}: override=${override}, installed=${versions.join(", ")}`)
  }
  console.log()
}

if (active.length > 0) {
  console.log("ACTIVE (OK)")
  console.log("-".repeat(40))
  for (const [dep, version] of active) {
    console.log(`  ${dep}@${version}`)
  }
  console.log()
}

console.log("=".repeat(50))

if (hasIssues) {
  console.log("Issues found. Fix unused or non-deterministic overrides.")
  process.exit(1)
} else {
  console.log("All overrides clean.")
  process.exit(0)
}
