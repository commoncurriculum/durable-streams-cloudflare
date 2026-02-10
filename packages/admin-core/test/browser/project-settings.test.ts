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
  await expect(page.locator('[role="switch"]')).toBeVisible({ timeout: 3_000 });
});

test("Privacy toggle switches between Public and Private", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");

  const toggle = page.locator('[role="switch"]');
  await expect(toggle).toBeVisible({ timeout: 3_000 });

  // New projects default to private (toggle off)
  await expect(page.getByText("Private")).toBeVisible({ timeout: 3_000 });

  // Click the switch indicator (the visible sliding element) to toggle
  await page.locator('[data-slot="indicator"]').click();
  await expect(page.getByText("Public")).toBeVisible({ timeout: 3_000 });

  // Click again to switch back to Private
  await page.locator('[data-slot="indicator"]').click();
  await expect(page.getByText("Private")).toBeVisible({ timeout: 3_000 });
});

test("CORS Origins section is visible", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("CORS Origins")).toBeVisible({ timeout: 3_000 });
});

test("Adding a CORS origin shows it in the list", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("CORS Origins")).toBeVisible({ timeout: 3_000 });

  await page.locator('input[placeholder="https://example.com"]').fill("https://myapp.com");
  await page.click('button:has-text("Add")');

  await expect(page.getByText("https://myapp.com")).toBeVisible({ timeout: 5_000 });
});

test("Removing a CORS origin removes it from the list", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");

  // The origin added in the previous test should be visible
  await expect(page.getByText("https://myapp.com")).toBeVisible({ timeout: 5_000 });

  // Click the remove button next to it
  const row = page.locator("li, tr, div").filter({ hasText: "https://myapp.com" }).first();
  await row.locator('button:has-text("Remove")').click();

  await expect(page.getByText("https://myapp.com")).not.toBeVisible({ timeout: 5_000 });
});
