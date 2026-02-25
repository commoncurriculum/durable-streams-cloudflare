import { spawn, execSync } from "node:child_process";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SERVER_ROOT = path.resolve(import.meta.dirname, "../../../server");
const PID_FILE = path.join(ROOT, "test/browser/.worker-pids.json");
const PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ds-admin-test-"));

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

export default async function globalSetup() {
  // Build the admin app first
  execSync("pnpm exec vite build", { cwd: ROOT, stdio: "pipe" });

  // Use a unique server worker name to avoid collisions with other test runs
  const SERVER_WORKER_NAME = "ds-admin-test-server";

  // Start server worker
  const serverPort = await getAvailablePort();
  const serverProc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(serverPort),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
      "--name",
      SERVER_WORKER_NAME,
      "--persist-to",
      PERSIST_DIR,
    ],
    { cwd: SERVER_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  await waitForReady(`http://localhost:${serverPort}`);

  // Start admin worker
  const adminPort = await getAvailablePort();
  const serverUrl = `http://localhost:${serverPort}`;
  const adminProc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(adminPort),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
      "--config",
      "dist/server/wrangler.json",
      "--var",
      `SERVER_URL:${serverUrl}`,
      "--var",
      // Using a test admin secret (this is a test JWK)
      `ADMIN_SECRET:{"kty":"oct","k":"test-secret-key-for-admin"}`,
      "--persist-to",
      PERSIST_DIR,
    ],
    { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  await waitForReady(`http://localhost:${adminPort}`);

  // Pass URLs to tests via env vars
  process.env.ADMIN_URL = `http://localhost:${adminPort}`;
  process.env.SERVER_URL = `http://localhost:${serverPort}`;

  // Save PIDs for teardown
  fs.writeFileSync(
    PID_FILE,
    JSON.stringify({
      pids: [serverProc.pid, adminProc.pid],
    }),
  );
}
