import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const CORE_URL = process.env.CORE_URL!;
const PROJECT_ID = `ssread-${Date.now()}`;
const STREAM_ID = "read-test-stream";

let sessionId: string;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
  sessionId = await createSession(ADMIN_URL, PROJECT_ID);
});

// ── Published message appears in the session's stream when read from core ──
// Flow:
//   1. Subscribe the session to a source stream
//   2. Publish a message to the source stream
//   3. Fan-out delivers the message to the session's stream on core
//   4. Reading the session's stream from core should return the message

test("published message is readable from the session's stream on core", async ({ browser }) => {
  // Tab 1: open session detail, subscribe to the source stream
  const tab1 = await browser.newPage();
  await tab1.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await tab1.waitForSelector('button:has-text("Subscribe")', { timeout: 10_000 });

  await tab1.locator('input[placeholder="stream-id"]').fill(STREAM_ID);
  await tab1.click('button:has-text("Subscribe")');
  await tab1
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "Subscribed" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Tab 2: publish a message to the source stream
  const tab2 = await browser.newPage();
  await tab2.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await tab2.waitForLoadState("networkidle");

  await tab2.locator('input[placeholder="my-stream"]').fill(STREAM_ID);
  await tab2.locator("textarea").fill('{"test":"session-stream-read"}');
  await tab2.click('button:has-text("Send")');
  await tab2.waitForSelector("text=Success", { timeout: 10_000 });

  // Give fan-out a moment to deliver
  await tab2.waitForTimeout(2000);

  // Go back to tab 1 — the session detail page should have a way to
  // fetch the session's stream content (like admin-core's "Fetch Earlier Messages")
  const fetchBtn = tab1.locator('button:has-text("Fetch Earlier Messages")');
  await expect(fetchBtn).toBeVisible({ timeout: 5_000 });
  await fetchBtn.click();

  // The published message should appear in the event log
  await expect(
    tab1.locator('[class*="bg-zinc-800"]').filter({ hasText: "session-stream-read" }).first(),
  ).toBeVisible({ timeout: 10_000 });

  await tab1.close();
  await tab2.close();
});
