/**
 * Test server directly - send messages and verify they come back
 */

import { DurableStream, IdempotentProducer } from "@durable-streams/client";

const SERVER_URL = "http://localhost:8787";
const STREAM_PATH = "/testing-text";
const MESSAGE_COUNT = 20;

async function testServerRoundtrip() {
  const streamUrl = `${SERVER_URL}/v1/stream${STREAM_PATH}`;

  console.log(`\n=== Testing server at ${streamUrl} ===`);

  // Create stream client
  const stream = new DurableStream({ url: streamUrl });

  // Check if stream exists
  try {
    const head = await stream.head();
    console.log(`Stream exists: contentType=${head.contentType}, length=${head.length}`);
  } catch (e) {
    console.log(`Stream doesn't exist, creating...`);
    await DurableStream.create({ url: streamUrl, contentType: "text/plain" });
  }

  // Create producer
  const producer = new IdempotentProducer(stream, `test-${Date.now()}`, {
    autoClaim: true,
    lingerMs: 0,
  });

  // Start subscription BEFORE sending
  console.log(`\n=== Starting subscription ===`);
  const received: string[] = [];
  const subscribeStart = performance.now();

  const response = await stream.stream({ offset: "-1", live: "sse" });

  // Set up receiver
  const receiverPromise = new Promise<void>((resolve) => {
    let chunkCount = 0;
    response.subscribeText((chunk) => {
      chunkCount++;
      const elapsed = performance.now() - subscribeStart;
      console.log(`[RECV] Chunk #${chunkCount} at ${elapsed.toFixed(0)}ms: "${chunk.text.slice(0, 50)}..."`);

      if (chunk.text.includes("TEST-MSG-")) {
        const matches = chunk.text.match(/TEST-MSG-\d+/g);
        if (matches) {
          received.push(...matches);
          console.log(`[RECV] Found ${matches.length} markers, total received: ${received.length}`);
        }
      }

      // Stop when we've received all messages
      if (received.length >= MESSAGE_COUNT) {
        resolve();
      }

      return Promise.resolve();
    });
  });

  // Wait a moment for subscription to be ready
  await new Promise((r) => setTimeout(r, 500));

  // Send messages
  console.log(`\n=== Sending ${MESSAGE_COUNT} messages ===`);
  const sendStart = performance.now();

  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const msg = `TEST-MSG-${i + 1}\n`;
    await producer.append(msg);
    console.log(`[SEND] Sent: TEST-MSG-${i + 1}`);
  }

  const sendEnd = performance.now();
  console.log(`\nAll messages sent in ${(sendEnd - sendStart).toFixed(0)}ms`);

  // Wait for messages to arrive (max 10 seconds)
  console.log(`\n=== Waiting for messages to arrive ===`);
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), 10000)
  );

  try {
    await Promise.race([receiverPromise, timeout]);
    const totalTime = performance.now() - subscribeStart;
    console.log(`\n=== SUCCESS: Received ${received.length}/${MESSAGE_COUNT} messages in ${totalTime.toFixed(0)}ms ===`);
  } catch (e) {
    console.log(`\n=== TIMEOUT: Only received ${received.length}/${MESSAGE_COUNT} messages ===`);
    console.log(`Missing: ${MESSAGE_COUNT - received.length}`);
  }

  // Use detach() instead of close() - close() would close the stream permanently!
  await producer.detach();
}

testServerRoundtrip().catch(console.error);
