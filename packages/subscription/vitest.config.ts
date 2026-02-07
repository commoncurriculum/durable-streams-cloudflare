import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        workers: [
          {
            name: "durable-streams", // matches [[services]] service name in wrangler.toml
            modules: true,
            scriptPath: path.resolve(__dirname, ".core-build/worker.js"),
            compatibilityDate: "2026-02-02",
            durableObjects: {
              STREAMS: { className: "StreamDO", useSQLite: true },
            },
            r2Buckets: ["R2"],
            kvNamespaces: ["PROJECT_KEYS"],
          },
        ],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
  },
});
