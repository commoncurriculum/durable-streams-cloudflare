import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";

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

const PROJECT_ID = "test-project";

describe("admin-subscription integration", () => {
  let coreProc: ChildProcess;
  let subscriptionProc: ChildProcess;
  let adminProc: ChildProcess;
  let adminUrl: string;

  beforeAll(async () => {
    execSync("pnpm exec vite build", { cwd: ROOT, stdio: "pipe" });

    const corePort = await getAvailablePort();
    coreProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(corePort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
      ],
      { cwd: CORE_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(`http://localhost:${corePort}`);

    const subscriptionPort = await getAvailablePort();
    subscriptionProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(subscriptionPort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
      ],
      { cwd: SUBSCRIPTION_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(`http://localhost:${subscriptionPort}`);

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
  }, 120_000);

  afterAll(async () => {
    for (const proc of [adminProc, subscriptionProc, coreProc]) {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM");
        await once(proc, "exit").catch(() => {});
      }
    }
  });

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

  it("publish page renders at project-scoped URL with content type", async () => {
    const res = await fetch(`${adminUrl}/projects/${PROJECT_ID}/publish`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Publish to Stream");
    expect(html).toContain("Content Type");
    expect(html).toContain("Stream ID");
    expect(html).toContain("Message Body");
    expect(html).toContain("application/json");
    expect(html).toContain("text/plain");
  });
});
