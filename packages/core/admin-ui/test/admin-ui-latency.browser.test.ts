import { describe, it, expect } from "vitest";
import { page, userEvent, commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    navigateTo: (url: string) => Promise<void>;
  }
}

const ADMIN_URL = "http://localhost:5173/admin/streams/testing-text";

describe("Admin UI Message Latency", () => {
  it("should measure latency when entering 20 messages in succession", async () => {
    console.log("\n=== Navigating to admin UI ===");
    await commands.navigateTo(ADMIN_URL);

    // Wait for the page to load
    await new Promise((r) => setTimeout(r, 3000));

    // Find the textarea
    const textarea = page.getByRole("textbox");

    console.log("\n=== Entering 20 messages ===");
    const latencies: number[] = [];

    for (let i = 0; i < 20; i++) {
      const msg = `Test message ${i + 1} - ${Date.now()}`;
      const start = performance.now();

      // Clear and type the message
      await textarea.clear();
      await textarea.fill(msg);

      // Press Enter to send
      await userEvent.keyboard("{Enter}");

      // Wait a moment for the message to be sent
      await new Promise((r) => setTimeout(r, 200));

      const latency = performance.now() - start;
      latencies.push(latency);

      console.log(`Message ${i + 1}: ${latency.toFixed(0)}ms`);
    }

    // Calculate stats
    const sorted = [...latencies].sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];

    console.log("\n=== Results ===");
    console.log(`Average: ${avg.toFixed(0)}ms`);
    console.log(`P50: ${p50.toFixed(0)}ms`);
    console.log(`P95: ${p95.toFixed(0)}ms`);
    console.log(`Max: ${max.toFixed(0)}ms`);

    // Check for stalls (>1s is a stall)
    const stalls = latencies.filter((l) => l > 1000);
    if (stalls.length > 0) {
      console.log(`\nSTALLS (>1s): ${stalls.length}`);
      console.log(
        `Stall latencies: ${stalls.map((l) => l.toFixed(0)).join(", ")}ms`
      );
    }

    console.log(`\nStalls detected: ${stalls.length}`);
  }, 120000);

  it("should measure rapid message entry without waiting", async () => {
    console.log("\n=== Navigating to admin UI ===");
    await commands.navigateTo(ADMIN_URL);

    // Wait for the page to load
    await new Promise((r) => setTimeout(r, 3000));

    const textarea = page.getByRole("textbox");

    console.log("\n=== Rapid-fire 20 messages (no wait between) ===");
    const startAll = performance.now();
    const timestamps: number[] = [];

    for (let i = 0; i < 20; i++) {
      const msg = `Rapid ${i + 1}`;
      timestamps.push(performance.now() - startAll);

      await textarea.clear();
      await textarea.fill(msg);
      await userEvent.keyboard("{Enter}");
    }

    const totalTime = performance.now() - startAll;

    console.log("\n=== Timestamps ===");
    for (let i = 0; i < timestamps.length; i++) {
      const delta = i > 0 ? timestamps[i] - timestamps[i - 1] : timestamps[i];
      console.log(`Message ${i + 1}: ${timestamps[i].toFixed(0)}ms (delta: ${delta.toFixed(0)}ms)`);
    }

    console.log(`\nTotal time for 20 messages: ${totalTime.toFixed(0)}ms`);
    console.log(`Average per message: ${(totalTime / 20).toFixed(0)}ms`);
  }, 120000);
});
