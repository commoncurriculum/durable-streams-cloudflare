// scripts/merge-coverage.mjs
//
// Merges unit test coverage (from @vitest/coverage-istanbul) and integration
// test coverage (from our Istanbul-instrumented wrangler bundle) into a single
// combined report.
//
// Usage (from packages/server):
//   node scripts/merge-coverage.mjs
//
// Prerequisites:
//   1. Run unit tests with coverage:
//        pnpm run test:coverage
//      → produces coverage/coverage-final.json (absolute paths)
//
//   2. Run integration tests with coverage:
//        pnpm run test:implementation-coverage
//      → produces .nyc_output/out.json (relative paths)
//
// Output:
//   coverage-combined/          — HTML + text + JSON reports
//   .nyc_output_merged/out.json — merged raw coverage (for further processing)

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();

const UNIT_COVERAGE = path.join(ROOT, "coverage", "coverage-final.json");
const INTEGRATION_COVERAGE = path.join(ROOT, ".nyc_output", "out.json");
const MERGED_DIR = path.join(ROOT, ".nyc_output_merged");
const REPORT_DIR = path.join(ROOT, "coverage-combined");

// ── 1. Validate inputs ──────────────────────────────────────────────────────

const missing = [];
if (!fs.existsSync(UNIT_COVERAGE)) missing.push(UNIT_COVERAGE);
if (!fs.existsSync(INTEGRATION_COVERAGE)) missing.push(INTEGRATION_COVERAGE);

if (missing.length > 0) {
  console.error("❌ Missing coverage file(s):\n");
  for (const f of missing) {
    console.error(`   ${path.relative(ROOT, f)}`);
  }
  console.error("\nRun both test suites first:");
  console.error("  pnpm run test:coverage                 # unit tests");
  console.error("  pnpm run test:implementation-coverage   # integration tests");
  process.exit(1);
}

// ── 2. Load and normalize paths ─────────────────────────────────────────────

console.log("\n📊 Merging coverage data …\n");

const unitRaw = JSON.parse(fs.readFileSync(UNIT_COVERAGE, "utf8"));
const integrationRaw = JSON.parse(fs.readFileSync(INTEGRATION_COVERAGE, "utf8"));

/**
 * Normalize all file paths in a coverage object to absolute paths rooted at ROOT.
 * Istanbul coverage objects are keyed by file path, and each entry has a `path` field.
 */
function normalizePaths(coverageData) {
  const result = {};
  for (const [key, entry] of Object.entries(coverageData)) {
    // Resolve to absolute — already-absolute paths stay unchanged,
    // relative paths like "src/foo.ts" become "/abs/.../src/foo.ts"
    const absPath = path.resolve(ROOT, entry.path);
    result[absPath] = {
      ...entry,
      path: absPath,
    };
  }
  return result;
}

const unitNormalized = normalizePaths(unitRaw);
const integrationNormalized = normalizePaths(integrationRaw);

const unitFileCount = Object.keys(unitNormalized).length;
const integrationFileCount = Object.keys(integrationNormalized).length;

console.log(`   Unit coverage:        ${unitFileCount} file(s)`);
console.log(`   Integration coverage: ${integrationFileCount} file(s)`);

// ── 3. Merge coverage maps ──────────────────────────────────────────────────
//
// Istanbul coverage format: each file has statementMap, s, fnMap, f, branchMap, b.
// The `s`, `f`, and `b` objects contain hit counts keyed by index.
// To merge, we add the hit counts together for files that appear in both sets.

const allFiles = new Set([
  ...Object.keys(unitNormalized),
  ...Object.keys(integrationNormalized),
]);

const merged = {};
let onlyUnit = 0;
let onlyIntegration = 0;
let both = 0;

for (const filePath of allFiles) {
  const unit = unitNormalized[filePath];
  const integration = integrationNormalized[filePath];

  if (unit && !integration) {
    merged[filePath] = unit;
    onlyUnit++;
  } else if (!unit && integration) {
    merged[filePath] = integration;
    onlyIntegration++;
  } else {
    // Both exist — merge hit counts. Use integration's maps as the base
    // (they come from the same Istanbul instrumenter version) and add unit counts.
    // If the maps differ (different instrumenter versions), we fall back to
    // taking the max of each counter to avoid undercounting.
    const m = { ...integration };

    // Merge statement counts
    m.s = { ...integration.s };
    for (const [idx, count] of Object.entries(unit.s)) {
      m.s[idx] = (m.s[idx] || 0) + count;
    }

    // Merge function counts
    m.f = { ...integration.f };
    for (const [idx, count] of Object.entries(unit.f)) {
      m.f[idx] = (m.f[idx] || 0) + count;
    }

    // Merge branch counts
    m.b = { ...integration.b };
    for (const [idx, counts] of Object.entries(unit.b)) {
      if (!m.b[idx]) {
        m.b[idx] = counts;
      } else {
        m.b[idx] = m.b[idx].map((v, i) => v + (counts[i] || 0));
      }
    }

    merged[filePath] = m;
    both++;
  }
}

console.log(
  `\n   Merged: ${both} shared, ${onlyUnit} unit-only, ${onlyIntegration} integration-only`,
);
console.log(`   Total:  ${Object.keys(merged).length} file(s)`);

// ── 4. Write merged coverage to temp dir ────────────────────────────────────

fs.mkdirSync(MERGED_DIR, { recursive: true });
const mergedPath = path.join(MERGED_DIR, "out.json");
fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
console.log(`\n   Written to ${path.relative(ROOT, mergedPath)}`);

// ── 5. Generate reports via nyc ─────────────────────────────────────────────

console.log("\n📝 Generating combined coverage reports …\n");

const nycBin = path.join(ROOT, "node_modules", ".bin", "nyc");
const reportCmd = [
  nycBin,
  "report",
  "--reporter=text",
  "--reporter=html",
  "--reporter=json-summary",
  `--report-dir=${REPORT_DIR}`,
  `--temp-dir=${MERGED_DIR}`,
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
  console.error("\n⚠️  nyc report failed.");
  process.exit(1);
}

console.log(
  `\n✅ Combined coverage report: ${path.relative(ROOT, path.join(REPORT_DIR, "index.html"))}`,
);
