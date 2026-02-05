import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

/**
 * Benchmarks for comparing inline delivery vs queue-based fanout.
 *
 * To test queue latency in production:
 *   IMPLEMENTATION_TEST_URL=https://your-worker.workers.dev pnpm test queue-latency
 *
 * Note: Local queues behave differently than production. These tests measure
 * the overhead of the queue path vs inline path.
 */
describe("Queue vs Inline Fanout Latency", () => {
  const testId = Date.now();

  // Source stream that will have messages published to it
  const sourceStreamPath = `queue-bench-source-${testId}`;
  const sourceStreamUrl = `${BASE_URL}/v1/stream/${sourceStreamPath}`;

  // Session IDs created via the sessions API
  const sessionCount = 5;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    // Create source stream
    const res = await fetch(sourceStreamUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.ok).toBe(true);

    // Create sessions and subscribe them to source stream
    for (let i = 0; i < sessionCount; i++) {
      // Create session via API
      const sessionRes = await fetch(`${BASE_URL}/v1/sessions`, {
        method: "POST",
      });
      expect(sessionRes.ok).toBe(true);
      const { sessionId } = (await sessionRes.json()) as { sessionId: string };
      sessionIds.push(sessionId);

      // Subscribe session to source stream
      const subRes = await fetch(`${BASE_URL}/v1/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          streamId: sourceStreamPath,
        }),
      });
      expect(subRes.ok).toBe(true);
    }

    // Wait for subscriptions to be established
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    // Cleanup - unsubscribe and delete source stream
    try {
      for (const sessionId of sessionIds) {
        await fetch(`${BASE_URL}/v1/subscriptions`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            streamId: sourceStreamPath,
          }),
        });
      }
      await fetch(sourceStreamUrl, { method: "DELETE" });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should measure inline fanout latency (publish -> session stream)", async () => {
    const iterations = 10;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const timestamp = Date.now();
      const messageId = `inline-${testId}-${i}`;

      // Publish to source stream
      const publishStart = performance.now();
      const res = await fetch(sourceStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Producer-Id": `bench-inline-${testId}`,
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: JSON.stringify({ id: messageId, ts: timestamp }),
      });
      const publishEnd = performance.now();

      expect(res.ok).toBe(true);

      // The publish latency includes fanout for inline delivery
      latencies.push(publishEnd - publishStart);
    }

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);
    const minLatency = Math.min(...latencies);

    console.log("\n=== Inline Fanout Latency ===");
    console.log(`Subscribers: ${sessionCount}`);
    console.log(`Iterations: ${iterations}`);
    console.log(`Latencies (ms): ${latencies.map((l) => l.toFixed(1)).join(", ")}`);
    console.log(`Min: ${minLatency.toFixed(1)}ms, Avg: ${avgLatency.toFixed(1)}ms, Max: ${maxLatency.toFixed(1)}ms`);

    // Verify messages arrived at session streams
    await new Promise((r) => setTimeout(r, 500));

    // Verify messages arrived at all session streams
    const sessionMessageCounts: number[] = [];
    for (const sessionId of sessionIds) {
      const sessionStreamUrl = `${BASE_URL}/v1/stream/subscriptions/${sessionId}?offset=-1`;
      const sessionRes = await fetch(sessionStreamUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const body = await sessionRes.text();
      let messageCount = 0;
      try {
        const messages = JSON.parse(body);
        messageCount = Array.isArray(messages) ? messages.length : 0;
      } catch {
        messageCount = body.split("\n").filter((l) => l.trim()).length;
      }
      sessionMessageCounts.push(messageCount);
    }
    console.log(`All ${sessionIds.length} sessions received ${sessionMessageCounts[0]} messages each`);
    expect(sessionMessageCounts.every((c) => c === iterations)).toBe(true);

    expect(avgLatency).toBeLessThan(500);
  });

  it("should measure end-to-end fanout delivery time", async () => {
    // This test measures how long it takes for a message to appear in session streams
    const sessionId = sessionIds[0];
    const sessionStreamUrl = `${BASE_URL}/v1/stream/subscriptions/${sessionId}`;

    // Helper to count messages from JSON array response
    const countMessages = (body: string): number => {
      try {
        const messages = JSON.parse(body);
        return Array.isArray(messages) ? messages.length : 0;
      } catch {
        return body.split("\n").filter((l) => l.trim()).length;
      }
    };

    // Get current message count
    const initialRes = await fetch(`${sessionStreamUrl}?offset=-1`, {
      headers: { Accept: "application/json" },
    });
    const initialBody = await initialRes.text();
    const initialMessages = countMessages(initialBody);

    const timestamp = Date.now();
    const messageId = `e2e-${testId}`;

    // Publish message
    const publishTime = performance.now();
    await fetch(sourceStreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Producer-Id": `bench-e2e-${testId}`,
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: JSON.stringify({ id: messageId, ts: timestamp }),
    });

    // Poll session stream until message arrives
    let deliveryTime = 0;
    const maxWait = 5000;
    const pollInterval = 20;
    let elapsed = 0;

    while (elapsed < maxWait) {
      const res = await fetch(`${sessionStreamUrl}?offset=-1`, {
        headers: { Accept: "application/json" },
      });
      const body = await res.text();
      const messageCount = countMessages(body);

      if (messageCount > initialMessages) {
        deliveryTime = performance.now() - publishTime;
        break;
      }

      await new Promise((r) => setTimeout(r, pollInterval));
      elapsed += pollInterval;
    }

    console.log("\n=== End-to-End Fanout Delivery ===");
    if (deliveryTime > 0) {
      console.log(`Message delivered in ${deliveryTime.toFixed(1)}ms`);
      expect(deliveryTime).toBeLessThan(2000);
    } else {
      console.log(`Message not delivered within ${maxWait}ms`);
      expect(deliveryTime).toBeGreaterThan(0);
    }
  });

  it("should measure concurrent publish throughput with fanout", async () => {
    const messageCount = 20;
    const start = performance.now();

    // Fire all publishes concurrently, each with unique producer
    const promises = Array.from({ length: messageCount }, (_, i) =>
      fetch(sourceStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Producer-Id": `bench-concurrent-${testId}-${i}`,
          "Producer-Epoch": "1",
          "Producer-Seq": "0",
        },
        body: JSON.stringify({ id: `concurrent-${i}`, ts: Date.now() }),
      })
    );

    const results = await Promise.all(promises);
    const end = performance.now();
    const totalTime = end - start;
    const successCount = results.filter((r) => r.ok).length;
    const throughput = (messageCount / totalTime) * 1000;

    console.log("\n=== Concurrent Publish with Fanout ===");
    console.log(`Messages: ${messageCount}, Subscribers: ${sessionCount}`);
    console.log(`Total fanout writes: ${messageCount * sessionCount}`);
    console.log(`Time: ${totalTime.toFixed(1)}ms`);
    console.log(`Success: ${successCount}/${messageCount}`);
    console.log(`Throughput: ${throughput.toFixed(1)} msg/sec`);

    expect(successCount).toBe(messageCount);
    expect(totalTime).toBeLessThan(10000);
  });

  it("should compare fanout overhead at different subscriber counts", async () => {
    // Create a fresh stream for this comparison test
    const compStreamPath = `fanout-comparison-${testId}`;
    const compStreamUrl = `${BASE_URL}/v1/stream/${compStreamPath}`;

    await fetch(compStreamUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
    });

    const results: { subscribers: number; avgLatency: number }[] = [];

    // Test with 0 subscribers (baseline)
    const baselineLatencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await fetch(compStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Producer-Id": `baseline-${testId}`,
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: JSON.stringify({ msg: i }),
      });
      baselineLatencies.push(performance.now() - start);
    }
    results.push({
      subscribers: 0,
      avgLatency: baselineLatencies.reduce((a, b) => a + b, 0) / baselineLatencies.length,
    });

    // Add subscribers incrementally and measure
    const testSessionIds: string[] = [];
    const subscriberCounts = [1, 5, 10, 20];

    for (const targetCount of subscriberCounts) {
      // Add sessions until we reach target count
      while (testSessionIds.length < targetCount) {
        const sessionRes = await fetch(`${BASE_URL}/v1/sessions`, { method: "POST" });
        const { sessionId } = (await sessionRes.json()) as { sessionId: string };
        testSessionIds.push(sessionId);

        await fetch(`${BASE_URL}/v1/subscriptions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, streamId: compStreamPath }),
        });
      }

      await new Promise((r) => setTimeout(r, 100));

      // Measure latency with current subscriber count
      const latencies: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await fetch(compStreamUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Producer-Id": `sub-${targetCount}-${testId}`,
            "Producer-Epoch": "1",
            "Producer-Seq": String(i),
          },
          body: JSON.stringify({ msg: i, subs: targetCount }),
        });
        latencies.push(performance.now() - start);
      }

      results.push({
        subscribers: targetCount,
        avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      });
    }

    console.log("\n=== Fanout Overhead by Subscriber Count ===");
    console.log("Subscribers | Avg Latency (ms) | Overhead vs Baseline");
    console.log("------------|------------------|---------------------");
    const baseline = results[0].avgLatency;
    for (const r of results) {
      const overhead = r.avgLatency - baseline;
      console.log(
        `${String(r.subscribers).padStart(11)} | ${r.avgLatency.toFixed(1).padStart(16)} | ${overhead >= 0 ? "+" : ""}${overhead.toFixed(1)}ms`
      );
    }

    // Cleanup
    for (const sessionId of testSessionIds) {
      await fetch(`${BASE_URL}/v1/subscriptions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, streamId: compStreamPath }),
      });
    }
    await fetch(compStreamUrl, { method: "DELETE" });

    // Expect reasonable overhead per subscriber (< 50ms per subscriber at 20 subs)
    const lastResult = results[results.length - 1];
    expect(lastResult.avgLatency).toBeLessThan(baseline + 1000);
  });
});

describe("Queue Enqueue Overhead", () => {
  /**
   * This test measures just the queue.sendBatch() overhead, without
   * waiting for consumer processing. Useful for understanding the
   * synchronous cost of using queues.
   *
   * To test this properly, we'd need a special endpoint that:
   * 1. Accepts a message
   * 2. Enqueues it to the queue
   * 3. Returns timing info
   *
   * This is skipped by default since it requires instrumentation.
   */
  it.skip("should measure queue.sendBatch latency (requires deployed worker)", async () => {
    console.log("Skipped: requires deployed worker with queue metrics endpoint");
  });
});
