import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const CORE_URL = process.env.CORE_URL!;
const PROJECT_ID = `ssenet-${Date.now()}`;

let sessionId: string;

test.beforeAll(async ({ browser }) => {
  await createProject(browser, ADMIN_URL, PROJECT_ID);
  sessionId = await createSession(ADMIN_URL, PROJECT_ID);
});

// ── SSE network request is actually made ──

test("session detail page makes an SSE request to core worker", async ({ page }) => {
  // Listen for an outgoing request to the core worker's stream endpoint
  const sseRequestPromise = page.waitForRequest(
    (req) =>
      req.url().includes("/v1/stream/") && req.url().includes(sessionId),
    { timeout: 15_000 },
  );

  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);

  // The browser must actually make a network request to core for SSE
  const sseRequest = await sseRequestPromise;
  expect(sseRequest.url()).toContain(CORE_URL.replace("http://", ""));
});

// ── SSE badge reflects real connection state ──

test("session detail SSE badge shows connected after real network handshake", async ({ page }) => {
  // Intercept requests to detect the SSE connection attempt
  let sseRequestMade = false;
  page.on("request", (req) => {
    if (req.url().includes("/v1/stream/") && req.url().includes(sessionId)) {
      sseRequestMade = true;
    }
  });

  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);

  // Wait for the connected badge
  await expect(page.getByText("connected", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // The badge must reflect a REAL connection, not just static text
  expect(sseRequestMade).toBe(true);
});

// ── SSE connects even when token arrives after page render ──
// This simulates the production scenario where network latency causes the
// token and coreUrl server functions to resolve AFTER the component has mounted
// and the useEffect has already run once with token=undefined.
//
// Strategy: delay all _serverFn responses EXCEPT the one fetching session data
// (which contains the sessionId in the URL payload). This way:
//   1. inspectSession resolves immediately → enabled=true, component renders
//   2. getCoreStreamUrl / mintStreamToken are delayed → coreUrl=undefined, token=undefined
//   3. useEffect runs with enabled=true but token=undefined → bails out
//   4. After delay, token arrives → useEffect MUST re-run to connect SSE

test("SSE connects when token resolves after initial render", async ({ page }) => {
  await page.route("**/_serverFn/**", async (route) => {
    const decoded = decodeURIComponent(route.request().url());

    // Let the session inspect request through immediately (it includes the sessionId)
    if (decoded.includes(sessionId)) {
      await route.continue();
      return;
    }

    // Delay all other server functions (coreUrl, token) by 2s
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });

  // Track whether an SSE request is made
  let sseRequestMade = false;
  page.on("request", (req) => {
    if (req.url().includes("/v1/stream/") && req.url().includes(sessionId)) {
      sseRequestMade = true;
    }
  });

  await page.goto(`${ADMIN_URL}/projects/${PROJECT_ID}/sessions/${sessionId}`);

  // Session data should appear quickly (not delayed)
  await expect(page.getByText("Session ID")).toBeVisible({ timeout: 10_000 });

  // SSE should connect after the delayed token/coreUrl arrive
  await expect(page.getByText("connected", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  // Verify that the SSE network request was actually made
  expect(sseRequestMade).toBe(true);
});
