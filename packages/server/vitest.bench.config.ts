import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    benchmark: {
      include: [path.resolve(__dirname, "test/benchmark/**/*.bench.ts")],
    },
    testTimeout: 330_000,
  },
});
