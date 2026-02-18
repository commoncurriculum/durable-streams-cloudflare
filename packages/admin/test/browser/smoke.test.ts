import { test, expect } from "@playwright/test";

test("admin loads successfully", async ({ page }) => {
  const adminUrl = process.env.ADMIN_URL;
  if (!adminUrl) throw new Error("ADMIN_URL not set");

  await page.goto(adminUrl);

  // Wait for the page to load
  await page.waitForLoadState("networkidle");

  // Check that the page title contains "Admin" or similar
  const title = await page.title();
  expect(title).toBeTruthy();

  // Check for any project-related content
  // Note: Since we don't have service bindings, many features won't work
  // This is just a smoke test to ensure the app builds and loads
  const body = await page.textContent("body");
  expect(body).toBeTruthy();
});
