import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `projlist-${Date.now()}`;

// Create a project so the list has something to show.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  // Create project via "+" button
  await page.click('button[title="Create Project"]');
  await page.waitForSelector("text=Create Project");
  const modal = page.locator(".fixed.inset-0");
  await modal.locator('input[placeholder="my-project"]').fill(PROJECT_ID);
  await modal.locator('button:has-text("Create"):not([disabled])').click();
  await page.waitForSelector("text=Save this signing secret", { timeout: 10_000 });
  await page.click('button:has-text("Done")');
  await page.close();
});

// ── Projects nav link ──

test("Projects nav link navigates to /projects", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  await page.click("text=Projects");

  await page.waitForURL("**/projects");
  await expect(page.locator("table")).toBeVisible({ timeout: 5_000 });
});

// ── Projects table shows project ──

test("projects table shows the created project", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  const projectCell = page.locator(`text=${PROJECT_ID}`).first();
  await expect(projectCell).toBeVisible({ timeout: 10_000 });
});

// ── Click navigates to project detail ──

test("clicking a project navigates to /projects/$projectId", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  const projectLink = page.locator(`text=${PROJECT_ID}`).first();
  await expect(projectLink).toBeVisible({ timeout: 10_000 });
  await projectLink.click();

  await page.waitForURL(`**/projects/${PROJECT_ID}`);
});
