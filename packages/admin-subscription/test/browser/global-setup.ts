import { spawn, execSync } from "node:child_process";
import path from "node:path";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";

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

  // Shared KV/DO persist directory so all workers see the same data
  const PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ds-admin-sub-test-"));

  // Use unique worker names so parallel test runs (pnpm -r run test)
  // don't collide with other packages' tests — wrangler's local dev registry
  // resolves service bindings by name.
  const CORE_WORKER_NAME = "ds-admin-sub-browser-core";
  const SUBSCRIPTION_WORKER_NAME = "ds-admin-sub-browser-subscription";

  // Patch the built wrangler.json to:
  // 1. Point service bindings at the unique worker names
  // 2. Align KV namespace IDs so all workers share the same local KV store
  const wranglerJsonPath = path.join(ROOT, "dist/server/wrangler.json");
  const wranglerJson = JSON.parse(fs.readFileSync(wranglerJsonPath, "utf-8"));
  if (wranglerJson.services) {
    wranglerJson.services = wranglerJson.services.map((s: { binding: string; service: string }) => {
      if (s.binding === "CORE") return { ...s, service: CORE_WORKER_NAME };
      if (s.binding === "SUBSCRIPTION") return { ...s, service: SUBSCRIPTION_WORKER_NAME };
      return s;
    });
  }
  if (wranglerJson.kv_namespaces) {
    wranglerJson.kv_namespaces = wranglerJson.kv_namespaces.map(
      (ns: { binding: string; id: string }) =>
        ns.binding === "REGISTRY" ? { ...ns, id: "registry" } : ns,
    );
  }
  fs.writeFileSync(wranglerJsonPath, JSON.stringify(wranglerJson));

  // Start core worker with unique name so service bindings resolve correctly
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

  // Patch subscription's wrangler.toml to point its CORE service binding at the
  // unique core worker name and align KV namespace IDs, then start it.
  // Write the patched config inside the subscription dir so relative paths resolve.
  const subWranglerPath = path.join(SUBSCRIPTION_ROOT, "wrangler.toml");
  const subWranglerOriginal = fs.readFileSync(subWranglerPath, "utf-8");
  const subWranglerPatched = subWranglerOriginal
    .replace(/service\s*=\s*"durable-streams"/, `service = "${CORE_WORKER_NAME}"`)
    .replace(/id\s*=\s*"<your-kv-namespace-id>"/, `id = "registry"`);
  const subWranglerTmpPath = path.join(SUBSCRIPTION_ROOT, "wrangler.test.toml");
  fs.writeFileSync(subWranglerTmpPath, subWranglerPatched);

  const subscriptionPort = await getAvailablePort();
  const subscriptionProc = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(subscriptionPort),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
      "--name",
      SUBSCRIPTION_WORKER_NAME,
      "--config",
      subWranglerTmpPath,
      "--persist-to",
      PERSIST_DIR,
    ],
    { cwd: SUBSCRIPTION_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } },
  );
  await waitForReady(`http://localhost:${subscriptionPort}`);

  // Start admin worker (service bindings target the unique names above),
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
      "--persist-to",
      PERSIST_DIR,
      "--var",
      `CORE_URL:${coreUrl}`,
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
