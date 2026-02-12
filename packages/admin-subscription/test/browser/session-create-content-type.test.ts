import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `ct-create-${Date.now()}`;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
});

test("session created via Create Session button has application/json content-type", async ({
  page,
}) => {
  // Navigate to sessions list
  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions`);
  await page.waitForLoadState("networkidle");

  // Click the Create Session button
  await page.click('button:has-text("Create Session")');

  // Wait for navigation to the session detail page
  await page.waitForURL(/\/sessions\/[a-f0-9-]+$/, { timeout: 15_000 });

  // Extract session ID from the URL
  const url = page.url();
  const sessionId = url.split("/sessions/")[1];

  // Fetch the session detail API and assert content-type
  const res = await fetch(`${ADMIN_URL}/api/projects/${PROJECT_ID}/sessions/${sessionId}`);
  expect(res.ok).toBe(true);

  const data = (await res.json()) as { contentType?: string };
  expect(data.contentType).toBe("application/json");
});
