import { test, expect, type Page } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const CORE_URL = process.env.CORE_URL!;
const PROJECT_ID = `sdfetch-${Date.now()}`;
const STREAM_ID = "detail-fetch-stream";

/**
 * Reproduces the production bug: navigating to
 *   /projects/<project>/streams/<stream>
 * does NOT issue any request to the core worker's stream endpoint.
 *
 * The test creates a project+stream in beforeAll, then navigates
 * directly to the stream detail URL and asserts that at least one
 * network request is made to the core worker for that stream.
 */

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
  await expect(page.getByText("Live Event Log")).toBeVisible({
    timeout: 10_000,
  });
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
  await page.waitForSelector("text=Save this signing secret", {
    timeout: 10_000,
  });
  await page.click('button:has-text("Done")');

  // Configure CORS so browser can connect to core for SSE
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/settings`);
  await page.waitForLoadState("networkidle");
  await page.locator('input[placeholder="https://example.com"]').fill("*");
  await page.click('button:has-text("Add")');
  await page.waitForTimeout(1000);

  // Create the stream
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`,
  );
  await page.waitForSelector('button:has-text("Create Stream")', {
    timeout: 10_000,
  });
  await page.locator("textarea").fill('{"setup":"init"}');
  await page.click('button:has-text("Create Stream")');
  await waitForStreamConsole(page);

  await page.close();
});

// ── The actual bug reproduction ──

test("navigating directly to stream detail URL fetches stream data from core", async ({
  page,
}) => {
  // Collect ALL network requests to core that mention this stream
  const coreStreamRequests: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes(STREAM_ID)) {
      coreStreamRequests.push(`${req.method()} ${url}`);
    }
  });

  // Navigate directly to the stream detail page — this is what the user does
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`,
  );

  // Don't use networkidle — SSE keeps the connection open forever.
  // Wait for DOM to be ready, then give requests time to fire.
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000);

  // THE BUG: no request to core for this stream was ever made.
  // This assertion should pass in a working system but will FAIL
  // if the page doesn't fetch stream data.
  expect(
    coreStreamRequests.length,
    `Expected at least one network request to core containing "${STREAM_ID}", ` +
      `but found none. The stream detail page is not fetching stream data.\n` +
      `Core URL: ${CORE_URL}`,
  ).toBeGreaterThan(0);

  // Log what we captured for debugging
  console.log("Captured core stream requests:", coreStreamRequests);
});

test("stream detail page loads stream metadata (not just the create form)", async ({
  page,
}) => {
  // Navigate directly — same as production scenario
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`,
  );

  // The stream was already created in beforeAll. The page should show
  // the stream console, NOT the "Stream does not exist yet" create form.
  // If it shows the create form, that means the page never fetched the
  // stream from core to determine it exists.

  // Wait up to 15s for either "Live Event Log" (correct) or
  // "Stream does not exist yet" (the bug)
  const result = await Promise.race([
    page
      .getByText("Live Event Log")
      .waitFor({ timeout: 15_000 })
      .then(() => "console" as const),
    page
      .getByText("Stream does not exist yet")
      .waitFor({ timeout: 15_000 })
      .then(() => "create-form" as const),
  ]);

  expect(
    result,
    'Stream detail page showed the create form instead of the stream console. ' +
      'This means the page did not fetch stream data from core to check if it exists.',
  ).toBe("console");
});

test("stream detail page makes an SSE connection to core for live events", async ({
  page,
}) => {
  // Track EventSource / SSE requests specifically
  const sseRequests: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    // SSE requests contain the stream path and use GET with Accept: text/event-stream
    if (url.includes(STREAM_ID) && url.includes("/v1/stream/")) {
      sseRequests.push(`${req.method()} ${url}`);
    }
  });

  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`,
  );

  // Wait for SSE badge or give it ample time
  try {
    await expect(page.getByText("SSE: connected").first()).toBeVisible({
      timeout: 15_000,
    });
  } catch {
    // Even if the badge doesn't appear, check if the request was made
  }

  expect(
    sseRequests.length,
    `Expected an SSE request to core at /v1/stream/ for "${STREAM_ID}", ` +
      `but none was made. The page is not connecting to the SSE endpoint.\n` +
      `Core URL: ${CORE_URL}`,
  ).toBeGreaterThan(0);

  console.log("Captured SSE requests:", sseRequests);
});
