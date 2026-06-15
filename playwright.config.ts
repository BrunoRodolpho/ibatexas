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
    trace: "on-first-retry",
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

  /* Start the web app + API before tests if not already running */
  webServer: [
    {
      command: "pnpm --filter @ibatexas/web dev",
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @ibatexas/api dev",
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
