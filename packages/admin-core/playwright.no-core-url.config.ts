import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  testMatch: "stream-detail-no-core-url.test.ts",
  timeout: 120_000,
  workers: 1,
  retries: 0,
  use: {
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
