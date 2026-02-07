import { test, expect } from "@playwright/test";

const ADMIN_URL = process.env.ADMIN_URL!;
const PROJECT_ID = `browser-test-${Date.now()}`;

test("can create a project via the Create Project modal", async ({ page }) => {
  // Navigate to projects page
  await page.goto(`${ADMIN_URL}/projects`);
  await page.waitForLoadState("networkidle");

  // Click "Create Project" button to open the modal
  await page.click('button:has-text("Create Project")');
  await page.waitForSelector("text=Create Project");

  // Fill project ID and click the Create button inside the modal
  const modal = page.locator('.fixed.inset-0');
  const projectInput = modal.locator('input[placeholder="my-project"]');
  await projectInput.fill(PROJECT_ID);
  await modal.locator('button:has-text("Create"):not([disabled])').click();

  // Wait for the signing secret to appear (project created successfully)
  await page.waitForSelector("text=Save this signing secret", {
    timeout: 10_000,
  });

  // The secret should be displayed
  const secretEl = page.locator("code").first();
  const secret = await secretEl.textContent();
  expect(secret).toBeTruthy();
  expect(secret!.length).toBeGreaterThan(10);

  // Click Done to close modal
  await page.click('button:has-text("Done")');

  // The project should now appear in the projects list
  await expect(page.getByText(PROJECT_ID)).toBeVisible({ timeout: 5_000 });
});
