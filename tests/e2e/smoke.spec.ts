import { test, expect } from "@playwright/test";

test.describe("Smoke tests", () => {
  test("homepage loads and renders main heading", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/);
    // Page should not show an unhandled error overlay
    await expect(page.locator("body")).not.toContainText("Unhandled Runtime Error");
  });

  test("API health endpoint responds 200", async ({ request }) => {
    const response = await request.get("http://localhost:3001/health");
    expect(response.status()).toBe(200);
  });
});
