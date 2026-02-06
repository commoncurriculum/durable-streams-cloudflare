import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DurableStream } from "@durable-streams/client";
import { createStreamDB, createStateSchema } from "@durable-streams/state";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Real server URL - must be running via `pnpm dev`
const SERVER_URL = "http://localhost:8787";

interface PresenceData {
  sessionId: string;
  userId: string;
  route: string;
  streamPath?: string;
  isTyping: boolean;
  lastSeen: number;
  color: string;
}

const presenceSchema: StandardSchemaV1<PresenceData> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "Invalid presence" }] };
      }
      return { value: value as PresenceData };
    },
  },
};

const stateSchema = createStateSchema({
  presence: {
    schema: presenceSchema,
    type: "presence",
    primaryKey: "sessionId",
  },
});

describe("StreamDB Browser Performance", () => {
  const streamPath = `/__test_perf_${Date.now()}__`;
  const streamUrl = `${SERVER_URL}/v1/stream${streamPath}`;
  let stream: DurableStream;

  beforeAll(async () => {
    // Create the test stream
    stream = await DurableStream.create({
      url: streamUrl,
      contentType: "application/json",
    });
  });

  afterAll(async () => {
    // Clean up
    try {
      await stream.delete();
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should measure StreamDB load performance in browser", async () => {
    const eventCount = 500;

    console.log(`\n=== Writing ${eventCount} presence events ===`);
    const writeStart = performance.now();

    // Write events individually (like the admin-ui does)
    for (let i = 0; i < eventCount; i++) {
      const event = stateSchema.presence.upsert({
        value: {
          sessionId: `session-${i}`,
          userId: `user-${i % 10}`,
          route: `/streams/test-${i % 5}`,
          streamPath: `test-${i % 5}`,
          isTyping: false,
          lastSeen: Date.now(),
          color: "#ff0000",
        },
      });
      await stream.append(JSON.stringify(event));
    }

    const writeTime = performance.now() - writeStart;
    console.log(
      `Write time: ${writeTime.toFixed(0)}ms (${(eventCount / (writeTime / 1000)).toFixed(0)} events/sec)`
    );

    // Measure StreamDB load time
    console.log(`\n=== Loading via StreamDB ===`);
    const loadStart = performance.now();

    const db = createStreamDB({
      streamOptions: { url: streamUrl },
      state: stateSchema,
    });

    await db.preload();

    const loadTime = performance.now() - loadStart;
    const presenceCount = db.collections.presence.size;

    console.log(`Load time: ${loadTime.toFixed(0)}ms`);
    console.log(`Loaded ${presenceCount} records`);
    console.log(
      `Throughput: ${(presenceCount / (loadTime / 1000)).toFixed(0)} records/sec`
    );

    db.close();

    expect(presenceCount).toBe(eventCount);
    expect(loadTime).toBeLessThan(10000); // 10 second budget
  }, 120000);

  it("should measure loading the actual __presence__ stream", async () => {
    const presenceUrl = `${SERVER_URL}/v1/stream/__presence__`;

    // Check if presence stream exists
    const presenceStream = new DurableStream({ url: presenceUrl });
    const exists = await presenceStream.head().catch(() => null);

    if (!exists) {
      console.log("__presence__ stream does not exist, skipping test");
      return;
    }

    console.log(`\n=== Loading real __presence__ stream ===`);
    const loadStart = performance.now();

    const db = createStreamDB({
      streamOptions: { url: presenceUrl },
      state: stateSchema,
    });

    await db.preload();

    const loadTime = performance.now() - loadStart;
    const presenceCount = db.collections.presence.size;

    console.log(`Load time: ${loadTime.toFixed(0)}ms`);
    console.log(`Loaded ${presenceCount} records from __presence__`);
    console.log(
      `Throughput: ${(presenceCount / (loadTime / 1000)).toFixed(0)} records/sec`
    );

    db.close();

    // Just ensure it loaded something (may be 0 if no one is online)
    expect(loadTime).toBeLessThan(60000);
  }, 120000);

  it("should measure batch timing during catch-up", async () => {
    const batchStreamPath = `/__test_batch_${Date.now()}__`;
    const batchStreamUrl = `${SERVER_URL}/v1/stream${batchStreamPath}`;

    const batchStream = await DurableStream.create({
      url: batchStreamUrl,
      contentType: "application/json",
    });

    const eventCount = 200;

    console.log(`\n=== Writing ${eventCount} individual events ===`);
    for (let i = 0; i < eventCount; i++) {
      const event = stateSchema.presence.insert({
        value: {
          sessionId: `batch-session-${i}`,
          userId: `user-${i}`,
          route: "/test",
          isTyping: false,
          lastSeen: Date.now(),
          color: "#000",
        },
      });
      await batchStream.append(JSON.stringify(event));
    }

    console.log(`\n=== Measuring batch timing ===`);
    const batchData: { items: number; elapsed: number; sinceStart: number }[] =
      [];
    const startTime = performance.now();
    let lastTime = startTime;

    const streamResponse = await batchStream.stream({ live: false });

    await new Promise<void>((resolve) => {
      streamResponse.subscribeJson((batch) => {
        const now = performance.now();
        const elapsed = now - lastTime;
        const sinceStart = now - startTime;
        if (batch.items.length > 0) {
          batchData.push({ items: batch.items.length, elapsed, sinceStart });
          console.log(
            `Batch: ${batch.items.length} items, wait=${elapsed.toFixed(0)}ms, total=${sinceStart.toFixed(0)}ms`
          );
        }
        lastTime = now;
        if (batch.upToDate) resolve();
        return Promise.resolve();
      });
    });

    console.log(`\nBatch breakdown:`);
    for (const b of batchData) {
      console.log(
        `  ${b.items} items, wait=${b.elapsed.toFixed(0)}ms, total=${b.sinceStart.toFixed(0)}ms`
      );
    }
    console.log(`\nTotal batches: ${batchData.length}`);
    const totalTime =
      batchData.length > 0 ? batchData[batchData.length - 1].sinceStart : 0;
    console.log(`Total time: ${totalTime.toFixed(0)}ms`);

    await batchStream.delete();
    expect(batchData.length).toBeGreaterThan(0);
  }, 60000);
});
