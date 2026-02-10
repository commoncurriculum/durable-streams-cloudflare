import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `projlist-${Date.now()}`;

// Create a project so the list has something to show.
test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
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

  const projectCell = page.locator("main").locator(`text=${PROJECT_ID}`).first();
  await expect(projectCell).toBeVisible({ timeout: 10_000 });
});

// ── Click navigates to project detail ──

test("clicking a project navigates to /projects/$projectId", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  const projectLink = page.locator("main").locator(`text=${PROJECT_ID}`).first();
  await expect(projectLink).toBeVisible({ timeout: 10_000 });
  await projectLink.click();

  await page.waitForURL(`**/projects/${PROJECT_ID}`);
});
