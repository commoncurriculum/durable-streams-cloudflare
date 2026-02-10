import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `nav-test-${Date.now()}`;

// Create a project so we can test project table links.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  await page.click('button:has-text("Create Project")');
  await page.waitForSelector("text=Create Project");
  const modal = page.locator(".fixed.inset-0");
  await modal.locator('input[placeholder="my-project"]').fill(PROJECT_ID);
  await modal.locator('button:has-text("Create"):not([disabled])').click();
  await page.waitForSelector("text=Save this signing secret", { timeout: 10_000 });
  await page.click('button:has-text("Done")');
  await page.close();
});

// ── System Overview nav link ──

test("System Overview nav link navigates to overview page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  await page.click("text=System Overview");

  await page.waitForURL("**/");
  await expect(page.getByText("Throughput")).toBeVisible({ timeout: 5_000 });
});

// ── Projects nav link ──

test("Projects nav link navigates to projects page", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  await page.click("text=Projects");

  await page.waitForURL("**/projects");
  await expect(page.locator('input[placeholder="Enter project ID..."]')).toBeVisible();
});

// ── Overview page renders ──

test("Overview page renders stat cards and tables", async ({ page }) => {
  await page.goto(ADMIN_URL);
  await page.waitForLoadState("networkidle");

  // Stat cards (may show "No data" or loading but should render labels)
  await expect(page.getByText("Appends / min")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Active Streams")).toBeVisible();

  // Table sections
  await expect(page.getByText("Hot Streams")).toBeVisible();
  await expect(page.getByText("All Streams")).toBeVisible();
});

// ── Project link in table ──

test("clicking a project in the table navigates to its detail page", async ({ page }) => {
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  // Wait for the project table to populate (the project we created in beforeAll)
  const projectLink = page.locator(`text=${PROJECT_ID}`).first();
  await expect(projectLink).toBeVisible({ timeout: 10_000 });

  await projectLink.click();

  await page.waitForURL(`**/projects/${PROJECT_ID}`);
  await expect(page.locator("main").getByRole("link", { name: "Overview" })).toBeVisible({ timeout: 5_000 });
});
