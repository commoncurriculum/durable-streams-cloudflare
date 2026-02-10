import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `tbl-${Date.now()}`;

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

test("projects table has Project ID and Privacy headers", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator("th", { hasText: "Project ID" })).toBeVisible();
  await expect(page.locator("th", { hasText: "Privacy" })).toBeVisible();
});

test("clicking project navigates to /projects/$projectId", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  const link = page.locator(`text=${PROJECT_ID}`).first();
  await expect(link).toBeVisible({ timeout: 10_000 });
  await link.click();

  // Should navigate to project detail (not /streams)
  await page.waitForURL(`**/projects/${PROJECT_ID}`);
  // Sub-nav tabs should be visible
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible({ timeout: 5_000 });
});

test("Create Project button is visible", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator('button:has-text("Create Project")')).toBeVisible();
});
