import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import type { BrowserCommand } from "vitest/node";

const navigateTo: BrowserCommand<[string]> = async (ctx, url: string) => {
  if (ctx.provider.name === "playwright") {
    const page = ctx.page;
    await page.goto(url);
  } else {
    throw new Error(`provider ${ctx.provider.name} is not supported`);
  }
};

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      commands: {
        navigateTo,
      },
    },
    include: ["test/**/*.browser.test.ts"],
  },
});
