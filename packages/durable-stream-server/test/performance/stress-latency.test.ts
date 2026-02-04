import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Stress Latency", () => {
  const streamPath = `stress-test-${Date.now()}`;
  const streamUrl = `${BASE_URL}/v1/stream/${streamPath}`;

  beforeAll(async () => {
    const res = await fetch(streamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });
    expect(res.ok).toBe(true);
  });

  afterAll(async () => {
    try {
      await fetch(streamUrl, { method: "DELETE" });
    } catch {
      // Ignore
    }
  });

  it("should handle 100 msg/sec for 10 seconds (1000 messages)", async () => {
    const messagesPerSecond = 100;
    const durationSeconds = 10;
    const totalMessages = messagesPerSecond * durationSeconds;
    const intervalMs = 1000 / messagesPerSecond; // 10ms between messages

    const latencies: number[] = [];
    const errors: { index: number; status: number }[] = [];
    const start = performance.now();

    console.log(`\n=== Sustained Load: ${messagesPerSecond} msg/sec for ${durationSeconds}s ===`);
    console.log(`Target: ${totalMessages} messages, ${intervalMs}ms interval`);

    for (let i = 0; i < totalMessages; i++) {
      const targetTime = start + i * intervalMs;
      const now = performance.now();

      // Wait if we're ahead of schedule
      if (now < targetTime) {
        await sleep(targetTime - now);
      }

      const msgStart = performance.now();
      const res = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "sustained-load",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `sustained-${i}\n`,
      });
      const msgEnd = performance.now();
      latencies.push(msgEnd - msgStart);

      if (!res.ok) {
        errors.push({ index: i, status: res.status });
      }

      // Progress update every second
      if ((i + 1) % messagesPerSecond === 0) {
        const elapsed = (performance.now() - start) / 1000;
        const recentLatencies = latencies.slice(-messagesPerSecond);
        const avgRecent = recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length;
        console.log(`  ${i + 1}/${totalMessages} at ${elapsed.toFixed(1)}s, recent avg: ${avgRecent.toFixed(1)}ms`);
      }
    }

    const totalTime = performance.now() - start;

    // Analyze
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const max = sorted[sorted.length - 1];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    // Check for degradation over time
    const first100Avg = latencies.slice(0, 100).reduce((a, b) => a + b, 0) / 100;
    const last100Avg = latencies.slice(-100).reduce((a, b) => a + b, 0) / 100;

    console.log(`\nResults:`);
    console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s (target: ${durationSeconds}s)`);
    console.log(`Errors: ${errors.length}`);
    console.log(`Latency - Avg: ${avg.toFixed(1)}ms, P50: ${p50.toFixed(1)}ms, P95: ${p95.toFixed(1)}ms, P99: ${p99.toFixed(1)}ms, Max: ${max.toFixed(1)}ms`);
    console.log(`First 100 avg: ${first100Avg.toFixed(1)}ms, Last 100 avg: ${last100Avg.toFixed(1)}ms`);

    const stalls = latencies.filter((l) => l > 1000);
    if (stalls.length > 0) {
      console.log(`STALLS (>1s): ${stalls.length} - ${stalls.map((s) => s.toFixed(0)).join(", ")}`);
    }

    expect(errors.length).toBe(0);
    expect(p95).toBeLessThan(200);
    expect(max).toBeLessThan(2000);
  }, 60000); // 60 second timeout

  it("should handle 100 sequential messages without stalling", async () => {
    const messageCount = 100;
    const latencies: number[] = [];
    const start = performance.now();

    for (let i = 0; i < messageCount; i++) {
      const msgStart = performance.now();
      const res = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "stress-seq",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `seq-msg-${i}\n`,
      });
      const msgEnd = performance.now();
      latencies.push(msgEnd - msgStart);

      if (!res.ok) {
        console.log(`Message ${i} failed: ${res.status} ${res.statusText}`);
      }
    }

    const totalTime = performance.now() - start;

    // Analyze latencies
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const max = sorted[sorted.length - 1];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    console.log(`\n=== 100 Sequential Messages ===`);
    console.log(`Total time: ${totalTime.toFixed(0)}ms`);
    console.log(`Avg: ${avg.toFixed(1)}ms, P50: ${p50.toFixed(1)}ms, P95: ${p95.toFixed(1)}ms, P99: ${p99.toFixed(1)}ms, Max: ${max.toFixed(1)}ms`);

    // Check for stalls (> 500ms)
    const stalls = latencies.filter((l) => l > 500);
    if (stalls.length > 0) {
      console.log(`STALLS: ${stalls.length} messages took > 500ms: ${stalls.map((s) => s.toFixed(0)).join(", ")}`);
    }

    // Check for slow messages (> 100ms)
    const slow = latencies.filter((l) => l > 100);
    if (slow.length > 0) {
      console.log(`SLOW: ${slow.length} messages took > 100ms`);
    }

    expect(stalls.length).toBe(0);
    expect(p95).toBeLessThan(100);
  });

  it("should handle 200 sequential messages without degradation", async () => {
    const messageCount = 200;
    const latencies: number[] = [];
    const start = performance.now();

    for (let i = 0; i < messageCount; i++) {
      const msgStart = performance.now();
      const res = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "stress-seq-200",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `seq200-msg-${i}\n`,
      });
      const msgEnd = performance.now();
      latencies.push(msgEnd - msgStart);

      if (!res.ok) {
        console.log(`Message ${i} failed: ${res.status}`);
      }
    }

    const totalTime = performance.now() - start;

    // Compare first 50 vs last 50
    const first50Avg = latencies.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
    const last50Avg = latencies.slice(-50).reduce((a, b) => a + b, 0) / 50;

    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];

    console.log(`\n=== 200 Sequential Messages ===`);
    console.log(`Total time: ${totalTime.toFixed(0)}ms`);
    console.log(`P50: ${p50.toFixed(1)}ms, P95: ${p95.toFixed(1)}ms, Max: ${max.toFixed(1)}ms`);
    console.log(`First 50 avg: ${first50Avg.toFixed(1)}ms, Last 50 avg: ${last50Avg.toFixed(1)}ms`);

    // Degradation check - last 50 shouldn't be more than 3x slower than first 50
    const degradationRatio = last50Avg / first50Avg;
    console.log(`Degradation ratio: ${degradationRatio.toFixed(2)}x`);

    expect(degradationRatio).toBeLessThan(3);
    expect(max).toBeLessThan(1000);
  });

  it("should handle burst of 50 concurrent messages", async () => {
    // Use different producer IDs to avoid conflicts
    const messageCount = 50;
    const start = performance.now();

    const promises = Array.from({ length: messageCount }, (_, i) =>
      fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": `burst-producer-${i}`,
          "Producer-Epoch": "1",
          "Producer-Seq": "0",
        },
        body: `burst-msg-${i}\n`,
      }).then((res) => ({
        index: i,
        status: res.status,
        ok: res.ok,
        time: performance.now() - start,
      }))
    );

    const results = await Promise.all(promises);
    const totalTime = performance.now() - start;

    const successful = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    console.log(`\n=== 50 Concurrent Messages (different producers) ===`);
    console.log(`Total time: ${totalTime.toFixed(0)}ms`);
    console.log(`Success: ${successful.length}, Failed: ${failed.length}`);

    if (failed.length > 0) {
      const statusCounts = failed.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        },
        {} as Record<number, number>
      );
      console.log(`Failure statuses:`, statusCounts);
    }

    // All should succeed with different producer IDs
    expect(successful.length).toBe(messageCount);
    expect(totalTime).toBeLessThan(5000);
  });

  it("should receive 100+ messages via SSE without stalling", async () => {
    // First, send 100 messages to populate the stream
    const sseStreamPath = `sse-stress-${Date.now()}`;
    const sseStreamUrl = `${BASE_URL}/v1/stream/${sseStreamPath}`;

    await fetch(sseStreamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });

    // Send 100 messages
    console.log(`\n=== SSE Receive 100 Messages ===`);
    console.log(`Sending 100 messages...`);
    const sendStart = performance.now();

    for (let i = 0; i < 100; i++) {
      await fetch(sseStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "sse-stress-producer",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `sse-msg-${i}\n`,
      });
    }

    const sendTime = performance.now() - sendStart;
    console.log(`Sent 100 messages in ${sendTime.toFixed(0)}ms`);

    // Now read them via SSE
    console.log(`Reading via SSE...`);
    const readStart = performance.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(`${sseStreamUrl}?offset=-1&live=sse`, {
      signal: controller.signal,
    });

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No reader");

    const decoder = new TextDecoder();
    let received = "";
    let messageCount = 0;
    const receiveTimestamps: number[] = [];

    try {
      while (messageCount < 100) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        received += chunk;

        // Count messages received
        const matches = received.match(/sse-msg-\d+/g);
        const newCount = matches?.length || 0;
        while (messageCount < newCount) {
          receiveTimestamps.push(performance.now() - readStart);
          messageCount++;
        }
      }
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }

    const totalReadTime = performance.now() - readStart;

    console.log(`Received ${messageCount} messages in ${totalReadTime.toFixed(0)}ms`);

    if (receiveTimestamps.length > 0) {
      const sorted = [...receiveTimestamps].sort((a, b) => a - b);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const spread = last - first;

      console.log(`First message at: ${first.toFixed(0)}ms, Last at: ${last.toFixed(0)}ms, Spread: ${spread.toFixed(0)}ms`);

      // All 100 messages should arrive within 2 seconds
      expect(spread).toBeLessThan(2000);
    }

    expect(messageCount).toBe(100);

    await fetch(sseStreamUrl, { method: "DELETE" });
  });
});
