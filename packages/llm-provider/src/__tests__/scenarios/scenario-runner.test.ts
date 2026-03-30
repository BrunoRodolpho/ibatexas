import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runScenario, type ScenarioFixture } from "./scenario-runner.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, "fixtures")

// Mock getCurrentMealPeriod so each fixture can control the meal period
vi.mock("../../machine/types.js", async () => {
  const actual = await vi.importActual("../../machine/types.js")
  return {
    ...(actual as object),
    getCurrentMealPeriod: vi.fn().mockReturnValue("lunch"),
  }
})

const fixtureFiles = fs.readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()

describe("conversation scenarios", () => {
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8"),
    ) as ScenarioFixture

    describe(fixture.name, () => {
      it(fixture.description, async () => {
        // Set mealPeriod mock for this fixture
        const { getCurrentMealPeriod } = await import("../../machine/types.js")
        vi.mocked(getCurrentMealPeriod).mockReturnValue(
          (fixture.mealPeriod ?? "lunch") as "lunch" | "dinner" | "closed",
        )

        const results = runScenario(fixture)

        for (const result of results) {
          if (result.errors.length > 0) {
            const errorMsg = result.errors.map((e) => `  - ${e}`).join("\n")
            expect.fail(
              `Turn ${result.turnIndex} ("${result.input}") failed:\n${errorMsg}` +
              `\n  Actual state: ${result.stateValue}` +
              `\n  Events: ${result.events.map((e) => e.type).join(", ")}`,
            )
          }
        }
      })
    })
  }
})
