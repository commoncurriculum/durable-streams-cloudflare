#!/usr/bin/env node
// scripts/coverage-summary.mjs
//
// Displays a quick, human-readable coverage summary.
//
// Usage:
//   node scripts/coverage-summary.mjs                    # combined coverage
//   node scripts/coverage-summary.mjs unit               # unit tests only
//   node scripts/coverage-summary.mjs integration        # integration tests only
//
// Shows:
//   - Overall coverage percentage
//   - Top 10 best covered files
//   - Top 10 worst covered files (excluding 0%)
//   - Files with 0% coverage grouped by area

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const mode = process.argv[2] || "combined";

let summaryPath;
let title;

switch (mode) {
  case "unit":
    summaryPath = path.join(ROOT, "coverage", "coverage-summary.json");
    title = "Unit Test Coverage";
    break;
  case "integration":
    summaryPath = path.join(ROOT, "coverage-integration", "coverage-summary.json");
    title = "Integration Test Coverage";
    break;
  case "combined":
    summaryPath = path.join(ROOT, "coverage-combined", "coverage-summary.json");
    title = "Combined Coverage (Unit + Integration)";
    break;
  default:
    console.error(`Unknown mode: ${mode}`);
    console.error("Usage: node scripts/coverage-summary.mjs [unit|integration|combined]");
    process.exit(1);
}

if (!fs.existsSync(summaryPath)) {
  console.error(`❌ Coverage summary not found: ${path.relative(ROOT, summaryPath)}`);
  console.error("\nRun coverage first:");
  if (mode === "unit") {
    console.error("  pnpm run test:coverage");
  } else if (mode === "integration") {
    console.error("  pnpm run test:implementation-coverage");
  } else {
    console.error("  pnpm run test:coverage-all");
  }
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

// ── Extract total and per-file stats ────────────────────────────────────────

const total = data.total;
const files = [];

for (const [filePath, stats] of Object.entries(data)) {
  if (filePath === "total") continue;

  const relativePath = path.relative(ROOT, filePath);

  // Skip if not in src/
  if (!relativePath.startsWith("src/")) continue;

  files.push({
    path: relativePath,
    lines: stats.lines.pct,
    statements: stats.statements.pct,
    branches: stats.branches.pct,
    functions: stats.functions.pct,
  });
}

// ── Categorize files ────────────────────────────────────────────────────────

const zeroCoverage = files.filter((f) => f.lines === 0);
const nonZero = files.filter((f) => f.lines > 0);

// Sort by line coverage
nonZero.sort((a, b) => b.lines - a.lines);

const best = nonZero.slice(0, 10);
const worst = nonZero.slice(-10).reverse();

// Group zero coverage files by area
const zeroByArea = {};
for (const file of zeroCoverage) {
  // Extract area from path: src/http/middleware/cors.ts → http/middleware
  const parts = file.path.split("/").slice(1, -1); // Remove "src" and filename
  const area = parts.join("/") || "root";

  if (!zeroByArea[area]) zeroByArea[area] = [];
  zeroByArea[area].push(file.path);
}

// ── Display ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(80)}`);
console.log(`  ${title}`);
console.log(`${"=".repeat(80)}\n`);

console.log("📊 Overall Coverage\n");
console.log(
  `   Lines:      ${total.lines.pct.toFixed(2).padStart(6)}%  (${total.lines.covered} / ${total.lines.total})`,
);
console.log(
  `   Statements: ${total.statements.pct.toFixed(2).padStart(6)}%  (${total.statements.covered} / ${total.statements.total})`,
);
console.log(
  `   Branches:   ${total.branches.pct.toFixed(2).padStart(6)}%  (${total.branches.covered} / ${total.branches.total})`,
);
console.log(
  `   Functions:  ${total.functions.pct.toFixed(2).padStart(6)}%  (${total.functions.covered} / ${total.functions.total})`,
);

console.log(`\n${"─".repeat(80)}\n`);

console.log("✅ Top 10 Best Covered Files\n");
for (const file of best) {
  const bar = "█".repeat(Math.floor(file.lines / 5));
  console.log(`   ${file.lines.toFixed(1).padStart(5)}%  ${bar.padEnd(20)} ${file.path}`);
}

console.log(`\n${"─".repeat(80)}\n`);

console.log("⚠️  Top 10 Worst Covered Files (excluding 0%)\n");
for (const file of worst) {
  const bar = "▓".repeat(Math.floor(file.lines / 5));
  console.log(`   ${file.lines.toFixed(1).padStart(5)}%  ${bar.padEnd(20)} ${file.path}`);
}

if (zeroCoverage.length > 0) {
  console.log(`\n${"─".repeat(80)}\n`);
  console.log(`❌ Files with 0% Coverage (${zeroCoverage.length} files)\n`);

  for (const [area, paths] of Object.entries(zeroByArea).sort()) {
    console.log(`   ${area}/`);
    for (const p of paths) {
      const filename = path.basename(p);
      console.log(`      - ${filename}`);
    }
  }
}

console.log(`\n${"─".repeat(80)}\n`);

console.log("📝 Summary\n");
console.log(`   Total files:        ${files.length}`);
console.log(`   Files with 0%:      ${zeroCoverage.length}`);
console.log(`   Files with >0%:     ${nonZero.length}`);
console.log(`   Files with >50%:    ${nonZero.filter((f) => f.lines > 50).length}`);
console.log(`   Files with >80%:    ${nonZero.filter((f) => f.lines > 80).length}`);
console.log(`   Files with 100%:    ${nonZero.filter((f) => f.lines === 100).length}`);

console.log(`\n${"=".repeat(80)}\n`);

// ── Priority areas needing tests ────────────────────────────────────────────

const priorities = [
  {
    name: "Estuary endpoints",
    pattern: /^src\/http\/v1\/estuary\//,
    priority: "🔴 CRITICAL",
  },
  {
    name: "Stream append",
    pattern: /^src\/http\/v1\/streams\/append\//,
    priority: "🔴 CRITICAL",
  },
  {
    name: "Stream delete",
    pattern: /^src\/http\/v1\/streams\/delete\//,
    priority: "🔴 HIGH",
  },
  {
    name: "Stream DO operations",
    pattern: /^src\/storage\/stream-do\/(append-batch|read-messages|read-result)\.ts$/,
    priority: "🔴 HIGH",
  },
  {
    name: "Queue consumer",
    pattern: /^src\/queue\//,
    priority: "🟠 MEDIUM",
  },
  {
    name: "Metrics",
    pattern: /^src\/metrics\//,
    priority: "🟡 LOW",
  },
];

console.log("🎯 Priority Areas for Testing\n");

for (const { name, pattern, priority } of priorities) {
  const matches = files.filter((f) => pattern.test(f.path));
  const avgCoverage = matches.length > 0 ? matches.reduce((sum, f) => sum + f.lines, 0) / matches.length : 0;

  console.log(`   ${priority}  ${name.padEnd(30)} ${avgCoverage.toFixed(1).padStart(5)}%`);
}

console.log(`\n${"=".repeat(80)}\n`);
