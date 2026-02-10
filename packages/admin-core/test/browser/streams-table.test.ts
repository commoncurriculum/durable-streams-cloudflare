import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `stbl-${Date.now()}`;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  await page.click('button:has-text("Create Project")');
  await page.waitForSelector("text=Create Project");
  const modal = page.locator(".fixed.inset-0");
  await modal.locator('input[placeholder="my-project"]').fill(PROJECT_ID);
  await modal.locator('button:has-text("Create"):not([disabled])').click();
  await page.waitForSelector("text=Save this signing secret", { timeout: 10_000 });
  await page.click('button:has-text("Done")');
  await page.close();
});

test("streams tab shows table with Stream Key and Messages headers", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator("th", { hasText: "Stream Key" })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("th", { hasText: "Messages" })).toBeVisible();
});

test("streams tab still has search bar to open a stream", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator('input[placeholder="Enter stream ID..."]')).toBeVisible();
});
