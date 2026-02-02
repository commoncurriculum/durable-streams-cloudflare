import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    include: [
      path.resolve(
        __dirname,
        "node_modules/@durable-streams/server-conformance-tests/dist/test-runner.js"
      ),
    ],
    exclude: ["**/.git/**"],
    passWithNoTests: false,
  },
})
