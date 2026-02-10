import { test, expect, type Page } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `stlist-${Date.now()}`;
const STREAM_ID = "listed-stream";

async function waitForStreamConsole(page: Page, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const visible = await page.getByText("Live Event Log").isVisible().catch(() => false);
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

  // Create the stream via the stream detail page
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);
  await page.waitForSelector('button:has-text("Create Stream")', { timeout: 10_000 });
  await page.locator("textarea").fill('{"hello":"world"}');
  await page.click('button:has-text("Create Stream")');
  await waitForStreamConsole(page);

  await page.close();
});

// ── Created stream should appear in the streams list ──

test("created stream appears in the streams table for its project", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams`);
  await page.waitForLoadState("networkidle");

  // The stream we just created should appear in the table
  await expect(
    page.locator("main").locator(`text=${STREAM_ID}`).first(),
  ).toBeVisible({ timeout: 15_000 });
});
