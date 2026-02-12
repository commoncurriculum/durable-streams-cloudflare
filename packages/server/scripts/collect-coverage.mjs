// scripts/collect-coverage.mjs
//
// Collects Istanbul coverage data from a running instrumented worker and
// generates reports via nyc.
//
// Usage:
//   node scripts/collect-coverage.mjs [base-url]
//
// The base-url defaults to $IMPLEMENTATION_TEST_URL or http://localhost:8787.
//
// The script:
//   1. Sends GET / with X-Debug-Action: coverage to the worker
//   2. Writes the coverage JSON to .nyc_output/out.json
//   3. Runs `nyc report` to produce text + HTML reports
//
// Designed to be called from a vitest globalTeardown or manually after a test run.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const baseUrl =
  process.argv[2] ||
  process.env.IMPLEMENTATION_TEST_URL ||
  "http://localhost:8787";

async function main() {
  // ── 1. Fetch coverage from the worker ─────────────────────────────────
  console.log(`\n📊 Collecting coverage from ${baseUrl} …`);

  let response;
  try {
    response = await fetch(`${baseUrl}/v1/stream/__coverage__`, {
      headers: { "X-Debug-Action": "coverage" },
    });
  } catch (err) {
    console.error(
      `❌ Could not reach worker at ${baseUrl}. Is it still running?\n`,
      err.message,
    );
    process.exit(1);
  }

  if (response.status === 404) {
    const body = await response.text();
    console.error(
      "❌ Worker returned 404 — coverage data not available.\n" +
        "   Did you start the worker with wrangler.coverage.toml?\n" +
        `   Response: ${body}`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `❌ Unexpected response: ${response.status} ${response.statusText}`,
    );
    console.error(await response.text());
    process.exit(1);
  }

  const coverage = await response.json();
  const fileCount = Object.keys(coverage).length;
  console.log(`   Received coverage for ${fileCount} file(s).`);

  // ── 2. Write to .nyc_output ───────────────────────────────────────────
  const nycDir = path.join(ROOT, ".nyc_output");
  fs.mkdirSync(nycDir, { recursive: true });

  const outPath = path.join(nycDir, "out.json");
  fs.writeFileSync(outPath, JSON.stringify(coverage, null, 2));
  console.log(`   Written to ${path.relative(ROOT, outPath)}`);

  // ── 3. Generate reports via nyc ───────────────────────────────────────
  console.log("\n📝 Generating coverage reports …\n");

  const nycBin = path.join(ROOT, "node_modules", ".bin", "nyc");
  const reportCmd = [
    nycBin,
    "report",
    "--reporter=text",
    "--reporter=html",
    "--reporter=json-summary",
    `--report-dir=${path.join(ROOT, "coverage-integration")}`,
    `--temp-dir=${nycDir}`,
    // Source files live under src/ — tell nyc where to look
    `--cwd=${ROOT}`,
    "--include=src/**",
    "--exclude=src/**/*.d.ts",
    "--exclude=src/**/types.ts",
    "--exclude=src/**/schema.ts",
  ].join(" ");

  try {
    execSync(reportCmd, {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    console.error(
      "\n⚠️  nyc report failed. You may need to run: pnpm exec nyc report --temp-dir .nyc_output",
    );
    process.exit(1);
  }

  console.log(
    `\n✅ HTML report: ${path.relative(ROOT, path.join(ROOT, "coverage-integration", "index.html"))}`,
  );
}

main();
