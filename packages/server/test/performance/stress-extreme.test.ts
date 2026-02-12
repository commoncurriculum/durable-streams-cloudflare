import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Extreme Stress", () => {
  const streamPath = `extreme-stress-${Date.now()}`;
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

  it("should handle 5000 sequential messages", async () => {
    const messageCount = 5000;
    const latencies: number[] = [];
    const start = performance.now();

    console.log(`\n=== 5000 Sequential Messages ===`);

    for (let i = 0; i < messageCount; i++) {
      const msgStart = performance.now();
      const res = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "extreme-seq",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `msg-${i}\n`,
      });
      const msgEnd = performance.now();
      latencies.push(msgEnd - msgStart);

      if (!res.ok) {
        console.log(`Message ${i} failed: ${res.status}`);
      }

      // Progress every 1000
      if ((i + 1) % 1000 === 0) {
        const elapsed = (performance.now() - start) / 1000;
        const recentAvg = latencies.slice(-1000).reduce((a, b) => a + b, 0) / 1000;
        console.log(
          `  ${i + 1}/${messageCount} at ${elapsed.toFixed(1)}s, recent avg: ${recentAvg.toFixed(1)}ms`,
        );
      }
    }

    const totalTime = performance.now() - start;
    const sorted = [...latencies].sort((a, b) => a - b);

    console.log(`\nResults:`);
    console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`Throughput: ${(messageCount / (totalTime / 1000)).toFixed(0)} msg/s`);
    console.log(`P50: ${sorted[Math.floor(sorted.length * 0.5)].toFixed(1)}ms`);
    console.log(`P95: ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)}ms`);
    console.log(`P99: ${sorted[Math.floor(sorted.length * 0.99)].toFixed(1)}ms`);
    console.log(`Max: ${sorted[sorted.length - 1].toFixed(1)}ms`);

    // Check degradation
    const first500 = latencies.slice(0, 500).reduce((a, b) => a + b, 0) / 500;
    const last500 = latencies.slice(-500).reduce((a, b) => a + b, 0) / 500;
    console.log(`First 500 avg: ${first500.toFixed(1)}ms, Last 500 avg: ${last500.toFixed(1)}ms`);

    const stalls = latencies.filter((l) => l > 1000);
    if (stalls.length > 0) {
      console.log(`STALLS (>1s): ${stalls.length}`);
    }

    expect(stalls.length).toBe(0);
  }, 120000);

  it("should handle 100 msg/sec for 100 seconds (10000 messages)", async () => {
    const sustainedStreamPath = `sustained-100s-${Date.now()}`;
    const sustainedStreamUrl = `${BASE_URL}/v1/stream/${sustainedStreamPath}`;

    await fetch(sustainedStreamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });

    const messagesPerSecond = 100;
    const durationSeconds = 100;
    const totalMessages = messagesPerSecond * durationSeconds;
    const intervalMs = 1000 / messagesPerSecond;

    const latencies: number[] = [];
    const errors: number[] = [];
    const start = performance.now();

    console.log(`\n=== Sustained Load: 100 msg/sec for 100s (10000 messages) ===`);

    for (let i = 0; i < totalMessages; i++) {
      const targetTime = start + i * intervalMs;
      const now = performance.now();

      if (now < targetTime) {
        await sleep(targetTime - now);
      }

      const msgStart = performance.now();
      const res = await fetch(sustainedStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "sustained-100s",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `sustained-${i}\n`,
      });
      const msgEnd = performance.now();
      latencies.push(msgEnd - msgStart);

      if (!res.ok) {
        errors.push(i);
      }

      // Progress every 10 seconds
      if ((i + 1) % (messagesPerSecond * 10) === 0) {
        const elapsed = (performance.now() - start) / 1000;
        const recentAvg = latencies.slice(-1000).reduce((a, b) => a + b, 0) / 1000;
        const sorted = [...latencies].sort((a, b) => a - b);
        const p99 = sorted[Math.floor(sorted.length * 0.99)];
        console.log(
          `  ${i + 1}/${totalMessages} at ${elapsed.toFixed(0)}s, recent avg: ${recentAvg.toFixed(1)}ms, P99: ${p99.toFixed(1)}ms, errors: ${errors.length}`,
        );
      }
    }

    const totalTime = performance.now() - start;
    const sorted = [...latencies].sort((a, b) => a - b);

    console.log(`\nFinal Results:`);
    console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s (target: ${durationSeconds}s)`);
    console.log(`Errors: ${errors.length}`);
    console.log(`Throughput: ${(totalMessages / (totalTime / 1000)).toFixed(0)} msg/s`);
    console.log(`P50: ${sorted[Math.floor(sorted.length * 0.5)].toFixed(1)}ms`);
    console.log(`P95: ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)}ms`);
    console.log(`P99: ${sorted[Math.floor(sorted.length * 0.99)].toFixed(1)}ms`);
    console.log(`Max: ${sorted[sorted.length - 1].toFixed(1)}ms`);

    // Check degradation over time
    const segments = 10;
    const segmentSize = totalMessages / segments;
    console.log(`\nLatency by segment:`);
    for (let s = 0; s < segments; s++) {
      const segmentLatencies = latencies.slice(s * segmentSize, (s + 1) * segmentSize);
      const avg = segmentLatencies.reduce((a, b) => a + b, 0) / segmentLatencies.length;
      const segmentSorted = [...segmentLatencies].sort((a, b) => a - b);
      const p99 = segmentSorted[Math.floor(segmentSorted.length * 0.99)];
      console.log(`  ${s * 10}-${(s + 1) * 10}s: avg=${avg.toFixed(1)}ms, P99=${p99.toFixed(1)}ms`);
    }

    const stalls = latencies.filter((l) => l > 1000);
    if (stalls.length > 0) {
      console.log(`\nSTALLS (>1s): ${stalls.length}`);
    }

    await fetch(sustainedStreamUrl, { method: "DELETE" });

    expect(errors.length).toBe(0);
    expect(sorted[Math.floor(sorted.length * 0.99)]).toBeLessThan(500);
  }, 300000); // 5 minute timeout

  it("should handle burst of 1000 concurrent messages", async () => {
    const burstStreamPath = `burst-1000-${Date.now()}`;
    const burstStreamUrl = `${BASE_URL}/v1/stream/${burstStreamPath}`;

    await fetch(burstStreamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });

    const messageCount = 1000;
    const start = performance.now();

    console.log(`\n=== Burst: 1000 Concurrent Messages ===`);

    const promises = Array.from({ length: messageCount }, (_, i) =>
      fetch(burstStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": `burst-${i}`,
          "Producer-Epoch": "1",
          "Producer-Seq": "0",
        },
        body: `burst-${i}\n`,
      }).then((res) => ({
        index: i,
        status: res.status,
        ok: res.ok,
        time: performance.now() - start,
      })),
    );

    const results = await Promise.all(promises);
    const totalTime = performance.now() - start;

    const successful = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const times = results.map((r) => r.time).sort((a, b) => a - b);

    console.log(`Total time: ${totalTime.toFixed(0)}ms`);
    console.log(`Success: ${successful.length}, Failed: ${failed.length}`);
    console.log(`Time P50: ${times[Math.floor(times.length * 0.5)].toFixed(0)}ms`);
    console.log(`Time P99: ${times[Math.floor(times.length * 0.99)].toFixed(0)}ms`);
    console.log(`Time Max: ${times[times.length - 1].toFixed(0)}ms`);

    if (failed.length > 0) {
      const statusCounts = failed.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        },
        {} as Record<number, number>,
      );
      console.log(`Failure statuses:`, statusCounts);
    }

    await fetch(burstStreamUrl, { method: "DELETE" });

    expect(successful.length).toBe(messageCount);
  }, 60000);
});
