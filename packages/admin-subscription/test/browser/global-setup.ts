import { spawn, execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CORE_ROOT = path.resolve(import.meta.dirname, "../../../core");
const SUBSCRIPTION_ROOT = path.resolve(import.meta.dirname, "../../../subscription");
const PID_FILE = path.join(ROOT, "test/browser/.worker-pids.json");

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

  // Start core worker
  const corePort = await getAvailablePort();
  const coreProc = spawn(
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

  // Start subscription worker
  const subscriptionPort = await getAvailablePort();
  const subscriptionProc = spawn(
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

  // Start admin worker (uses built output)
  const adminPort = await getAvailablePort();
  const coreUrl = `http://localhost:${corePort}`;
  const adminProc = spawn(
    "pnpm",
    [
      "exec", "wrangler", "dev", "--local",
      "--port", String(adminPort),
      "--inspector-port", "0",
      "--show-interactive-dev-session=false",
      "--config", "dist/server/wrangler.json",
      "--var", `CORE_URL:${coreUrl}`,
    ],
    {
      cwd: ROOT,
      stdio: "pipe",
      env: { ...process.env, CI: "1" },
    },
  );
  await waitForReady(`http://localhost:${adminPort}`);

  // Pass URLs to tests via env vars
  process.env.ADMIN_URL = `http://localhost:${adminPort}`;
  process.env.CORE_URL = `http://localhost:${corePort}`;
  process.env.SUBSCRIPTION_URL = `http://localhost:${subscriptionPort}`;

  // Save PIDs for teardown
  fs.writeFileSync(
    PID_FILE,
    JSON.stringify({
      pids: [coreProc.pid, subscriptionProc.pid, adminProc.pid],
    }),
  );
}
