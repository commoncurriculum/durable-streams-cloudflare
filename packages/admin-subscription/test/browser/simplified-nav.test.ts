import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;

// ── System Overview nav link ──

test("System Overview nav link navigates to overview page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  await page.click("nav >> text=System Overview");

  await page.waitForURL("**/");
  await expect(page.getByText("Subscription Admin")).toBeVisible();
});

// ── Projects nav link ──

test("Projects nav link navigates to projects page", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  await page.click("nav >> text=Projects");

  await page.waitForURL("**/projects");
  await expect(page.locator("main table")).toBeVisible({ timeout: 5_000 });
});

// ── Old elements are gone ──

test("project dropdown selector is no longer in the nav", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  await expect(page.locator("#project-select")).toHaveCount(0);
});

test("Create Project button is no longer in the nav", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  await expect(page.locator('button[title="Create Project"]')).toHaveCount(0);
});
