import { spawn, execSync } from "node:child_process";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CORE_ROOT = path.resolve(import.meta.dirname, "../../../core");
const PID_FILE = path.join(ROOT, "test/browser/.worker-pids.json");
const PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ds-admin-core-test-"));

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

  // Use a unique core worker name so parallel test runs (pnpm -r run test)
  // don't collide with the core package's own implementation tests — both
  // spawn a wrangler worker, and wrangler's local dev registry resolves
  // service bindings by name.
  const CORE_WORKER_NAME = "ds-admin-browser-core";
  const wranglerJsonPath = path.join(ROOT, "dist/server/wrangler.json");
  const wranglerJson = JSON.parse(fs.readFileSync(wranglerJsonPath, "utf-8"));
  wranglerJson.services = wranglerJson.services.map((s: { binding: string; service: string }) =>
    s.binding === "CORE" ? { ...s, service: CORE_WORKER_NAME } : s,
  );
  // Align the KV namespace ID with core's wrangler.toml so both workers share
  // the same local KV store — projects created in admin are visible to core
  // for JWT auth and CORS resolution on direct browser→core connections.
  if (wranglerJson.kv_namespaces) {
    wranglerJson.kv_namespaces = wranglerJson.kv_namespaces.map(
      (ns: { binding: string; id: string }) =>
        ns.binding === "REGISTRY" ? { ...ns, id: "registry" } : ns,
    );
  }
  fs.writeFileSync(wranglerJsonPath, JSON.stringify(wranglerJson));

  // Start core worker with the unique name, persisting to shared dir so
  // both workers see the same KV data (project configs, CORS origins, signing keys)
  const corePort = await getAvailablePort();
  const coreProc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(corePort),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
      "--name",
      CORE_WORKER_NAME,
      "--persist-to",
      PERSIST_DIR,
    ],
    { cwd: CORE_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  await waitForReady(`http://localhost:${corePort}`);

  // Start admin worker (service binding targets CORE_WORKER_NAME),
  // persisting to same shared dir so KV writes here are visible to core
  const adminPort = await getAvailablePort();
  const coreUrl = `http://localhost:${corePort}`;
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
      `CORE_URL:${coreUrl}`,
      "--persist-to",
      PERSIST_DIR,
    ],
    { cwd: ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  await waitForReady(`http://localhost:${adminPort}`);

  // Pass URLs to tests via env vars
  process.env.ADMIN_URL = `http://localhost:${adminPort}`;
  process.env.CORE_URL = `http://localhost:${corePort}`;

  // Save PIDs for teardown
  fs.writeFileSync(
    PID_FILE,
    JSON.stringify({
      pids: [coreProc.pid, adminProc.pid],
    }),
  );
}
