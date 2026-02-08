import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";

const ROOT = path.resolve(__dirname, "..");
const CORE_ROOT = path.resolve(__dirname, "../../core");

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

const PROJECT_ID = "test-project";

describe("admin-core integration", () => {
  let coreProc: ChildProcess;
  let adminProc: ChildProcess;
  let coreUrl: string;
  let adminUrl: string;

  beforeAll(async () => {
    // Build the admin worker
    execSync("pnpm exec vite build", { cwd: ROOT, stdio: "pipe" });

    // Start core worker
    const corePort = await getAvailablePort();
    coreUrl = `http://localhost:${corePort}`;
    coreProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(corePort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
        "--config", "wrangler.test.toml",
      ],
      { cwd: CORE_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(coreUrl);

    // Start admin worker (built output, wrangler resolves CORE service binding to running core)
    const adminPort = await getAvailablePort();
    adminUrl = `http://localhost:${adminPort}`;
    adminProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(adminPort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
        "--config", "dist/server/wrangler.json",
      ],
      { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(adminUrl);
  }, 90_000);

  afterAll(async () => {
    if (adminProc && !adminProc.killed) {
      adminProc.kill("SIGTERM");
      await once(adminProc, "exit").catch(() => {});
    }
    if (coreProc && !coreProc.killed) {
      coreProc.kill("SIGTERM");
      await once(coreProc, "exit").catch(() => {});
    }
  });

  // ── Overview page ──

  it("GET / renders the overview page with dashboard title", async () => {
    const res = await fetch(adminUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Durable Streams");
    expect(html).toContain("Overview");
    expect(html).toContain("Projects");
  });

  // ── Create stream via core API ──

  it("can create a stream through the core API", async () => {
    const streamId = `integration-test-${Date.now()}`;

    const res = await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(201);

    // Now verify the stream detail page renders via admin
    const detailRes = await fetch(
      `${adminUrl}/projects/${PROJECT_ID}/streams/${encodeURIComponent(streamId)}`,
    );
    expect(detailRes.status).toBe(200);
    const html = await detailRes.text();
    // The child route should render (not just the search box)
    expect(html).not.toContain("Enter a stream ID to open or create");
  });

  // ── Append to stream ──

  it("can append messages and see them in the stream", async () => {
    const streamId = `integration-append-${Date.now()}`;

    // Create stream
    const createRes = await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init: true }),
    });
    expect(createRes.status).toBe(201);

    // Append messages
    for (let i = 0; i < 3; i++) {
      const appendRes = await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq: i, data: `message-${i}` }),
      });
      expect([200, 204]).toContain(appendRes.status);
    }

    // Read back via core and verify messages
    const readRes = await fetch(
      `${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}?offset=0000000000000000_0000000000000000`,
    );
    expect(readRes.status).toBe(200);
    const body = await readRes.text();
    expect(body).toContain("message-0");
    expect(body).toContain("message-1");
    expect(body).toContain("message-2");
  });

  // ── Stream detail page shows metadata ──

  it("stream detail page shows metadata for a real stream", async () => {
    const streamId = `integration-inspect-${Date.now()}`;

    // Create with specific content type
    await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });

    // Append a message so there's data
    await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 42 }),
    });

    // Load the stream detail page via admin
    const res = await fetch(
      `${adminUrl}/projects/${PROJECT_ID}/streams/${encodeURIComponent(streamId)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should render the child route with stream details
    expect(html).not.toContain("Enter a stream ID to open or create");
  });

  // ── SSE proxy ──

  it("SSE proxy connects to core and streams events", async () => {
    const streamId = `integration-sse-${Date.now()}`;

    // Create the stream first
    await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init: true }),
    });

    // Connect SSE through the admin proxy (now project-scoped)
    const controller = new AbortController();
    const sseRes = await fetch(
      `${adminUrl}/api/sse/${encodeURIComponent(PROJECT_ID)}/${encodeURIComponent(streamId)}?live=sse&offset=now`,
      { signal: controller.signal },
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // Append a message while SSE is connected
    await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ live: "event" }),
    });

    // Read from the SSE stream
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    const readDeadline = Date.now() + 10_000;

    while (Date.now() < readDeadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 500),
        ),
      ]);
      if (done && Date.now() >= readDeadline) break;
      if (value) collected += decoder.decode(value, { stream: true });
      if (collected.includes("live")) break;
    }

    controller.abort();
    expect(collected).toContain("live");
  }, 15_000);

  // ── Read messages from a stream ──

  it("can read messages back from a created stream", async () => {
    const streamId = `integration-read-${Date.now()}`;

    // Create and append
    await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ first: true }),
    });

    for (let i = 0; i < 3; i++) {
      await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg: i }),
      });
    }

    // Read back from core (catch-up mode)
    const readRes = await fetch(
      `${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}?offset=0000000000000000_0000000000000000`,
    );
    expect(readRes.status).toBe(200);
    const body = await readRes.text();
    expect(body).toContain('"msg":0');
    expect(body).toContain('"msg":1');
    expect(body).toContain('"msg":2');

    // Verify the stream detail page also works for this stream
    const detailRes = await fetch(
      `${adminUrl}/projects/${PROJECT_ID}/streams/${encodeURIComponent(streamId)}`,
    );
    expect(detailRes.status).toBe(200);
    const html = await detailRes.text();
    expect(html).not.toContain("Enter a stream ID to open or create");
  });
});
