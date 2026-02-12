import { startWorker } from "./worker_harness";

/**
 * Global setup for integration tests WITH Istanbul coverage collection.
 *
 * Identical to the standard global-setup.ts except it starts the worker
 * using wrangler.coverage.toml (pre-built instrumented bundle) and collects
 * coverage data from the worker during teardown.
 */
export default async function () {
  if (process.env.IMPLEMENTATION_TEST_URL) {
    return undefined;
  }

  const worker = await startWorker({
    configFile: "wrangler.coverage.toml",
  });

  process.env.IMPLEMENTATION_TEST_URL = worker.baseUrl;

  return async () => {
    // ── Collect coverage before stopping the worker ──────────────────────
    try {
      const response = await fetch(`${worker.baseUrl}/v1/stream/__coverage__`, {
        headers: { "X-Debug-Action": "coverage" },
      });

      if (response.ok) {
        const coverage = await response.json();
        const fileCount = Object.keys(coverage as Record<string, unknown>).length;
        console.log(`\n📊 Collected coverage for ${fileCount} file(s)`);

        // Write coverage JSON to .nyc_output so nyc can generate reports
        const fs = await import("node:fs");
        const path = await import("node:path");
        const { fileURLToPath } = await import("node:url");

        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const root = path.resolve(__dirname, "..", "..");
        const nycDir = path.join(root, ".nyc_output");

        fs.mkdirSync(nycDir, { recursive: true });
        fs.writeFileSync(path.join(nycDir, "out.json"), JSON.stringify(coverage, null, 2));

        console.log(`   Written to .nyc_output/out.json`);
        console.log(
          `   Run "pnpm exec nyc report --temp-dir .nyc_output --report-dir coverage-integration --reporter=text --reporter=html" to generate reports`,
        );
      } else {
        const body = await response.text();
        console.warn(`\n⚠️  Could not collect coverage (${response.status}): ${body}`);
        console.warn(`   Did the worker start with wrangler.coverage.toml?`);
      }
    } catch (err) {
      console.warn(`\n⚠️  Failed to collect coverage: ${(err as Error).message}`);
    }

    // ── Stop the worker ─────────────────────────────────────────────────
    await worker.stop();
  };
}
