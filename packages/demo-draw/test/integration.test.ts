import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";
import { DurableStream } from "@durable-streams/client";
import type { DrawMessage } from "../src/lib/stream";

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

    // Start core worker (auth-free test worker)
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

    // Start demo-draw worker (for SSR page tests)
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

  // ── DurableStream client: create, append, read directly against core ──

  it("create + head: stream exists after DurableStream.create", async () => {
    const streamId = `create-${Date.now()}`;
    const ds = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });

    await ds.create({
      body: JSON.stringify({ type: "stroke", userId: "test", points: [[0, 0, 0.5]], color: "#000", width: 8 }),
    });

    const head = await ds.head();
    expect(head.exists).toBe(true);
  });

  it("create + append + read: appended data is readable", async () => {
    const streamId = `append-${Date.now()}`;
    const ds = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });

    await ds.create({
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#000", width: 8 }),
    });
    await ds.append(
      JSON.stringify({ type: "stroke", userId: "A", points: [[10, 10, 0.5]], color: "#EF4444", width: 4 }),
    );

    const res = await ds.stream({ offset: "-1", live: false });
    const items = await res.json<DrawMessage>();
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: "stroke", color: "#EF4444" });
  });

  // ── Two clients syncing via DurableStream ──

  it("client B sees strokes that client A appends (catch-up replay)", async () => {
    const streamId = `sync-catchup-${Date.now()}`;

    // Client A writes 3 strokes
    const clientA = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });
    await clientA.create({
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#EF4444", width: 8 }),
    });
    await clientA.append(
      JSON.stringify({ type: "stroke", userId: "A", points: [[10, 10, 0.5]], color: "#22C55E", width: 4 }),
    );
    await clientA.append(
      JSON.stringify({ type: "stroke", userId: "A", points: [[20, 20, 0.5]], color: "#3B82F6", width: 12 }),
    );

    // Client B catches up
    const clientB = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });
    const res = await clientB.stream({ offset: "-1", live: false });
    const items = await res.json<DrawMessage>();
    const colors = items.filter((m): m is DrawMessage & { color: string } => m.type === "stroke").map((m) => m.color);
    expect(colors).toContain("#EF4444");
    expect(colors).toContain("#22C55E");
    expect(colors).toContain("#3B82F6");
  });

  it("client B receives client A's stroke in real-time via SSE", async () => {
    const streamId = `sync-live-${Date.now()}`;

    // Client A creates the stream
    const clientA = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });
    await clientA.create({
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#000", width: 8 }),
    });

    // Client B subscribes via SSE
    const clientB = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });
    const res = await clientB.stream<DrawMessage>({ offset: "now", live: "sse" });

    const received: DrawMessage[] = [];
    const unsub = res.subscribeJson<DrawMessage>((batch) => {
      received.push(...batch.items);
    });

    // Client A appends a new stroke
    await clientA.append(
      JSON.stringify({ type: "stroke", userId: "A", points: [[99, 99, 1.0]], color: "#EC4899", width: 6 }),
    );

    // Wait for client B to receive it
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !received.some((m) => m.type === "stroke" && m.color === "#EC4899")) {
      await new Promise((r) => setTimeout(r, 100));
    }

    unsub();
    res.cancel();

    expect(received.some((m) => m.type === "stroke" && m.color === "#EC4899")).toBe(true);
    expect(received.some((m) => m.type === "stroke" && m.userId === "A")).toBe(true);
  }, 20_000);

  it("clear message resets the stream for late joiners", async () => {
    const streamId = `sync-clear-${Date.now()}`;

    // Client A draws, clears, then draws again
    const clientA = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });
    await clientA.create({
      body: JSON.stringify({ type: "stroke", userId: "A", points: [[0, 0, 0.5]], color: "#EF4444", width: 8 }),
    });
    await clientA.append(JSON.stringify({ type: "clear", userId: "A" }));
    await clientA.append(
      JSON.stringify({ type: "stroke", userId: "A", points: [[50, 50, 0.5]], color: "#3B82F6", width: 4 }),
    );

    // Client B catches up
    const clientB = new DurableStream({
      url: `${coreUrl}/v1/stream/${PROJECT_ID}/${streamId}`,
      contentType: "application/json",
      warnOnHttp: false,
    });
    const res = await clientB.stream({ offset: "-1", live: false });
    const items = await res.json<DrawMessage>();
    expect(items.some((m) => m.type === "clear")).toBe(true);
    expect(items.some((m) => m.type === "stroke" && m.color === "#3B82F6")).toBe(true);
  });
});
