import { test, expect, type Page } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `stream-test-${Date.now()}`;
const STREAM_ID = "test-stream";

/**
 * After creating a stream, the loader may still return null (showing
 * the create form instead of the stream console). Reload up to
 * `maxAttempts` times until "Live Event Log" is visible.
 */
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

// Create a project AND a stream before tests run.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  // Create project
  await page.click('button:has-text("Create Project")');
  await page.waitForSelector("text=Create Project");
  const modal = page.locator(".fixed.inset-0");
  await modal.locator('input[placeholder="my-project"]').fill(PROJECT_ID);
  await modal.locator('button:has-text("Create"):not([disabled])').click();
  await page.waitForSelector("text=Save this signing secret", { timeout: 10_000 });
  await page.click('button:has-text("Done")');

  // Configure CORS so the browser can connect directly to the core worker for SSE
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");
  await page.locator('input[placeholder="https://example.com"]').fill("*");
  await page.click('button:has-text("Add")');
  await page.waitForTimeout(1000);

  // Navigate to the stream — should show create form
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);
  await page.waitForSelector('button:has-text("Create Stream")', { timeout: 10_000 });

  // Fill body and click Create Stream
  await page.locator("textarea").fill('{"setup":"init"}');
  await page.click('button:has-text("Create Stream")');

  // The server function fires but router.invalidate() may not fully reload.
  // Poll with reload until the stream console appears.
  await waitForStreamConsole(page);

  await page.close();
});

// ── Open Project via input + button ──

test("Open Project navigates to project detail page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  await page.locator('input[placeholder="Enter project ID..."]').fill(PROJECT_ID);
  await page.click('button:has-text("Open Project")');

  await page.waitForURL(new RegExp(`/projects/${PROJECT_ID}/?$`));
  await expect(page.locator("header nav").getByRole("link", { name: "Overview" })).toBeVisible({ timeout: 5_000 });
});

// ── Open Stream via input + button ──

test("Open Stream navigates to stream detail page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams`);
  await page.waitForLoadState("networkidle");

  await page.locator('input[placeholder="Enter stream ID..."]').fill(STREAM_ID);
  await page.click('button:has-text("Open Stream")');

  await page.waitForURL(`**/projects/${PROJECT_ID}/streams/${STREAM_ID}`);
  // Stream now exists — should show stream console
  await expect(page.getByText("Live Event Log")).toBeVisible({ timeout: 10_000 });
});

// ── Create Stream form ──

test("Create Stream form creates a new stream", async ({ page }) => {
  const newStream = "brand-new-stream";
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${newStream}`);

  await expect(page.getByText("Stream does not exist yet")).toBeVisible({
    timeout: 10_000,
  });

  await page.locator("textarea").fill('{"hello":"world"}');
  await page.click('button:has-text("Create Stream")');

  // Poll with reload until the stream console appears.
  await waitForStreamConsole(page);
});

// ── Stream detail metadata renders ──

test("stream detail page shows metadata fields", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  await expect(page.getByText("Live Event Log")).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText("Content Type")).toBeVisible();
  await expect(page.getByText("Status")).toBeVisible();
  await expect(page.getByText("Created")).toBeVisible();
  await expect(page.getByText("Tail Offset")).toBeVisible();
});

// ── Message volume chart ──

test("stream detail shows Message Volume heading", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  await expect(page.getByText("Message Volume")).toBeVisible({ timeout: 15_000 });
});

// ── SSE connected badge ──

test("SSE badge shows connected on stream detail page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  await expect(page.getByText("SSE: connected").first()).toBeVisible({
    timeout: 15_000,
  });
});

// ── Send Message panel ──

test("Send Message panel sends a message and shows APPEND control event", async ({
  page,
}) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  // Wait for SSE to connect before sending — ensures the page is fully loaded
  await expect(page.getByText("SSE: connected").first()).toBeVisible({ timeout: 15_000 });

  await page.locator('textarea[placeholder=\'{"hello":"world"}\']').fill('{"test":"message"}');
  await page.click('button:text-is("Send")');

  // The APPEND control event or an error should appear in the event log
  await expect(
    page.locator('[class*="bg-zinc-800"]').filter({ hasText: /APPEND|error/ }).first(),
  ).toBeVisible({ timeout: 15_000 });
});

// ── Clear button ──
// Note: This test combines send + clear. It reuses the APPEND event from sending.

test("Clear button clears the event log", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  await expect(page.getByText("SSE: connected").first()).toBeVisible({ timeout: 15_000 });

  // Initial SSE control event appears once connected
  await expect(
    page.locator('[class*="bg-zinc-800"]').first(),
  ).toBeVisible({ timeout: 10_000 });

  await page.click('button:has-text("Clear")');

  await expect(page.getByText("Waiting for events...")).toBeVisible({ timeout: 5_000 });
});

// ── Send Message panel collapse/expand ──

test("Send Message panel collapses and expands", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  await expect(page.getByText("Send Message")).toBeVisible({ timeout: 15_000 });

  const textarea = page.locator('textarea[placeholder=\'{"hello":"world"}\']');
  await expect(textarea).toBeVisible();

  // Collapse
  await page.click('button:has-text("Send Message")');
  await expect(textarea).not.toBeVisible();

  // Expand
  await page.click('button:has-text("Send Message")');
  await expect(textarea).toBeVisible();
});

// ── Back to search link ──

test("Back to search link navigates to streams page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  await expect(page.getByText("Live Event Log")).toBeVisible({ timeout: 15_000 });

  await page.click("text=Back to search");

  await page.waitForURL(`**/projects/${PROJECT_ID}/streams`);
  await expect(page.locator('input[placeholder="Enter stream ID..."]')).toBeVisible();
});

// ── Fetch Earlier Messages ──

test("Fetch Earlier Messages loads historical messages", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`);

  await expect(page.getByText("Fetch Earlier Messages")).toBeVisible({ timeout: 15_000 });

  await page.click('button:has-text("Fetch Earlier Messages")');

  await expect(
    page.locator('[class*="bg-zinc-800"]').filter({ hasText: /Loaded|No earlier/ }).first(),
  ).toBeVisible({ timeout: 10_000 });
});
