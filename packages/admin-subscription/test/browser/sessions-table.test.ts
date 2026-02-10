import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `sesstbl-${Date.now()}`;

let sessionId: string;

// Create a project and a session.
test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);

  // Create a session via the UI
  const page = await browser.newPage();
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click('button:has-text("Create Session")');
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`, { timeout: 10_000 });
  const url = new URL(page.url());
  const parts = url.pathname.split("/");
  sessionId = parts[parts.length - 1];
  await page.close();
});

// ── Table headers ──

test("sessions table shows Session ID column header", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator("th").filter({ hasText: "Session ID" })).toBeVisible({ timeout: 5_000 });
});

// ── Session in table ──

test("created session appears in the table", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);

  // Wait for table to render
  await page.waitForSelector("th", { timeout: 5_000 });

  await expect(page.locator("main").locator(`text=${sessionId}`).first()).toBeVisible({ timeout: 15_000 });
});

// ── Clicking navigates to detail ──

test("clicking a session navigates to detail page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  const sessionLink = page.locator("main").locator(`text=${sessionId}`).first();
  await expect(sessionLink).toBeVisible({ timeout: 10_000 });
  await sessionLink.click();

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/${sessionId}`);
});

// ── Create Session button ──

test("Create Session button creates session and navigates to detail", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click('button:has-text("Create Session")');

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`, { timeout: 10_000 });
});
