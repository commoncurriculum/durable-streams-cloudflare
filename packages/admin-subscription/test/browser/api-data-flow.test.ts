import { test, expect } from "@playwright/test";
import { createProject, createSession } from "./helpers";

const ADMIN_URL = process.env.ADMIN_URL!;
const CORE_URL = process.env.CORE_URL!;
const PROJECT_ID = `apidf-${Date.now()}`;

let signingSecret: string;

test.beforeAll(async ({ browser }) => {
  signingSecret = await createProject(browser, ADMIN_URL, PROJECT_ID);
});

// ── Test 1: Session creation registers a stream on core ──

test("created session appears in session list via API", async () => {
  const sessionId = `sess-list-${Date.now()}`;
  await createSession(ADMIN_URL, PROJECT_ID, sessionId);

  const res = await fetch(`${ADMIN_URL}/api/projects/${PROJECT_ID}/sessions`);
  expect(res.status).toBe(200);

  const sessions = (await res.json()) as { sessionId: string; createdAt: number }[];
  const found = sessions.find((s) => s.sessionId === sessionId);
  expect(found).toBeDefined();
  expect(found!.createdAt).toBeGreaterThan(0);
});

// ── Test 2: Subscribe + publish + read session stream ──

test("published message is readable on the session stream via core", async () => {
  const sessionId = `sess-pub-${Date.now()}`;
  const streamId = "src-stream";
  const messageBody = JSON.stringify({ test: "api-data-flow", ts: Date.now() });

  // Create session
  await createSession(ADMIN_URL, PROJECT_ID, sessionId);

  // Subscribe session to source stream
  const subRes = await fetch(
    `${ADMIN_URL}/api/projects/${PROJECT_ID}/sessions/${sessionId}/subscribe`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamId }),
    },
  );
  expect(subRes.status).toBe(200);

  // Publish message to source stream
  const pubRes = await fetch(`${ADMIN_URL}/api/projects/${PROJECT_ID}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      streamId,
      body: messageBody,
      contentType: "application/json",
    }),
  });
  expect(pubRes.status).toBe(200);

  // Wait for fan-out to deliver to session stream
  await new Promise((r) => setTimeout(r, 3000));

  // Mint a token to read from core
  const tokenRes = await fetch(`${ADMIN_URL}/api/projects/${PROJECT_ID}/token`);
  expect(tokenRes.status).toBe(200);
  const { token } = (await tokenRes.json()) as { token: string };

  // Read the session's stream from core
  const readRes = await fetch(`${CORE_URL}/v1/stream/${PROJECT_ID}/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(readRes.status).toBe(200);

  const body = await readRes.text();
  expect(body).toContain("api-data-flow");
});

// ── Test 3: Minted JWT authenticates against core ──

test("minted JWT authenticates successfully against core", async () => {
  const sessionId = `sess-jwt-${Date.now()}`;
  await createSession(ADMIN_URL, PROJECT_ID, sessionId);

  // Mint token
  const tokenRes = await fetch(`${ADMIN_URL}/api/projects/${PROJECT_ID}/token`);
  expect(tokenRes.status).toBe(200);
  const { token, expiresAt } = (await tokenRes.json()) as {
    token: string;
    expiresAt: number;
  };
  expect(token).toBeTruthy();
  expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

  // Use JWT to read from core — should get 200 (not 401/403)
  const readRes = await fetch(`${CORE_URL}/v1/stream/${PROJECT_ID}/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(readRes.status).toBe(200);
});

// ── Test 4: Core stream exists after session creation ──

test("core stream exists after session creation", async () => {
  const sessionId = `sess-head-${Date.now()}`;
  await createSession(ADMIN_URL, PROJECT_ID, sessionId);

  // Mint token for auth
  const tokenRes = await fetch(`${ADMIN_URL}/api/projects/${PROJECT_ID}/token`);
  const { token } = (await tokenRes.json()) as { token: string };

  // HEAD the stream on core
  const headRes = await fetch(`${CORE_URL}/v1/stream/${PROJECT_ID}/${sessionId}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(headRes.status).toBe(200);
});
