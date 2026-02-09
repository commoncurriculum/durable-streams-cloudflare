import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(__dirname, "..");
const CORE_ROOT = path.resolve(__dirname, "../../core");
const SUBSCRIPTION_ROOT = path.resolve(__dirname, "../../subscription");

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

async function waitFor(
  fn: () => Promise<void>,
  { timeout = 10_000, interval = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw lastError ?? new Error("waitFor timed out");
}

const PROJECT_ID = "test-project";

describe("admin-subscription integration", () => {
  let coreProc: ChildProcess;
  let subscriptionProc: ChildProcess;
  let adminProc: ChildProcess;
  let coreUrl: string;
  let subscriptionUrl: string;
  let adminUrl: string;

  beforeAll(async () => {
    execSync("pnpm exec vite build", { cwd: ROOT, stdio: "pipe" });

    // Start core with test config (auth-free HTTP, has RPC methods)
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

    // Start subscription with test config (auth-free HTTP)
    const subscriptionPort = await getAvailablePort();
    subscriptionUrl = `http://localhost:${subscriptionPort}`;
    subscriptionProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(subscriptionPort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
        "--config", "wrangler.test.toml",
      ],
      { cwd: SUBSCRIPTION_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(subscriptionUrl);

    // Start admin with built config
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
        "--var", `CORE_URL:${coreUrl}`,
      ],
      { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(adminUrl);
  }, 120_000);

  afterAll(async () => {
    for (const proc of [adminProc, subscriptionProc, coreProc]) {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM");
        await once(proc, "exit").catch(() => {});
      }
    }
  });

  // ── Admin page rendering ──

  describe("page rendering", () => {
    it("overview page renders with project dropdown", async () => {
      const res = await fetch(adminUrl);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("project-select");
      expect(html).toContain("Select project...");
    });

    it("sessions page renders at project-scoped URL", async () => {
      const res = await fetch(`${adminUrl}/projects/${PROJECT_ID}/sessions`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Create Session");
    });

    it("session detail page renders session ID", async () => {
      const sessionId = `integration-session-${Date.now()}`;
      const detailRes = await fetch(
        `${adminUrl}/projects/${PROJECT_ID}/sessions/${sessionId}`,
      );
      expect(detailRes.status).toBe(200);
      const html = await detailRes.text();
      expect(html).toContain(sessionId);
    });

    it("publish page renders at project-scoped URL", async () => {
      const res = await fetch(`${adminUrl}/projects/${PROJECT_ID}/publish`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Publish to Stream");
      expect(html).toContain("Stream ID");
      expect(html).toContain("Message Body");
    });
  });

  // ── Three-tab demo flow ──
  // Simulates the demo: Tab 1 creates a session subscribed to two streams,
  // Tab 2 publishes to stream A, Tab 3 publishes to stream B.
  // Verifies that the session stream receives messages from both publishers.

  describe("three-tab demo: session with two stream subscriptions", () => {
    const sessionId = randomUUID();
    let streamA: string;
    let streamB: string;

    beforeAll(() => {
      streamA = `stream-a-${Date.now()}`;
      streamB = `stream-b-${Date.now()}`;
    });

    it("Tab 1: creates source streams on core", async () => {
      const resA = await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamA}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      });
      expect(resA.status).toBe(201);

      const resB = await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamB}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      });
      expect(resB.status).toBe(201);
    });

    it("Tab 1: subscribes session to stream A", async () => {
      const res = await fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          streamId: streamA,
          contentType: "application/json",
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.isNewSession).toBe(true);
      expect(body.sessionStreamPath).toBe(`/v1/${PROJECT_ID}/stream/${sessionId}`);
    });

    it("Tab 1: subscribes session to stream B", async () => {
      const res = await fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          streamId: streamB,
          contentType: "application/json",
        }),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.isNewSession).toBe(false); // same session, second subscription
    });

    it("Tab 1: session shows both subscriptions", async () => {
      const res = await fetch(
        `${subscriptionUrl}/v1/${PROJECT_ID}/session/${sessionId}`,
      );
      expect(res.status).toBe(200);

      const session = await res.json() as {
        sessionId: string;
        subscriptions: { streamId: string }[];
      };
      expect(session.sessionId).toBe(sessionId);
      expect(session.subscriptions).toHaveLength(2);

      const streamIds = session.subscriptions.map((s) => s.streamId);
      expect(streamIds).toContain(streamA);
      expect(streamIds).toContain(streamB);
    });

    it("Tab 2: publishes to stream A", async () => {
      const res = await fetch(
        `${subscriptionUrl}/v1/${PROJECT_ID}/publish/${streamA}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "tab2", message: "hello from tab 2" }),
        },
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("X-Fanout-Count")).toBe("1");
    });

    it("Tab 3: publishes to stream B", async () => {
      const res = await fetch(
        `${subscriptionUrl}/v1/${PROJECT_ID}/publish/${streamB}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "tab3", message: "hello from tab 3" }),
        },
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("X-Fanout-Count")).toBe("1");
    });

    it("Tab 1: session stream contains messages from both publishers", async () => {
      await waitFor(async () => {
        const readRes = await fetch(
          `${coreUrl}/v1/${PROJECT_ID}/stream/${sessionId}?offset=0000000000000000_0000000000000000`,
        );
        expect(readRes.status).toBe(200);
        const content = await readRes.text();
        expect(content).toContain("hello from tab 2");
        expect(content).toContain("hello from tab 3");
      });
    });

    it("Tab 1: session detail page shows subscriptions in HTML", async () => {
      const res = await fetch(
        `${adminUrl}/projects/${PROJECT_ID}/sessions/${sessionId}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(sessionId);
    });
  });

  // ── SSE live updates ──
  // Verifies that a session connected via SSE receives messages published
  // after the connection is established — the core of the live demo.

  describe("SSE live updates during demo", () => {
    it("SSE connection receives messages published after connect", async () => {
      const sseStreamId = `sse-stream-${Date.now()}`;
      const sseSessionId = randomUUID();

      // Create source stream
      const createRes = await fetch(
        `${coreUrl}/v1/${PROJECT_ID}/stream/${sseStreamId}`,
        { method: "PUT", headers: { "Content-Type": "application/json" } },
      );
      expect(createRes.status).toBe(201);

      // Subscribe session
      const subRes = await fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sseSessionId, streamId: sseStreamId }),
      });
      expect(subRes.status).toBe(200);

      // Connect SSE to the session stream (live tail)
      const controller = new AbortController();
      const sseRes = await fetch(
        `${coreUrl}/v1/${PROJECT_ID}/stream/${sseSessionId}?live=sse&offset=now`,
        { signal: controller.signal },
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

      // Publish while SSE is connected
      const pubRes = await fetch(
        `${subscriptionUrl}/v1/${PROJECT_ID}/publish/${sseStreamId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sse: true, message: "live update" }),
        },
      );
      expect(pubRes.status).toBe(204);

      // Read SSE events until we see the message
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
        if (collected.includes("live update")) break;
      }

      controller.abort();
      expect(collected).toContain("live update");
    }, 15_000);

    it("multiple publishes arrive in order via SSE", async () => {
      const streamId = `sse-order-${Date.now()}`;
      const sseSessionId = randomUUID();

      // Create stream + subscribe
      await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      });
      await fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sseSessionId, streamId }),
      });

      // Connect SSE
      const controller = new AbortController();
      const sseRes = await fetch(
        `${coreUrl}/v1/${PROJECT_ID}/stream/${sseSessionId}?live=sse&offset=now`,
        { signal: controller.signal },
      );
      expect(sseRes.status).toBe(200);

      // Publish 3 messages in sequence
      for (let i = 1; i <= 3; i++) {
        await fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/publish/${streamId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seq: i }),
        });
      }

      // Collect SSE events
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
        if (collected.includes('"seq":3')) break;
      }

      controller.abort();
      expect(collected).toContain('"seq":1');
      expect(collected).toContain('"seq":2');
      expect(collected).toContain('"seq":3');

      // Verify ordering: seq:1 appears before seq:2, which appears before seq:3
      const idx1 = collected.indexOf('"seq":1');
      const idx2 = collected.indexOf('"seq":2');
      const idx3 = collected.indexOf('"seq":3');
      expect(idx1).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx3);
    }, 15_000);
  });

  // ── Concurrent publishers ──
  // Simulates two publishers sending at the same time to different streams,
  // both fanning out to the same session.

  describe("concurrent publishers to shared session", () => {
    it("session receives interleaved messages from concurrent publishers", async () => {
      const sessionId = randomUUID();
      const streamX = `concurrent-x-${Date.now()}`;
      const streamY = `concurrent-y-${Date.now()}`;

      // Create streams
      await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamX}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      });
      await fetch(`${coreUrl}/v1/${PROJECT_ID}/stream/${streamY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      });

      // Subscribe session to both
      await fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, streamId: streamX }),
      });
      await fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, streamId: streamY }),
      });

      // Publish concurrently from both "tabs"
      const [pubX, pubY] = await Promise.all([
        fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/publish/${streamX}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "publisher-x", data: "concurrent-x" }),
        }),
        fetch(`${subscriptionUrl}/v1/${PROJECT_ID}/publish/${streamY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "publisher-y", data: "concurrent-y" }),
        }),
      ]);

      expect(pubX.status).toBe(204);
      expect(pubY.status).toBe(204);

      // Verify both messages arrive in the session stream
      await waitFor(async () => {
        const readRes = await fetch(
          `${coreUrl}/v1/${PROJECT_ID}/stream/${sessionId}?offset=0000000000000000_0000000000000000`,
        );
        expect(readRes.status).toBe(200);
        const content = await readRes.text();
        expect(content).toContain("concurrent-x");
        expect(content).toContain("concurrent-y");
      });
    });
  });
});
