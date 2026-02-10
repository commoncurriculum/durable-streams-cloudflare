import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `tabs-${Date.now()}`;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
});

// ── Overview tab visible at project detail ──

test("Overview tab is visible and active at /projects/$projectId", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  const overviewTab = page.locator("header nav").getByRole("link", { name: "Overview" });
  await expect(overviewTab).toBeVisible({ timeout: 5_000 });
});

// ── Sessions tab navigates ──

test("Sessions tab navigates to sessions page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  await page.locator("header nav").getByRole("link", { name: "Sessions" }).click();

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions`);
});

// ── Publish tab navigates ──

test("Publish tab navigates to publish page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  await page.locator("header nav").getByRole("link", { name: "Publish" }).click();

  await page.waitForURL(`**/projects/${PROJECT_ID}/publish`);
});
