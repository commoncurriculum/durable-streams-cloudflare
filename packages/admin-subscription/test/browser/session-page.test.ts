import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `browser-test-${Date.now()}`;

let sessionId: string;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
  sessionId = await createSession(ADMIN_URL, PROJECT_ID);
});

test("SSE badge shows connected after creating a project and session", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);

  const badge = page.getByText("connected", { exact: true });
  await expect(badge).toBeVisible({ timeout: 10_000 });
});

test("subscribe action message does not misleadingly show 200 OK", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);

  // Wait for page to load
  await page.waitForSelector('button:has-text("Subscribe")', { timeout: 10_000 });

  // Fill stream ID and subscribe
  const streamInput = page.locator('input[placeholder="stream-id"]');
  await streamInput.fill("test-stream");
  await page.click('button:has-text("Subscribe")');

  // Wait for a control event to appear in the Live Event Log
  const controlBadge = page.locator("text=control").first();
  await expect(controlBadge).toBeVisible({ timeout: 10_000 });

  // Get the log entry text
  const logEntry = page.locator('[class*="bg-zinc-800"]').filter({ hasText: "control" }).first();
  const logText = await logEntry.textContent();

  // The message should NOT contain "200 OK"
  expect(logText).not.toContain("200 OK");
});

test("publishing to a subscribed stream shows events in the session log", async ({ browser }) => {
  // Use a completely fresh session to avoid state contamination from previous tests.
  // The subscribe action can hang when a session already has prior subscriptions and
  // SSE event history (replayed on connect) from earlier test runs.
  const freshSessionId = await createSession(ADMIN_URL, PROJECT_ID);
  const STREAM = `publish-test-${Date.now()}`;

  // Keep session page open (Tab 1) with SSE running while publishing from Tab 2.
  const sessionPage = await browser.newPage();
  await sessionPage.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${freshSessionId}`);

  // Wait for SSE to connect
  await expect(sessionPage.getByText("connected", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await sessionPage.waitForSelector('button:has-text("Subscribe")', { timeout: 10_000 });

  // Subscribe to the stream
  const streamInput = sessionPage.locator('input[placeholder="stream-id"]');
  await streamInput.fill(STREAM);
  await sessionPage.click('button:has-text("Subscribe")');

  // Wait for the subscribe RPC to complete. The client-side "Subscribed to X" control
  // event fires right after adminSubscribe returns, proving the subscription is stored
  // in SubscriptionDO's SQLite and ready for fan-out.
  await expect(
    sessionPage
      .locator('[class*="bg-zinc-800"]')
      .filter({ hasText: `Subscribed to ${STREAM}` })
      .first(),
  ).toBeVisible({ timeout: 15_000 });

  // Publish from a second tab (keeps SSE alive on Tab 1)
  const publishPage = await browser.newPage();
  await publishPage.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await publishPage.waitForLoadState("networkidle");

  await publishPage.locator('input[placeholder="my-stream"]').fill(STREAM);
  await publishPage.locator("textarea").fill('{"hello":"browser-test"}');
  await publishPage.click('button:has-text("Send")');
  await publishPage.waitForSelector("text=Success", { timeout: 10_000 });

  // Back to Tab 1: the data event should appear via the still-active SSE connection
  const dataEvent = sessionPage
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "browser-test" })
    .first();
  await expect(dataEvent).toBeVisible({ timeout: 10_000 });

  await sessionPage.close();
  await publishPage.close();
});
