import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { SEGMENT_MAX_MESSAGES_DEFAULT } from "../../src/protocol/limits";
import { delay } from "./helpers";
import { startWorker } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

type D1Row = Record<string, unknown>;

async function queryAdminDb(persistDir: string, sql: string): Promise<{ results: D1Row[] }> {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "durable-streams",
      "--local",
      "--persist-to",
      persistDir,
      "--command",
      sql,
      "--json",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const [exitCode] = await once(child, "exit");
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new Error(`wrangler d1 execute failed (${exitCode}): ${stderr}`);
  }

  const parsed = JSON.parse(stdout) as Array<{ results?: D1Row[] }>;
  return { results: parsed?.[0]?.results ?? [] };
}

async function waitForAdminRow(persistDir: string, streamId: string): Promise<D1Row[]> {
  const deadline = Date.now() + 5_000;
  const safeId = streamId.replace(/'/g, "''");
  const sql = `SELECT * FROM segments_admin WHERE stream_id = '${safeId}'`;
  while (Date.now() < deadline) {
    const { results } = await queryAdminDb(persistDir, sql);
    if (results.length > 0) return results;
    await delay(100);
  }
  throw new Error("timed out waiting for segments_admin row");
}

describe("admin D1 index", () => {
  it("records segment metadata after rotation", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("admin");
    const url = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const totalMessages = 1200;
      const expectedSegmentMessages = Math.min(totalMessages, SEGMENT_MAX_MESSAGES_DEFAULT);
      for (let i = 0; i < totalMessages; i += 1) {
        const append = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "x",
        });
        expect([200, 204]).toContain(append.status);
      }

      const compact = await fetch(url, {
        method: "POST",
        headers: { "X-Debug-Action": "compact-retain" },
      });
      expect(compact.status).toBe(204);

      const rows = await waitForAdminRow(handle.persistDir, streamId);
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0];
      expect(row.stream_id).toBe(streamId);
      expect(row.read_seq).toBe(0);
      expect(Number(row.start_offset)).toBe(0);
      expect(Number(row.end_offset)).toBe(expectedSegmentMessages);
      expect(row.content_type).toBe("text/plain");
      expect(Number(row.message_count)).toBe(expectedSegmentMessages);
      expect(Number(row.size_bytes)).toBe(expectedSegmentMessages);
      expect(typeof row.r2_key).toBe("string");
    } finally {
      await handle.stop();
    }
  }, 30_000);
});
