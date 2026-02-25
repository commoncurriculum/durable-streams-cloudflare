import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  globalSetup: "test/browser/global-setup.ts",
  globalTeardown: "test/browser/global-teardown.ts",
  timeout: 60_000,
  workers: 1,
  retries: 1,
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
