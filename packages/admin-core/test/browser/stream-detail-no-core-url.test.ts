import { test, expect, type Page } from "@playwright/test";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";

/**
 * Reproduces the production bug by running the admin worker WITHOUT
 * the CORE_URL env var, which is how production behaves if CORE_URL
 * doesn't make it to the client.
 *
 * Run with:
 *   pnpm -C packages/admin-core exec playwright test --config playwright.no-core-url.config.ts
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const CORE_ROOT = path.resolve(import.meta.dirname, "../../../core");
const PERSIST_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ds-no-core-url-test-"),
);

let corePort: number;
let adminPort: number;
let coreProc: ReturnType<typeof spawn>;
let adminProc: ReturnType<typeof spawn>;

const PROJECT_ID = `nocoreurl-${Date.now()}`;
const STREAM_ID = "sse-test";

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string")
        return server.close(() => reject(new Error("no port")));
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForReady(url: string, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

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
  // Build admin app
  execSync("pnpm exec vite build", { cwd: ROOT, stdio: "pipe" });

  // Patch wrangler.json for unique core worker name
  const CORE_WORKER_NAME = "ds-no-core-url-core";
  const wranglerJsonPath = path.join(ROOT, "dist/server/wrangler.json");
  const wranglerJson = JSON.parse(fs.readFileSync(wranglerJsonPath, "utf-8"));
  wranglerJson.services = wranglerJson.services.map(
    (s: { binding: string; service: string }) =>
      s.binding === "CORE" ? { ...s, service: CORE_WORKER_NAME } : s,
  );
  if (wranglerJson.kv_namespaces) {
    wranglerJson.kv_namespaces = wranglerJson.kv_namespaces.map(
      (ns: { binding: string; id: string }) =>
        ns.binding === "REGISTRY" ? { ...ns, id: "registry" } : ns,
    );
  }
  fs.writeFileSync(wranglerJsonPath, JSON.stringify(wranglerJson));

  // Start core worker
  corePort = await getAvailablePort();
  coreProc = spawn(
    "pnpm",
    [
      "exec", "wrangler", "dev", "--local",
      "--port", String(corePort),
      "--inspector-port", "0",
      "--show-interactive-dev-session=false",
      "--name", CORE_WORKER_NAME,
      "--persist-to", PERSIST_DIR,
    ],
    { cwd: CORE_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  await waitForReady(`http://localhost:${corePort}`);

  // Start admin worker WITHOUT --var CORE_URL
  // This is the key difference: production might not have CORE_URL
  // reaching the client even if it's set on the worker
  adminPort = await getAvailablePort();
  adminProc = spawn(
    "pnpm",
    [
      "exec", "wrangler", "dev", "--local",
      "--port", String(adminPort),
      "--inspector-port", "0",
      "--show-interactive-dev-session=false",
      "--config", "dist/server/wrangler.json",
      // NOTE: intentionally NOT passing --var CORE_URL
      "--persist-to", PERSIST_DIR,
    ],
    { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  await waitForReady(`http://localhost:${adminPort}`);

  // Create project + stream
  const page = await browser.newPage();

  await page.goto(`http://localhost:${adminPort}/projects`);
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

  // Configure CORS
  await page.goto(
    `http://localhost:${adminPort}/projects/${PROJECT_ID}/settings`,
  );
  await page.waitForLoadState("networkidle");
  await page.locator('input[placeholder="https://example.com"]').fill("*");
  await page.click('button:has-text("Add")');
  await page.waitForTimeout(1000);

  // Create stream
  await page.goto(
    `http://localhost:${adminPort}/projects/${PROJECT_ID}/streams/${STREAM_ID}`,
  );
  await page.waitForSelector('button:has-text("Create Stream")', {
    timeout: 10_000,
  });
  await page.locator("textarea").fill('{"setup":"init"}');
  await page.click('button:has-text("Create Stream")');
  await waitForStreamConsole(page);

  await page.close();
});

test.afterAll(async () => {
  try { coreProc?.kill("SIGTERM"); } catch { /* already dead */ }
  try { adminProc?.kill("SIGTERM"); } catch { /* already dead */ }
});

// ── The actual bug reproduction ──

test("without CORE_URL: SSE connection never opens", async ({ page }) => {
  const ADMIN_URL = `http://localhost:${adminPort}`;

  const allRequests: string[] = [];
  const consoleErrors: string[] = [];

  page.on("request", (req) => {
    allRequests.push(`${req.method()} ${req.url()}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`PAGE ERROR: ${err.message}`);
  });

  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`,
  );
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(8000);

  const sseRequests = allRequests.filter((r) => r.includes("/v1/stream/"));
  const serverFnRequests = allRequests.filter((r) => r.includes("_serverFn"));

  console.log("\n=== Server function requests ===");
  for (const r of serverFnRequests) console.log(r);

  console.log("\n=== SSE requests (to /v1/stream/) ===");
  if (sseRequests.length === 0) console.log("NONE — bug reproduced locally!");
  for (const r of sseRequests) console.log(r);

  console.log("\n=== Console errors ===");
  if (consoleErrors.length === 0) console.log("No errors (silent failure)");
  for (const e of consoleErrors) console.log(e);

  const sseStatus = await page
    .getByText("SSE:")
    .first()
    .innerText()
    .catch(() => "not found");
  console.log(`\n=== SSE badge: "${sseStatus}" ===`);

  // Check for error banner
  const errorBanner = await page
    .locator("text=SSE unavailable")
    .isVisible()
    .catch(() => false);
  console.log(`\n=== Error banner visible: ${errorBanner} ===`);

  // The badge should show "error" when CORE_URL is missing
  expect(
    sseStatus,
    "SSE badge should show 'SSE: error' when CORE_URL is not configured",
  ).toBe("SSE: error");

  // The error banner should be visible explaining the problem
  expect(
    errorBanner,
    "Error banner should be visible explaining that CORE_URL is not set",
  ).toBe(true);
});

test("without CORE_URL: page still renders stream metadata via service binding", async ({
  page,
}) => {
  const ADMIN_URL = `http://localhost:${adminPort}`;

  await page.goto(
    `${ADMIN_URL}/projects/${PROJECT_ID}/streams/${STREAM_ID}`,
  );
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000);

  // Server-side data should still work (service binding doesn't need CORE_URL)
  const hasConsole = await page
    .getByText("Live Event Log")
    .isVisible()
    .catch(() => false);

  const bodyText = await page.locator("body").innerText();
  console.log("\n=== Page content (first 1500 chars) ===");
  console.log(bodyText.slice(0, 1500));

  expect(
    hasConsole,
    "Stream console should still render — server functions use service binding, not CORE_URL",
  ).toBe(true);
});
