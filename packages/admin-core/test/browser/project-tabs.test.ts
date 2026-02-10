import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `tabs-test-${Date.now()}`;

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

test("Overview tab is visible at /projects/$projectId", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Overview", { exact: true })).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("Settings", { exact: true })).toBeVisible({ timeout: 3_000 });
});

test("Project overview shows stat card headings", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator("text=Messages").first()).toBeVisible({ timeout: 3_000 });
  await expect(page.getByText("Storage", { exact: true })).toBeVisible({ timeout: 3_000 });
});

test("Streams tab navigates correctly", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  const streamsTab = page.locator("nav").last().getByText("Streams", { exact: true });
  await expect(streamsTab).toBeVisible({ timeout: 3_000 });
  await streamsTab.click();

  await page.waitForURL(`**/projects/${PROJECT_ID}/streams`, { timeout: 5_000 });
  await expect(page.locator('input[placeholder="Enter stream ID..."]')).toBeVisible({ timeout: 3_000 });
});

test("Settings tab navigates correctly", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  const settingsTab = page.locator("nav").last().getByText("Settings", { exact: true });
  await expect(settingsTab).toBeVisible({ timeout: 3_000 });
  await settingsTab.click();

  await page.waitForURL(`**/projects/${PROJECT_ID}/settings`, { timeout: 5_000 });
  await expect(page.getByText("Privacy")).toBeVisible({ timeout: 3_000 });
});
