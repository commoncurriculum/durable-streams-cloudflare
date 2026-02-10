import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";

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

// Tests page rendering of the built admin-subscription app.
// Subscribe/publish integration tests live in packages/subscription/test/integration/
// and in the Playwright browser tests (test/browser/).
describe("admin-subscription integration", () => {
  let coreProc: ChildProcess;
  let subscriptionProc: ChildProcess;
  let adminProc: ChildProcess;
  let adminUrl: string;

  let persistDir: string;

  beforeAll(async () => {
    execSync("pnpm exec vite build", { cwd: ROOT, stdio: "pipe" });

    // Shared persist directory so all workers see the same KV/DO data
    // and service bindings between workers connect properly
    persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-admin-sub-integ-"));

    // Align the KV namespace ID with core's wrangler.toml so all workers
    // share the same local KV store
    const wranglerJsonPath = path.join(ROOT, "dist/server/wrangler.json");
    const wranglerJson = JSON.parse(fs.readFileSync(wranglerJsonPath, "utf-8"));
    if (wranglerJson.kv_namespaces) {
      wranglerJson.kv_namespaces = wranglerJson.kv_namespaces.map(
        (ns: { binding: string; id: string }) =>
          ns.binding === "REGISTRY" ? { ...ns, id: "registry" } : ns,
      );
    }
    fs.writeFileSync(wranglerJsonPath, JSON.stringify(wranglerJson));

    // Start core worker (production config — avoids build cache conflicts
    // with core's own tests that use wrangler.test.toml in parallel)
    const corePort = await getAvailablePort();
    coreProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(corePort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
        "--persist-to", persistDir,
      ],
      { cwd: CORE_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(`http://localhost:${corePort}`);

    // Start subscription with test config (auth-free HTTP)
    const subscriptionPort = await getAvailablePort();
    subscriptionProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(subscriptionPort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
        "--config", "wrangler.test.toml",
        "--persist-to", persistDir,
      ],
      { cwd: SUBSCRIPTION_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(`http://localhost:${subscriptionPort}`);

    // Start admin with built config
    const adminPort = await getAvailablePort();
    adminUrl = `http://localhost:${adminPort}`;
    const coreUrl = `http://localhost:${corePort}`;
    adminProc = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local",
        "--port", String(adminPort),
        "--inspector-port", "0",
        "--show-interactive-dev-session=false",
        "--config", "dist/server/wrangler.json",
        "--persist-to", persistDir,
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
    // Clean up shared persist directory
    if (persistDir) {
      fs.rmSync(persistDir, { recursive: true, force: true });
    }
  });

  // ── Admin page rendering ──

  describe("page rendering", () => {
    it("overview page renders with nav links", async () => {
      const res = await fetch(adminUrl);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("System Overview");
      expect(html).toContain("Projects");
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
});
