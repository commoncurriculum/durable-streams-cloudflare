import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `settings-test-${Date.now()}`;

// Create a project before tests
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

test("Settings page shows Privacy section with toggle", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Privacy")).toBeVisible({ timeout: 3_000 });
  // There should be a toggle switch for privacy
  await expect(page.locator('switch, [role="switch"]')).toBeVisible({ timeout: 3_000 });
});

test("Privacy toggle switches between Public and Private", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");

  const toggle = page.locator('[role="switch"]');
  await expect(toggle).toBeVisible({ timeout: 3_000 });

  // New projects default to private (toggle off)
  await expect(page.getByText("Private")).toBeVisible({ timeout: 3_000 });

  // Click toggle to switch to Public
  await toggle.click();
  await expect(page.getByText("Public")).toBeVisible({ timeout: 3_000 });

  // Click toggle again to switch back to Private
  await toggle.click();
  await expect(page.getByText("Private")).toBeVisible({ timeout: 3_000 });
});
