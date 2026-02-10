import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `ctfanout-${Date.now()}`;
const STREAM_ID = "json-stream";

let sessionId: string;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
  sessionId = await createSession(ADMIN_URL, PROJECT_ID);
});

test("JSON publish fans out to subscribed session", async ({ browser }) => {
  // ── Tab 1: subscribe to the stream ──
  const tab1 = await browser.newPage();
  await tab1.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(tab1.getByText("connected", { exact: true })).toBeVisible({ timeout: 15_000 });
  await tab1.waitForSelector('button:has-text("Subscribe")', { timeout: 10_000 });

  await tab1.locator('input[placeholder="stream-id"]').fill(STREAM_ID);
  await tab1.click('button:has-text("Subscribe")');
  await tab1
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "Subscribed" })
    .first()
    .waitFor({ timeout: 10_000 });

  // ── Tab 2: publish with application/json ──
  const tab2 = await browser.newPage();
  await tab2.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await tab2.waitForLoadState("networkidle");

  await tab2.locator('input[placeholder="my-stream"]').fill(STREAM_ID);
  await tab2.locator("textarea").fill('{"hello":"fanout test"}');
  await tab2.click('button:has-text("Send")');

  // Capture the full result message
  const resultEl = tab2.locator(".rounded-lg.border.px-4.py-3");
  await expect(resultEl).toBeVisible({ timeout: 15_000 });
  const resultText = await resultEl.textContent();
  console.log("Publish result:", resultText);

  // ── Back to Tab 1: verify the message arrived ──
  await expect(
    tab1.locator('[class*="bg-zinc-800"]').filter({ hasText: "fanout test" }).first(),
  ).toBeVisible({ timeout: 20_000 });

  await tab1.close();
  await tab2.close();
});
