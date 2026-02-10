import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `sesstbl-${Date.now()}`;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
});

// ── Table headers ──

test("sessions table shows Session ID column header", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator("th").filter({ hasText: "Session ID" })).toBeVisible({ timeout: 5_000 });
});

// ── Create Session button ──

test("Create Session button creates session and navigates to detail", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click('button:has-text("Create Session")');

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`, { timeout: 10_000 });
});
