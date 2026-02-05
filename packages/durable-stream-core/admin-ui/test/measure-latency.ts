/**
 * Send 100 messages, watch browser console for debug info
 */

import { chromium } from "playwright";

const ADMIN_URL = "http://localhost:5173/admin/streams/testing-text";
const MESSAGE_COUNT = 20;

async function measureLatency() {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Capture ALL browser console messages
  page.on("console", (msg) => {
    const text = msg.text();
    console.log(`[BROWSER] ${text}`);
  });

  console.log(`\n=== Navigating to ${ADMIN_URL} ===`);
  await page.goto(ADMIN_URL);

  console.log("Waiting for page to load...");
  await page.waitForTimeout(3000);

  const textarea = page.getByPlaceholder("Type your message");
  await textarea.waitFor({ state: "visible", timeout: 10000 });

  const testId = Date.now();
  const markers: string[] = [];

  console.log(`\n=== Sending ${MESSAGE_COUNT} messages ===`);

  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const marker = `T${testId}-M${i + 1}`;
    markers.push(marker);

    await textarea.fill(marker);
    await textarea.press("Enter");
    console.log(`Sent: ${marker}`);
  }

  console.log(`\n=== All ${MESSAGE_COUNT} messages sent, waiting 5 seconds ===`);
  await page.waitForTimeout(5000);

  // Check page HTML for markers
  const html = await page.content();
  let appeared = 0;
  for (const marker of markers) {
    if (html.includes(marker)) {
      appeared++;
    }
  }
  console.log(`\n=== Result: ${appeared}/${MESSAGE_COUNT} appeared in HTML ===`);

  console.log("\nKeeping browser open for 20 seconds...");
  await page.waitForTimeout(20000);

  await browser.close();
}

measureLatency().catch(console.error);
