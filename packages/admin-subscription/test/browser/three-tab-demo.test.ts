import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `demo-${Date.now()}`;

let sessionId: string;

// Create a project and session before the three-tab tests run.
test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
  sessionId = await createSession(ADMIN_URL, PROJECT_ID);
});

// ---------------------------------------------------------------------------
// Three-tab demo:
//   Tab 1  — session detail page, subscribes to TWO streams, watches live log
//   Tab 2  — publish page, sends a message to stream A
//   Tab 3  — publish page, sends a message to stream B
//   Tab 1  — verifies both messages appear in the live event log
// ---------------------------------------------------------------------------

test("Tab 1 subscribes to two streams, Tabs 2+3 publish, Tab 1 sees both events", async ({
  browser,
}) => {
  // ── Tab 1: open session detail page ──
  const tab1 = await browser.newPage();
  await tab1.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);

  // Wait for SSE to connect
  await expect(tab1.getByText("connected", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // Wait for the subscribe form
  await tab1.waitForSelector('button:has-text("Subscribe")', { timeout: 10_000 });

  // Subscribe to stream A
  const streamInput = tab1.locator('input[placeholder="stream-id"]');
  await streamInput.fill("demo-stream-a");
  await tab1.click('button:has-text("Subscribe")');

  // Wait for "Subscribed to demo-stream-a" control event
  await tab1
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "Subscribed" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Subscribe to stream B
  await streamInput.clear();
  await streamInput.fill("demo-stream-b");
  await tab1.click('button:has-text("Subscribe")');

  // Wait for the second subscribe control event
  await expect(
    tab1.locator('[class*="bg-zinc-800"]').filter({ hasText: "Subscribed" }),
  ).toHaveCount(2, { timeout: 10_000 });

  // ── Tab 2: publish to stream A ──
  const tab2 = await browser.newPage();
  await tab2.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await tab2.waitForLoadState("networkidle");

  await tab2.locator('input[placeholder="my-stream"]').fill("demo-stream-a");
  await tab2.locator("textarea").fill('{"from":"tab2","msg":"hello from publisher A"}');
  await tab2.click('button:has-text("Send")');
  await tab2.waitForSelector("text=Success", { timeout: 10_000 });

  // ── Tab 3: publish to stream B ──
  const tab3 = await browser.newPage();
  await tab3.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await tab3.waitForLoadState("networkidle");

  await tab3.locator('input[placeholder="my-stream"]').fill("demo-stream-b");
  await tab3.locator("textarea").fill('{"from":"tab3","msg":"hello from publisher B"}');
  await tab3.click('button:has-text("Send")');
  await tab3.waitForSelector("text=Success", { timeout: 10_000 });

  // ── Back to Tab 1: verify both data events arrived via SSE ──
  const logArea = tab1.locator('[class*="bg-zinc-800"]');

  // Wait for the message from Tab 2 (publisher A)
  await expect(logArea.filter({ hasText: "tab2" }).first()).toBeVisible({ timeout: 15_000 });

  // Wait for the message from Tab 3 (publisher B)
  await expect(logArea.filter({ hasText: "tab3" }).first()).toBeVisible({ timeout: 15_000 });

  // Verify both data badges are present (not just control events)
  const dataEntries = logArea.filter({ hasText: "data" });
  await expect(dataEntries).toHaveCount(2, { timeout: 5_000 });

  // Verify the full message content is rendered
  const allText = await logArea.allTextContents();
  const combined = allText.join("\n");
  expect(combined).toContain("hello from publisher A");
  expect(combined).toContain("hello from publisher B");

  await tab1.close();
  await tab2.close();
  await tab3.close();
});

test("Tab 1 SSE stays connected while other tabs publish", async ({ browser }) => {
  const tab1 = await browser.newPage();
  await tab1.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);

  // SSE should be connected (session was subscribed in previous test)
  await expect(tab1.getByText("connected", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // Publish from a second tab
  const tab2 = await browser.newPage();
  await tab2.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await tab2.waitForLoadState("networkidle");

  await tab2.locator('input[placeholder="my-stream"]').fill("demo-stream-a");
  await tab2.locator("textarea").fill('{"keepalive":"check"}');
  await tab2.click('button:has-text("Send")');
  await tab2.waitForSelector("text=Success", { timeout: 10_000 });

  // Tab 1 SSE should still be connected
  await expect(tab1.getByText("connected", { exact: true })).toBeVisible();

  // And the message should appear
  await expect(
    tab1.locator('[class*="bg-zinc-800"]').filter({ hasText: "keepalive" }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await tab1.close();
  await tab2.close();
});
