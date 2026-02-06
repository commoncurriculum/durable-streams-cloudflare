/**
 * Check the testing-text stream to see if messages are being stored
 */

import { DurableStream } from "@durable-streams/client";

const SERVER_URL = "http://localhost:8787";
const STREAM_PATH = "/testing-text";

async function checkStream() {
  const streamUrl = `${SERVER_URL}/v1/stream${STREAM_PATH}`;

  console.log(`=== Checking stream at ${streamUrl} ===`);

  const stream = new DurableStream({ url: streamUrl });

  // Get metadata
  const head = await stream.head();
  console.log(`\nMetadata:`);
  console.log(`  Content-Type: ${head.contentType}`);
  console.log(`  Length: ${head.length}`);
  console.log(`  Latest offset: ${head.offset}`);

  // Read entire stream
  console.log(`\n=== Reading full stream content ===`);
  const response = await stream.stream({ offset: "-1", live: false });

  let fullContent = "";

  await new Promise<void>((resolve) => {
    response.subscribeText((chunk) => {
      fullContent += chunk.text;
      return Promise.resolve();
    });

    setTimeout(resolve, 2000);
  });

  console.log(`\nTotal bytes: ${fullContent.length}`);

  // Look for specific test markers
  const markers = [
    "T1770241832596", // Browser test markers
    "T1770241698125", // Earlier test
    "TEST-MSG",       // Server test
  ];

  for (const marker of markers) {
    const count = (fullContent.match(new RegExp(marker, "g")) || []).length;
    console.log(`  ${marker}: ${count} occurrences`);
  }

  // Show last 1000 chars
  console.log(`\n=== Last 1000 chars ===`);
  console.log(fullContent.slice(-1000));
}

checkStream().catch(console.error);
