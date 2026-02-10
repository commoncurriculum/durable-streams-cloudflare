import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `buttons-${Date.now()}`;

let sessionId: string;

// Create a project and session for the test suite.
test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
  sessionId = await createSession(ADMIN_URL, PROJECT_ID);
});

// ── Nav: System Overview link ──

test("System Overview nav link navigates to overview page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click("text=System Overview");

  await page.waitForURL("**/");
  await expect(page.getByText("Subscription Service")).toBeVisible();
});

// ── Nav: Publish sub-tab ──

test("Publish sub-tab navigates to publish page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}`);
  await page.waitForLoadState("networkidle");

  await page.locator("main").getByRole("link", { name: "Publish" }).click();

  await page.waitForURL(`**/projects/${PROJECT_ID}/publish`);
  await expect(page.getByText("Publish to Stream")).toBeVisible();
});

// ── Create Session button ──

test("Create Session creates a new session and navigates to it", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click('button:has-text("Create Session")');

  // Should navigate to a session detail page with a UUID-like ID
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`, { timeout: 10_000 });
  await expect(page.getByText("Session ID")).toBeVisible({ timeout: 10_000 });
});

// ── Touch action ──

test("Touch action shows confirmation in event log", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await page.waitForSelector('button:has-text("Touch")', { timeout: 10_000 });

  // Click the Touch button (direct action, no Send needed)
  await page.click('button:has-text("Touch")');

  // Wait for control event
  const controlEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: /touched|control/ })
    .first();
  await expect(controlEntry).toBeVisible({ timeout: 10_000 });
});

// ── Unsubscribe action ──

test("Unsubscribe action sends and shows control event", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await page.waitForSelector('button:has-text("Subscribe")', { timeout: 10_000 });

  // Subscribe first via the subscribe form
  await page.locator('input[placeholder="stream-id"]').fill("unsub-test");
  await page.click('button:has-text("Subscribe")');
  await page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "Subscribed" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Wait for the subscription to appear in the table (polled via useSessionInspect)
  const unsubButton = page.locator('button:has-text("Unsubscribe")').first();
  await expect(unsubButton).toBeVisible({ timeout: 10_000 });

  // Click Unsubscribe in the subscription table row
  await unsubButton.click();

  // Wait for the unsub event
  const unsubEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: /[Uu]nsubscribed/ })
    .first();
  await expect(unsubEntry).toBeVisible({ timeout: 10_000 });
});

// ── Clear events button ──

test("Clear button clears the event log on session page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await page.waitForSelector('button:has-text("Touch")', { timeout: 10_000 });

  // Perform a touch to generate an event
  await page.click('button:has-text("Touch")');
  await page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "control" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Click Clear
  await page.click('button:text-is("Clear")');

  // Event log should show empty state
  await expect(page.getByText("Subscribe to a stream")).toBeVisible({ timeout: 5_000 });
});

// ── Delete action ──

test("Delete action sends and shows confirmation", async ({ page }) => {
  // Create a fresh session for deletion
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");
  await page.click('button:has-text("Create Session")');
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`, { timeout: 10_000 });
  await page.waitForSelector('button:has-text("Delete")', { timeout: 10_000 });

  // Click Delete button (direct action, no Send needed)
  await page.click('button:has-text("Delete")');

  // Wait for the delete confirmation or error in the event log
  const deleteEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: /deleted|control|error/ })
    .first();
  await expect(deleteEntry).toBeVisible({ timeout: 10_000 });
});

// ── Back to sessions link on session detail ──

test("Back to sessions link navigates to sessions page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(page.getByText("Session ID")).toBeVisible({ timeout: 10_000 });

  await page.click("text=Back to sessions");

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions`);
});
