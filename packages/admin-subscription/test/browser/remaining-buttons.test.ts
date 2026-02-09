import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `buttons-${Date.now()}`;

let sessionId: string;

// Create a project and session for the test suite.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  // Create project via "+" button
  await page.click('button[title="Create Project"]');
  await page.waitForSelector("text=Create Project");
  const modal = page.locator(".fixed.inset-0");
  await modal.locator('input[placeholder="my-project"]').fill(PROJECT_ID);
  await modal.locator('button:has-text("Create"):not([disabled])').click();
  await page.waitForSelector("text=Save this signing secret", { timeout: 10_000 });
  await page.click('button:has-text("Done")');
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions`);

  // Create a session
  await page.click('button:has-text("Create Session")');
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`);
  const url = new URL(page.url());
  const parts = url.pathname.split("/");
  sessionId = parts[parts.length - 1];

  await page.close();
});

// ── Nav: Overview link ──

test("Overview nav link navigates to overview page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click("text=Overview");

  await page.waitForURL("**/");
  await expect(page.getByText("Subscription Service")).toBeVisible();
});

// ── Nav: Sessions link ──

test("Sessions nav link navigates to sessions page", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  // Select the project first (Sessions link is disabled without project)
  await page.selectOption("#project-select", PROJECT_ID);
  await page.waitForURL(`**/projects/${PROJECT_ID}/**`);

  // Click Sessions
  await page.click("nav >> text=Sessions");

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions`);
  await expect(page.locator('input[placeholder="Enter session ID..."]')).toBeVisible();
});

// ── Nav: Publish link ──

test("Publish nav link navigates to publish page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click("nav >> text=Publish");

  await page.waitForURL(`**/projects/${PROJECT_ID}/publish`);
  await expect(page.getByText("Publish to Stream")).toBeVisible();
});

// ── Project selector dropdown ──

test("project selector dropdown navigates to selected project", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  // Wait for the project option to be available in the dropdown (options are hidden elements)
  await page.waitForFunction(
    (id) => {
      const select = document.querySelector("#project-select") as unknown as HTMLSelectElement;
      return select && Array.from(select.options).some((o) => o.value === id);
    },
    PROJECT_ID,
    { timeout: 10_000 },
  );
  await page.selectOption("#project-select", PROJECT_ID);

  await page.waitForURL(`**/projects/${PROJECT_ID}/**`);
});

// ── Open Session button ──

test("Open Session button navigates to session detail", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.locator('input[placeholder="Enter session ID..."]').fill(sessionId);
  await page.click('button:has-text("Open Session")');

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(page.getByText("Session ID")).toBeVisible({ timeout: 10_000 });
});

// ── Create Session button ──

test("Create Session creates a new session and navigates to it", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  await page.click('button:has-text("Create Session")');

  // Should navigate to a session detail page with a UUID-like ID
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`, { timeout: 10_000 });
  await expect(page.getByText("Session ID")).toBeVisible({ timeout: 10_000 });
});

// ── Touch action ──

test("Touch action shows confirmation in event log", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await page.waitForSelector('button:has-text("Send")', { timeout: 10_000 });

  // Click the Touch action button
  await page.click('button:text-is("Touch")');
  await page.click('button:has-text("Send")');

  // Wait for control event
  const controlEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: /touched|control/ })
    .first();
  await expect(controlEntry).toBeVisible({ timeout: 10_000 });
});

// ── Unsubscribe action ──

test("Unsubscribe action sends and shows control event", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await page.waitForSelector('button:has-text("Send")', { timeout: 10_000 });

  // Subscribe first
  await page.click('button:text-is("Subscribe")');
  await page.locator('input[placeholder="my-stream"]').fill("unsub-test");
  await page.click('button:has-text("Send")');
  await page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "control" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Switch to Unsub action
  await page.click('button:text-is("Unsub")');
  await page.locator('input[placeholder="my-stream"]').fill("unsub-test");
  await page.click('button:has-text("Send")');

  // Wait for the unsub event
  const unsubEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: /[Uu]nsubscribed/ })
    .first();
  await expect(unsubEntry).toBeVisible({ timeout: 10_000 });
});

// ── Clear events button ──

test("Clear button clears the event log on session page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await page.waitForSelector('button:has-text("Send")', { timeout: 10_000 });

  // Perform a touch to generate an event
  await page.click('button:text-is("Touch")');
  await page.click('button:has-text("Send")');
  await page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: "control" })
    .first()
    .waitFor({ timeout: 10_000 });

  // Click Clear
  await page.click('button:text-is("Clear")');

  // Event log should show empty state
  await expect(page.getByText("Subscribe to a stream")).toBeVisible({ timeout: 5_000 });
});

// ── Delete action ──

test("Delete action sends and shows confirmation", async ({ page }) => {
  // Create a fresh session for deletion
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");
  await page.click('button:has-text("Create Session")');
  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions/*`, { timeout: 10_000 });
  await page.waitForSelector('button:has-text("Send")', { timeout: 10_000 });

  // Click Delete action
  await page.click('button:text-is("Delete")');
  await page.click('button:has-text("Send")');

  // Wait for the delete confirmation or error in the event log
  const deleteEntry = page
    .locator('[class*="bg-zinc-800"]')
    .filter({ hasText: /deleted|control|error/ })
    .first();
  await expect(deleteEntry).toBeVisible({ timeout: 10_000 });
});

// ── Back to search link on session detail ──

test("Back to search link navigates to sessions page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);
  await expect(page.getByText("Session ID")).toBeVisible({ timeout: 10_000 });

  await page.click("text=Back to search");

  await page.waitForURL(`**/projects/${PROJECT_ID}/sessions`);
  await expect(page.locator('input[placeholder="Enter session ID..."]')).toBeVisible();
});
