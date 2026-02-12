import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

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

export async function startWorker(options?: {
  port?: number;
  persistDir?: string;
  vars?: Record<string, string>;
  useProductionAuth?: boolean;
  /** Custom wrangler config file (relative to packages/core). Overrides useProductionAuth. */
  configFile?: string;
}): Promise<WorkerHandle> {
  const port = options?.port ?? (await getAvailablePort());
  const persistDir = options?.persistDir ?? (await createPersistDir());
  const vars = options?.vars ?? {};

  const extraVars: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    extraVars.push("--var", `${key}:${value}`);
  }

  // Use wrangler.test.toml (auth-free worker) by default.
  // When useProductionAuth is true, use production wrangler.toml (has JWT auth).
  // When configFile is specified, use that config file directly.
  const configArgs = options?.configFile
    ? ["--config", options.configFile]
    : options?.useProductionAuth
      ? []
      : ["--config", "wrangler.test.toml"];

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
      ...configArgs,
      ...extraVars,
      "--persist-to",
      persistDir,
      "--log-level",
      "info",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: WORKER_CWD,
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
