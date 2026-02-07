import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `browser-test-${Date.now()}`;

let sessionId: string;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();

  // Create a project via the admin UI
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  // Click "+" button to open Create Project modal
  await page.click('button[title="Create Project"]');
  await page.waitForSelector("text=Create Project");

  // Fill project ID and create
  const projectInput = page.locator('input[placeholder="my-project"]');
  await projectInput.fill(PROJECT_ID);
  await page.click('button:has-text("Create"):not([disabled])');

  // Wait for the signing secret to appear (project created successfully)
  await page.waitForSelector("text=Save this signing secret", {
    timeout: 10_000,
  });

  // Click Done — navigates to /projects/{projectId}/sessions
  await page.click('button:has-text("Done")');
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions`);

  // Create a session
  await page.click('button:has-text("Create Session")');

  // Wait for navigation to session detail page
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`);
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

  // The SseStatusBadge renders the status as exact text in a <span>
  // Use exact matching to distinguish "connected" from "disconnected".
  // Don't use networkidle — the SSE connection keeps the network active.
  const badge = page.getByText("connected", { exact: true });
  await expect(badge).toBeVisible({ timeout: 10_000 });
});

test("subscribe action message does not misleadingly show 200 OK", async ({
  page,
}) => {
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`,
  );

  // Wait for the page to render the action buttons (SSE keeps network active)
  await page.waitForSelector('button:has-text("Send")', { timeout: 10_000 });

  // Subscribe is the default action. Fill in a stream ID.
  const streamInput = page.locator('input[placeholder="my-stream"]');
  await streamInput.fill("test-stream");

  // Click Send
  await page.click('button:has-text("Send")');

  // Wait for a control event to appear in the Live Event Log
  const controlBadge = page.locator("text=control").first();
  await expect(controlBadge).toBeVisible({ timeout: 10_000 });

  // Get the log entry text
  const logEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "control" })
    .first();
  const logText = await logEntry.textContent();

  // The message should NOT contain "200 OK" since that's misleading —
  // it makes it look like the SSE connection succeeded when actually
  // it's just the RPC call result
  expect(logText).not.toContain("200 OK");
});

test("publishing to a subscribed stream shows events in the session log", async ({
  page,
}) => {
  // Navigate to session page and subscribe to test-stream
  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`,
  );

  // Wait for the page to render (SSE keeps network active)
  await page.waitForSelector('button:has-text("Send")', { timeout: 10_000 });

  // Subscribe to the stream first
  const streamInput = page.locator('input[placeholder="my-stream"]');
  await streamInput.fill("test-stream");
  await page.click('button:has-text("Send")');

  // Wait for the control event from subscribe
  await page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "control" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Navigate to publish page
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/publish`);
  await page.waitForLoadState("networkidle");

  // Fill in stream ID and body
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

  // Wait up to 10s for a data event to appear in the log
  // Don't use networkidle — the SSE connection keeps the network active
  const dataEvent = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "data" })
    .first();
  await expect(dataEvent).toBeVisible({ timeout: 10_000 });

  // The event should contain our published message
  const eventText = await dataEvent.textContent();
  expect(eventText).toContain("browser-test");
});
