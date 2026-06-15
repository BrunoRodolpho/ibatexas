// playwright.config.ts — T2-7 e2e harness configuration.
//
// STACK CONTRACT: these tests run against the EPHEMERAL e2e test stack, never
// against servers Playwright starts itself (the previous webServer block
// booted the DEV servers without the .env.test contract — wrong env entirely,
// removed by T2-7). Bring the stack up first, then run with the test env
// sourced so the authed specs can mint fixtures (JWT_SECRET,
// IBX_TEST_FINGERPRINT, ORACLE_DATABASE_URL):
//
//   IBX_TEST_E2E=1 ./scripts/test-stack-up.sh
//   set -a; . ./.env.test; set +a
//   pnpm exec playwright test
//   ./scripts/test-stack-down.sh
//
// ZERO TOKENS: no spec may exercise the chat/LLM surface — this suite is the
// scripted, deterministic SUT harness (CI boots the stack with a placeholder
// ANTHROPIC_API_KEY; any LLM call would fail loudly).

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:3001";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tests/e2e/.results",

  /* Fail the build on CI if test.only was left in source */
  forbidOnly: !!process.env.CI,

  /* Retry once on CI, never locally */
  retries: process.env.CI ? 1 : 0,

  /* Single worker locally for predictable ordering; parallel on CI */
  workers: process.env.CI ? undefined : 1,

  /* Reporter */
  reporter: process.env.CI ? "github" : "list",

  /* Shared settings */
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    /* On CI keep the trace of every failed test (uploaded as an artifact);
     * locally only the first retry traces. Screenshots always on failure. */
    trace: process.env.CI ? "retain-on-failure" : "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "web",
      testMatch: /web-.*\.spec\.ts/,
      use: {
        baseURL: BASE_URL,
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "api",
      testMatch: /api-.*\.spec\.ts/,
      use: {
        baseURL: API_URL,
        extraHTTPHeaders: {
          Accept: "application/json",
        },
      },
    },
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts/,
      use: {
        baseURL: BASE_URL,
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
