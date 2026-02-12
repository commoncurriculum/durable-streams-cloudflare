import { test, expect, type Page } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const CORE_URL = process.env.CORE_URL!;
const PROJECT_ID = `sseflow-${Date.now()}`;
const STREAM_ID = "sse-test-stream";

async function waitForStreamConsole(page: Page, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const visible = await page
      .getByText("Live Event Log")
      .isVisible()
      .catch(() => false);
    if (visible) return;
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
  }
  await expect(page.getByText("Live Event Log")).toBeVisible({ timeout: 10_000 });
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();

  // Create project
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");
  await page.click('button:has-text("Create Project")');
  await page.waitForSelector("text=Create Project");
  const modal = page.locator(".fixed.inset-0");
  await modal.locator('input[placeholder="my-project"]').fill(PROJECT_ID);
  await modal.locator('button:has-text("Create"):not([disabled])').click();
  await page.waitForSelector("text=Save this signing secret", { timeout: 10_000 });
  await page.click('button:has-text("Done")');

  // Configure CORS
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");
  await page.locator('input[placeholder="https://example.com"]').fill("*");
  await page.click('button:has-text("Add")');
  await page.waitForTimeout(1000);

  // Create the stream
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);
  await page.waitForSelector('button:has-text("Create Stream")', { timeout: 10_000 });
  await page.locator("textarea").fill('{"setup":"init"}');
  await page.click('button:has-text("Create Stream")');
  await waitForStreamConsole(page);

  await page.close();
});

// ── SSE network request is actually made to core ──

test("stream detail page makes an SSE request to the core worker", async ({ page }) => {
  const sseRequestPromise = page.waitForRequest(
    (req) => req.url().includes("/v1/stream/") && req.url().includes(STREAM_ID),
    { timeout: 15_000 },
  );

  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);
  await waitForStreamConsole(page);

  const sseRequest = await sseRequestPromise;
  expect(sseRequest.url()).toContain(CORE_URL.replace("http://", ""));
});

// ── End-to-end SSE data flow: external publish appears in live event log ──

test("message published via API appears in live event log via SSE", async ({ browser }) => {
  // Tab 1: open stream detail, wait for SSE connection
  const tab1 = await browser.newPage();
  await tab1.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);
  await expect(tab1.getByText("SSE: connected").first()).toBeVisible({ timeout: 15_000 });

  // Publish a message directly via the admin API (simulating an external producer)
  const res = await fetch(`${ADMIN_URL}/api/streams/${PROJECT_ID}/${STREAM_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "external", msg: "sse-flow-test" }),
  });
  expect(res.status).toBe(204);

  // The message should appear in tab 1's live event log via SSE (not via polling)
  await expect(
    tab1.locator('[class*="bg-zinc-800"]').filter({ hasText: "sse-flow-test" }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await tab1.close();
});
