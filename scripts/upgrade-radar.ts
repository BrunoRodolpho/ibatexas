import { execSync } from "node:child_process"

interface Target {
  name: string
  current: string
  overridesUnlocked: string[]
}

const targets: Target[] = [
  {
    name: "prisma",
    current: "7.5.0",
    overridesUnlocked: ["hono", "@hono/node-server", "effect"],
  },
  {
    name: "@medusajs/medusa",
    current: "2.13.4",
    overridesUnlocked: ["multer", "fast-xml-parser"],
  },
  {
    name: "vite",
    current: "5.4.21",
    overridesUnlocked: ["minimatch", "rollup", "glob"],
  },
  {
    name: "posthog-js",
    current: "1.363.1",
    overridesUnlocked: ["@posthog/core"],
  },
]

function getLatestVersion(pkg: string): string | null {
  try {
    const out = execSync(`npm view ${pkg} version 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, npm_config_update_notifier: "false" },
    }).trim()
    return out || null
  } catch {
    return null
  }
}

console.log("=".repeat(60))
console.log("  Upgrade Radar — Override Removal Opportunities")
console.log("=".repeat(60))
console.log()

const nameWidth = 22
const verWidth = 14

console.log(
  `${"PACKAGE".padEnd(nameWidth)}${"CURRENT".padEnd(verWidth)}${"LATEST".padEnd(verWidth)}ACTION`,
)
console.log("-".repeat(60))

let opportunities = 0

for (const target of targets) {
  const latest = getLatestVersion(target.name)

  if (!latest) {
    console.log(
      `${target.name.padEnd(nameWidth)}${target.current.padEnd(verWidth)}${"???".padEnd(verWidth)}fetch failed`,
    )
    continue
  }

  if (latest !== target.current) {
    opportunities++
    console.log(
      `${target.name.padEnd(nameWidth)}${target.current.padEnd(verWidth)}${latest.padEnd(verWidth)}UPDATE AVAILABLE`,
    )
    console.log(
      `${"".padEnd(nameWidth)}Potential override removal: ${target.overridesUnlocked.join(", ")}`,
    )
  } else {
    console.log(
      `${target.name.padEnd(nameWidth)}${target.current.padEnd(verWidth)}${latest.padEnd(verWidth)}up to date`,
    )
  }
}

console.log()
console.log("=".repeat(60))

if (opportunities > 0) {
  console.log(
    `${opportunities} upgrade(s) available. Review release notes before updating.`,
  )
} else {
  console.log("All watched packages are up to date.")
}

process.exit(0)
