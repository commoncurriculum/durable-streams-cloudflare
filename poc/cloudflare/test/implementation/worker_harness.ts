import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { ZERO_OFFSET } from "../../src/protocol/offsets";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_CWD = path.resolve(__dirname, "..", "..");

export type WorkerHandle = {
  baseUrl: string;
  port: number;
  persistDir: string;
  stop: () => Promise<void>;
};

export async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
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

export async function createPersistDir(prefix = "durable-streams-poc-"): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function applyMigrations(persistDir: string): Promise<void> {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "durable_streams_admin",
      "--local",
      "--persist-to",
      persistDir,
    ],
    {
      cwd: WORKER_CWD,
      stdio: "ignore",
      env: {
        ...process.env,
        CI: "1",
      },
    },
  );

  const [exitCode] = await once(child, "exit");
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new Error(`wrangler migrations failed with exit code ${exitCode}`);
  }
}

export async function startWorker(options?: {
  port?: number;
  persistDir?: string;
  vars?: Record<string, string>;
}): Promise<WorkerHandle> {
  const port = options?.port ?? (await getAvailablePort());
  const persistDir = options?.persistDir ?? (await createPersistDir());
  const vars = options?.vars ?? {};

  await applyMigrations(persistDir);

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
      "DEBUG_COALESCE:1",
      "--var",
      "DEBUG_TESTING:1",
      ...extraVars,
      "--persist-to",
      persistDir,
      "--log-level",
      "error",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER_CWD,
      stdio: "ignore",
      env: {
        ...process.env,
        CI: "1",
      },
    },
  );

  const baseUrl = `http://localhost:${port}`;
  await waitForReady(`${baseUrl}/v1/stream/__health__?offset=${ZERO_OFFSET}`);

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
