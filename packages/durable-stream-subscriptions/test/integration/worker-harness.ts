import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_CWD = path.resolve(__dirname, "..", "..");
const CORE_CWD = path.resolve(__dirname, "..", "..", "..", "durable-stream-core");

export interface WorkerHandle {
  baseUrl: string;
  port: number;
  persistDir: string;
  stop: () => Promise<void>;
}

export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve port")));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function createPersistDir(prefix = "durable-streams-sub-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function applySubscriptionsMigrations(persistDir: string): Promise<void> {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "subscriptions",
      "--local",
      "--persist-to",
      persistDir,
    ],
    {
      cwd: SUBSCRIPTIONS_CWD,
      stdio: "ignore",
      env: {
        ...process.env,
        CI: "1",
      },
    },
  );

  const [exitCode] = await once(child, "exit");
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new Error(`wrangler subscriptions migrations failed with exit code ${exitCode}`);
  }
}

export async function applyCoreMigrations(persistDir: string): Promise<void> {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "durable-streams",
      "--local",
      "--persist-to",
      persistDir,
    ],
    {
      cwd: CORE_CWD,
      stdio: "ignore",
      env: {
        ...process.env,
        CI: "1",
      },
    },
  );

  const [exitCode] = await once(child, "exit");
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new Error(`wrangler core migrations failed with exit code ${exitCode}`);
  }
}

export async function startCoreWorker(options?: {
  port?: number;
  persistDir?: string;
  vars?: Record<string, string>;
}): Promise<WorkerHandle> {
  const port = options?.port ?? (await getAvailablePort());
  const persistDir = options?.persistDir ?? (await createPersistDir("core-"));
  const vars = options?.vars ?? {};

  await applyCoreMigrations(persistDir);

  const extraVars: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    extraVars.push("--var", `${key}:${value}`);
  }

  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(port),
      "--var",
      "DEBUG_TESTING:1",
      ...extraVars,
      "--persist-to",
      persistDir,
      "--log-level",
      "info",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: CORE_CWD,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "1",
      },
    },
  );

  const baseUrl = `http://localhost:${port}`;
  // Health check for core - use a stream path
  await waitForReady(`${baseUrl}/v1/stream/__health__?offset=0-0-0`);

  return {
    baseUrl,
    port,
    persistDir,
    stop: async () => {
      if (!child.killed) child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

export async function startSubscriptionsWorker(options?: {
  port?: number;
  persistDir?: string;
  coreUrl?: string;
  vars?: Record<string, string>;
}): Promise<WorkerHandle> {
  const port = options?.port ?? (await getAvailablePort());
  const persistDir = options?.persistDir ?? (await createPersistDir("subs-"));
  const coreUrl = options?.coreUrl ?? "http://localhost:8787";
  const vars = options?.vars ?? {};

  await applySubscriptionsMigrations(persistDir);

  const extraVars: string[] = [
    "--var",
    `CORE_URL:${coreUrl}`,
  ];
  for (const [key, value] of Object.entries(vars)) {
    extraVars.push("--var", `${key}:${value}`);
  }

  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(port),
      ...extraVars,
      "--persist-to",
      persistDir,
      "--log-level",
      "info",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: SUBSCRIPTIONS_CWD,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "1",
      },
    },
  );

  const baseUrl = `http://localhost:${port}`;
  await waitForReady(`${baseUrl}/health`);

  return {
    baseUrl,
    port,
    persistDir,
    stop: async () => {
      if (!child.killed) child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

export interface TestStack {
  core: WorkerHandle;
  subscriptions: WorkerHandle;
  stop: () => Promise<void>;
}

export async function startTestStack(): Promise<TestStack> {
  // Create shared persist dirs
  const corePersist = await createPersistDir("core-");
  const subsPersist = await createPersistDir("subs-");

  // Start core first
  const core = await startCoreWorker({ persistDir: corePersist });

  // Start subscriptions pointing to core
  const subscriptions = await startSubscriptionsWorker({
    persistDir: subsPersist,
    coreUrl: core.baseUrl,
  });

  return {
    core,
    subscriptions,
    stop: async () => {
      await subscriptions.stop();
      await core.stop();
    },
  };
}

async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response) return;
    } catch {
      // ignore until ready
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`worker did not start within ${timeoutMs}ms`);
}
