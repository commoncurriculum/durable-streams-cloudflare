import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `projov-${Date.now()}`;

let sessionId: string;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
  sessionId = await createSession(ADMIN_URL, PROJECT_ID);
});

// ── Project overview shows real session count ──

test("project overview shows session count after creating a session", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  // Wait for the overview heading to confirm we're on the right page
  await expect(page.getByText("Project Overview")).toBeVisible({ timeout: 10_000 });

  // The Sessions card should display a real number >= 1, not the placeholder "—"
  const sessionsCard = page
    .locator(".rounded-lg")
    .filter({ hasText: /Sessions/i })
    .first();
  await expect(sessionsCard).toBeVisible({ timeout: 5_000 });

  // The value in the card must be a digit (real data), not "—" (placeholder)
  const value = await sessionsCard.locator(".text-2xl").textContent();
  expect(value).not.toBe("—");
  expect(value).toMatch(/\d+/);
});
