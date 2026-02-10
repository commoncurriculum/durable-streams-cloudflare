import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
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

// Tests page rendering of the built admin-core app.
// Stream CRUD and SSE integration tests live in packages/core/test/implementation/
// and in the Playwright browser tests (test/browser/).
describe("admin-core integration", () => {
  let coreProc: ChildProcess;
  let adminProc: ChildProcess;
  let adminUrl: string;

  let persistDir: string;

  beforeAll(async () => {
    // Build the admin worker
    execSync("pnpm exec vite build", { cwd: ROOT, stdio: "pipe" });

    // Shared persist directory so service bindings between workers connect
    persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-admin-core-integ-"));

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

    // Start admin worker (service binding to CORE via shared persist)
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
        "--persist-to", persistDir,
      ],
      { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
    );
    await waitForReady(adminUrl);
  }, 120_000);

  afterAll(async () => {
    if (adminProc && !adminProc.killed) {
      adminProc.kill("SIGTERM");
      await once(adminProc, "exit").catch(() => {});
    }
    if (coreProc && !coreProc.killed) {
      coreProc.kill("SIGTERM");
      await once(coreProc, "exit").catch(() => {});
    }
    if (persistDir) {
      fs.rmSync(persistDir, { recursive: true, force: true });
    }
  });

  // ── Page rendering ──

  it("GET / renders the overview page with dashboard title", async () => {
    const res = await fetch(adminUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Durable Streams");
    expect(html).toContain("Overview");
    expect(html).toContain("Projects");
  });

  it("GET /projects renders the projects list", async () => {
    const res = await fetch(`${adminUrl}/projects`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Projects");
    expect(html).toContain("Create Project");
  });

  it("GET /projects/:id renders the project detail page", async () => {
    const res = await fetch(`${adminUrl}/projects/${PROJECT_ID}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Overview");
    expect(html).toContain("Streams");
    expect(html).toContain("Settings");
  });

  it("GET /projects/:id/streams renders the streams page", async () => {
    const res = await fetch(`${adminUrl}/projects/${PROJECT_ID}/streams`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Streams");
  });

  it("GET /projects/:id/settings renders the settings page", async () => {
    const res = await fetch(`${adminUrl}/projects/${PROJECT_ID}/settings`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Settings");
  });

  it("stream detail page renders for any stream ID", async () => {
    const streamId = `integration-test-${Date.now()}`;
    const res = await fetch(
      `${adminUrl}/projects/${PROJECT_ID}/streams/${encodeURIComponent(streamId)}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The child route should render (not just the search form)
    expect(html).not.toContain("Enter a stream ID to open or create");
  });
});
