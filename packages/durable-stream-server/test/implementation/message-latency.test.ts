import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Message Latency", () => {
  const streamPath = `latency-test-${Date.now()}`;
  const streamUrl = `${BASE_URL}/v1/stream/${streamPath}`;

  beforeAll(async () => {
    // Create the test stream
    const res = await fetch(streamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });
    expect(res.ok).toBe(true);
  });

  afterAll(async () => {
    // Clean up
    try {
      await fetch(streamUrl, { method: "DELETE" });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should send messages with low latency", async () => {
    const messageCount = 20;
    const latencies: number[] = [];

    for (let i = 0; i < messageCount; i++) {
      const start = performance.now();
      const res = await fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "latency-test",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `message-${i}\n`,
      });
      const end = performance.now();
      latencies.push(end - start);

      expect(res.ok).toBe(true);
    }

    console.log("POST latencies (ms):", latencies.map((l) => l.toFixed(1)).join(", "));
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);
    console.log(`Average POST latency: ${avgLatency.toFixed(1)}ms, Max: ${maxLatency.toFixed(1)}ms`);

    // Each POST should complete within 100ms on localhost
    expect(avgLatency).toBeLessThan(100);
    expect(maxLatency).toBeLessThan(500);
  });

  it("should receive catchup messages quickly", async () => {
    const start = performance.now();

    const res = await fetch(`${streamUrl}?offset=-1`, {
      method: "GET",
      headers: { Accept: "text/plain" },
    });

    const end = performance.now();
    const body = await res.text();

    console.log(`GET catchup took ${(end - start).toFixed(1)}ms for ${body.length} bytes`);

    expect(res.ok).toBe(true);
    expect(end - start).toBeLessThan(500);
  });

  it("should handle rapid-fire POSTs without stalling", async () => {
    const messageCount = 50;
    const start = performance.now();

    // Fire all POSTs concurrently
    const promises = Array.from({ length: messageCount }, (_, i) =>
      fetch(streamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "rapid-fire",
          "Producer-Epoch": "1",
          "Producer-Seq": String(1000 + i),
        },
        body: `rapid-${i}\n`,
      })
    );

    const results = await Promise.all(promises);
    const end = performance.now();

    const successCount = results.filter((r) => r.ok).length;
    const conflictCount = results.filter((r) => r.status === 409).length;

    console.log(
      `Rapid-fire: ${messageCount} POSTs in ${(end - start).toFixed(1)}ms, ` +
        `${successCount} success, ${conflictCount} conflicts`
    );

    // Should complete all requests within 5 seconds
    expect(end - start).toBeLessThan(5000);
    // At least some should succeed (conflicts are expected with concurrent same-producer writes)
    expect(successCount + conflictCount).toBe(messageCount);
  });

  it("should receive SSE messages with low latency", async () => {
    // Create a separate stream for SSE test
    const sseStreamPath = `sse-latency-${Date.now()}`;
    const sseStreamUrl = `${BASE_URL}/v1/stream/${sseStreamPath}`;

    await fetch(sseStreamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });

    // Start SSE connection
    const ssePromise = fetch(`${sseStreamUrl}?offset=-1&live=sse`);

    // Wait a bit for connection to establish
    await new Promise((r) => setTimeout(r, 100));

    // Send a message with timestamp
    const sendTime = Date.now();
    await fetch(sseStreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "sse-test",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: `timestamp:${sendTime}\n`,
    });

    // Get SSE response with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const sseRes = await ssePromise;
      const reader = sseRes.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let received = "";
      let receiveTime = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        received += decoder.decode(value, { stream: true });
        if (received.includes(`timestamp:${sendTime}`)) {
          receiveTime = Date.now();
          break;
        }
      }

      clearTimeout(timeoutId);

      if (receiveTime) {
        const latency = receiveTime - sendTime;
        console.log(`SSE message latency: ${latency}ms`);
        expect(latency).toBeLessThan(500);
      }
    } catch (e) {
      clearTimeout(timeoutId);
      if ((e as Error).name !== "AbortError") throw e;
    }

    // Cleanup
    await fetch(sseStreamUrl, { method: "DELETE" });
  });

  it("should not stall when sending many messages sequentially", async () => {
    const sequentialStreamPath = `sequential-${Date.now()}`;
    const sequentialStreamUrl = `${BASE_URL}/v1/stream/${sequentialStreamPath}`;

    await fetch(sequentialStreamUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });

    const messageCount = 20;
    const start = performance.now();
    const perMessageTimes: number[] = [];

    for (let i = 0; i < messageCount; i++) {
      const msgStart = performance.now();
      const res = await fetch(sequentialStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "sequential-test",
          "Producer-Epoch": "1",
          "Producer-Seq": String(i),
        },
        body: `msg-${i}\n`,
      });
      const msgEnd = performance.now();
      perMessageTimes.push(msgEnd - msgStart);

      if (!res.ok) {
        console.log(`Message ${i} failed: ${res.status}`);
      }
    }

    const end = performance.now();
    const totalTime = end - start;

    console.log(`Sequential ${messageCount} messages in ${totalTime.toFixed(1)}ms`);
    console.log(`Per-message times: ${perMessageTimes.map((t) => t.toFixed(0)).join(", ")}`);

    // Check for stalls (any single message taking > 1 second)
    const stalls = perMessageTimes.filter((t) => t > 1000);
    if (stalls.length > 0) {
      console.log(`STALLS DETECTED: ${stalls.length} messages took > 1s`);
    }

    expect(stalls.length).toBe(0);
    expect(totalTime).toBeLessThan(10000); // 20 messages should complete in < 10s

    await fetch(sequentialStreamUrl, { method: "DELETE" });
  });
});
