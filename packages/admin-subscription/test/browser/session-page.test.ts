import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `browser-test-${Date.now()}`;

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

test("SSE badge shows connected after creating a project and session", async ({
  page,
}) => {
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`,
  );

  const badge = page.getByText("connected", { exact: true });
  await expect(badge).toBeVisible({ timeout: 10_000 });
});

test("subscribe action message does not misleadingly show 200 OK", async ({
  page,
}) => {
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`,
  );

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
  const logEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "control" })
    .first();
  const logText = await logEntry.textContent();

  // The message should NOT contain "200 OK"
  expect(logText).not.toContain("200 OK");
});

test("publishing to a subscribed stream shows events in the session log", async ({
  page,
}) => {
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`,
  );

  // Wait for the page to load
  await page.waitForSelector('button:has-text("Subscribe")', { timeout: 10_000 });

  // Subscribe to the stream
  const streamInput = page.locator('input[placeholder="stream-id"]');
  await streamInput.fill("test-stream");
  await page.click('button:has-text("Subscribe")');

  // Wait for the control event from subscribe
  await page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "control" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Navigate to publish page
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await page.waitForLoadState("networkidle");

  // Fill in stream ID and body (publish page uses placeholder="my-stream")
  const publishStreamInput = page.locator('input[placeholder="my-stream"]');
  await publishStreamInput.fill("test-stream");
  const bodyTextarea = page.locator("textarea");
  await bodyTextarea.fill('{"hello":"browser-test"}');

  // Click Send to publish
  await page.click('button:has-text("Send")');

  // Wait for success
  await page.waitForSelector("text=Success", { timeout: 10_000 });

  // Navigate back to the session page
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`,
  );

  // Wait for a data event
  const dataEvent = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "data" })
    .first();
  await expect(dataEvent).toBeVisible({ timeout: 10_000 });

  // The event should contain our published message
  const eventText = await dataEvent.textContent();
  expect(eventText).toContain("browser-test");
});
