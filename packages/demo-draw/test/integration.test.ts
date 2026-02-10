import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";

const ROOT = path.resolve(__dirname, "..");
const CORE_ROOT = path.resolve(__dirname, "../../core");

const CORE_WORKER_NAME = "ds-demo-draw-test-core";
const SIGNING_SECRET = "test-secret-for-demo-draw";
const PROJECT_ID = "demo-drawing";

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
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

describe("demo-draw integration", () => {
  let coreProc: ChildProcess;
  let demoProc: ChildProcess;
  let coreUrl: string;
  let demoUrl: string;

  beforeAll(async () => {
    // Build demo-draw
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
        "--name", CORE_WORKER_NAME,
      ],
      { cwd: CORE_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(coreUrl);

    // Start demo-draw worker, overriding CORE_URL to point at our test core
    const demoPort = await getAvailablePort();
    demoUrl = `http://localhost:${demoPort}`;
    demoProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(demoPort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
        "--config", "dist/server/wrangler.json",
        "--var", `CORE_URL:${coreUrl}`,
        "--var", `PROJECT_ID:${PROJECT_ID}`,
        "--var", `SIGNING_SECRET:${SIGNING_SECRET}`,
      ],
      { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(demoUrl);
  }, 90_000);

  afterAll(async () => {
    if (demoProc && !demoProc.killed) {
      demoProc.kill("SIGTERM");
      await once(demoProc, "exit").catch(() => {});
    }
    if (coreProc && !coreProc.killed) {
      coreProc.kill("SIGTERM");
      await once(coreProc, "exit").catch(() => {});
    }
  });

  // ── SSR pages ──

  it("GET / returns landing page with Create Room button", async () => {
    const res = await fetch(demoUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Draw Together");
    expect(html).toContain("Create Room");
  });

  it("GET /room/$roomId returns the drawing room page", async () => {
    const res = await fetch(`${demoUrl}/room/test-room-1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("test-room-1");
    expect(html).toContain("Copy Link");
  });

  // ── Proxy: browser talks to demo-draw, which proxies to core ──

  it("PUT through demo proxy creates a stream on core", async () => {
    const streamId = `proxy-put-${Date.now()}`;
    const res = await fetch(
      `${demoUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stroke", userId: "test", points: [[0, 0, 0.5]], color: "#000", width: 8 }),
      },
    );
    expect(res.status).toBe(201);

    // Verify it exists on core
    const headRes = await fetch(`${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
  });

  it("POST through demo proxy appends to a stream on core", async () => {
    const streamId = `proxy-post-${Date.now()}`;
    // Create via proxy
    await fetch(`${demoUrl}/v1/stream/${PROJECT_ID}/${streamId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#000", width: 8 }),
    });
    // Append via proxy
    const appendRes = await fetch(`${demoUrl}/v1/stream/${PROJECT_ID}/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[10, 10, 0.5]], color: "#EF4444", width: 4 }),
    });
    expect([200, 204]).toContain(appendRes.status);

    // Read from core to verify
    const readRes = await fetch(`${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}?offset=-1`);
    const body = await readRes.text();
    expect(body).toContain("#EF4444");
  });

  // ── Two clients syncing through the demo proxy ──

  it("client B sees strokes that client A appends (catch-up replay)", async () => {
    const streamId = `sync-catchup-${Date.now()}`;
    const writeUrl = `${demoUrl}/v1/stream/${PROJECT_ID}/${streamId}`;
    const readUrl = `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`;

    // Client A creates the stream and appends 3 strokes via demo proxy
    await fetch(writeUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#EF4444", width: 8 }),
    });
    await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[10, 10, 0.5]], color: "#22C55E", width: 4 }),
    });
    await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[20, 20, 0.5]], color: "#3B82F6", width: 12 }),
    });

    // Client B reads directly from core (streams are public, reads bypass proxy)
    const readRes = await fetch(`${readUrl}?offset=-1`);
    expect(readRes.status).toBe(200);
    const body = await readRes.text();
    expect(body).toContain("#EF4444");
    expect(body).toContain("#22C55E");
    expect(body).toContain("#3B82F6");
  });

  it("client B receives client A's stroke in real-time via SSE", async () => {
    const streamId = `sync-live-${Date.now()}`;
    const writeUrl = `${demoUrl}/v1/stream/${PROJECT_ID}/${streamId}`;
    const readUrl = `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`;

    // Create the stream via proxy
    await fetch(writeUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#000", width: 8 }),
    });

    // Client B connects via SSE directly to core (streams are public)
    const controller = new AbortController();
    const sseRes = await fetch(`${readUrl}?live=sse&offset=now`, {
      signal: controller.signal,
    });
    expect(sseRes.status).toBe(200);

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    const deadline = Date.now() + 15_000;

    // Wait for SSE connection to be established (upToDate event)
    while (Date.now() < deadline && !collected.includes("upToDate")) {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 500),
        ),
      ]);
      if (value) collected += decoder.decode(value, { stream: true });
    }
    expect(collected).toContain("upToDate");

    // Client A appends a new stroke via proxy
    await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[99, 99, 1.0]], color: "#EC4899", width: 6 }),
    });

    // Client B should receive it via SSE
    while (Date.now() < deadline && !collected.includes("#EC4899")) {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 500),
        ),
      ]);
      if (value) collected += decoder.decode(value, { stream: true });
    }

    controller.abort();
    expect(collected).toContain("#EC4899");
    expect(collected).toContain('"userId":"A"');
  }, 20_000);

  it("clear message resets the stream for late joiners", async () => {
    const streamId = `sync-clear-${Date.now()}`;
    const writeUrl = `${demoUrl}/v1/stream/${PROJECT_ID}/${streamId}`;
    const readUrl = `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`;

    // Client A draws then clears via proxy
    await fetch(writeUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#EF4444", width: 8 }),
    });
    await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clear", userId: "A" }),
    });
    await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[50, 50, 0.5]], color: "#3B82F6", width: 4 }),
    });

    // Client B catches up directly from core (streams are public)
    const readRes = await fetch(`${readUrl}?offset=-1`);
    const body = await readRes.text();
    expect(body).toContain('"type":"clear"');
    expect(body).toContain("#3B82F6");
  });
});
