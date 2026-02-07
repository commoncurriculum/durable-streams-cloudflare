import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const PORT = 18789;
const BASE_URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, "..");

describe("admin-subscription smoke", () => {
  let proc: ChildProcess;
  let startupError = "";

  beforeAll(async () => {
    proc = spawn(
      "pnpm",
      ["exec", "vite", "dev", "--port", String(PORT)],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_ENV: "development",
          CF_INSPECTOR_PORT: "19231",
        },
      },
    );

    proc.stderr?.on("data", (chunk: Buffer) => {
      startupError += chunk.toString();
    });

    proc.on("exit", (code) => {
      if (code && code !== 0) {
        startupError += `\nProcess exited with code ${code}`;
      }
    });

    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(
          `Dev server exited with code ${proc.exitCode}:\n${startupError}`,
        );
      }
      try {
        await fetch(BASE_URL, { signal: AbortSignal.timeout(2000) });
        ready = true;
        break;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
      throw new Error(
        `Dev server failed to start within timeout.\nstderr:\n${startupError}`,
      );
    }
  }, 60_000);

  afterAll(() => {
    proc?.kill("SIGTERM");
  });

  it("GET / returns HTML with dashboard title", async () => {
    const res = await fetch(BASE_URL);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Subscription Service");
  });

  it("GET /projects/:id/sessions renders a Create Session button", async () => {
    const res = await fetch(`${BASE_URL}/projects/test-project/sessions`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Create Session");
  });

  it("GET /projects/:id/publish renders the publish form", async () => {
    const res = await fetch(`${BASE_URL}/projects/test-project/publish`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Publish to Stream");
    expect(html).toContain("Stream ID");
    expect(html).toContain("Message Body");
    expect(html).toContain("Send");
  });
});
