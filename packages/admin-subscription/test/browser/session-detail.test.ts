import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `sessdet-${Date.now()}`;

let sessionId: string;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);

  // Create a session
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

// ── Stat cards row ──

test("session detail shows stat cards for Subscriptions and Messages", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(page.getByText("Subscriptions").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Messages").first()).toBeVisible({ timeout: 5_000 });
});

// ── Message Volume heading ──

test("session detail shows Message Volume chart heading", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(page.getByText("Message Volume")).toBeVisible({ timeout: 10_000 });
});

// ── Subscriptions table with Unsubscribe ──

test("session detail shows Add Subscription form", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(page.getByPlaceholder("stream-id")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeVisible({ timeout: 5_000 });
});

// ── Live Event Log / SSE ──

test("session detail shows live event log with SSE badge", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(page.getByText("Live Event Log")).toBeVisible({ timeout: 10_000 });
  const badge = page.getByText("connected", { exact: true });
  await expect(badge).toBeVisible({ timeout: 10_000 });
});
