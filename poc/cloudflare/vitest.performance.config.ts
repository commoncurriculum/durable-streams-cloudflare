import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: [path.resolve(__dirname, "test/performance/**/*.test.ts")],
    exclude: ["**/.git/**"],
    passWithNoTests: false,
    testTimeout: 60_000,
  },
});
