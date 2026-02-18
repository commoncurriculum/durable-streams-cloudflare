#!/usr/bin/env node
// scripts/coverage-lines.mjs
//
// Show uncovered lines for specific files or patterns.
//
// Usage:
//   node scripts/coverage-lines.mjs                           # All files with uncovered lines
//   node scripts/coverage-lines.mjs estuary                   # Files matching "estuary"
//   node scripts/coverage-lines.mjs src/http/v1/estuary/publish/index.ts  # Specific file
//   node scripts/coverage-lines.mjs --zero                    # Only files with 0% coverage
//   node scripts/coverage-lines.mjs --below 50                # Files below 50% coverage
//
// Shows:
//   - File path and coverage %
//   - Exact line numbers that are uncovered
//   - Total uncovered line count per file

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const COVERAGE_FILE = path.join(ROOT, ".nyc_output_merged", "out.json");
const SUMMARY_FILE = path.join(ROOT, "coverage-combined", "coverage-summary.json");

// Parse args (filter out npm's -- separator)
const args = process.argv.slice(2).filter((arg) => arg !== "--");
let filterPattern = null;
let onlyZero = false;
let belowThreshold = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--zero") {
    onlyZero = true;
  } else if (args[i] === "--below") {
    belowThreshold = Number.parseFloat(args[++i]);
  } else {
    filterPattern = args[i];
  }
}

// Check if coverage exists
if (!fs.existsSync(COVERAGE_FILE) || !fs.existsSync(SUMMARY_FILE)) {
  console.error("❌ Coverage data not found. Run coverage first:\n");
  console.error("  pnpm run test:coverage-all\n");
  process.exit(1);
}

// Load coverage data
const coverageData = JSON.parse(fs.readFileSync(COVERAGE_FILE, "utf8"));
const summaryData = JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8"));

// Process each file
const results = [];

for (const [filePath, coverage] of Object.entries(coverageData)) {
  const relativePath = path.relative(ROOT, filePath);

  // Skip if not in src/
  if (!relativePath.startsWith("src/")) continue;

  // Apply filter
  if (filterPattern && !relativePath.includes(filterPattern)) continue;

  // Get summary stats
  const summary = summaryData[filePath];
  if (!summary) continue;

  const linePct = summary.lines.pct;

  // Apply threshold filters
  if (onlyZero && linePct !== 0) continue;
  if (belowThreshold !== null && linePct >= belowThreshold) continue;

  // Find uncovered lines
  const uncoveredLines = [];
  const statementMap = coverage.statementMap || {};
  const statementCounts = coverage.s || {};

  for (const [stmtId, count] of Object.entries(statementCounts)) {
    if (count === 0) {
      const loc = statementMap[stmtId];
      if (loc && loc.start && loc.start.line) {
        // Store line number (may have duplicates for multi-line statements)
        uncoveredLines.push(loc.start.line);
      }
    }
  }

  // Deduplicate and sort
  const uniqueLines = [...new Set(uncoveredLines)].sort((a, b) => a - b);

  // Format line ranges (e.g., "10-15, 20, 25-30")
  const lineRanges = [];
  let rangeStart = uniqueLines[0];
  let rangeLast = uniqueLines[0];

  for (let i = 1; i < uniqueLines.length; i++) {
    const line = uniqueLines[i];
    if (line === rangeLast + 1) {
      // Continue range
      rangeLast = line;
    } else {
      // End range, start new
      if (rangeStart === rangeLast) {
        lineRanges.push(`${rangeStart}`);
      } else {
        lineRanges.push(`${rangeStart}-${rangeLast}`);
      }
      rangeStart = line;
      rangeLast = line;
    }
  }

  // Add final range
  if (uniqueLines.length > 0) {
    if (rangeStart === rangeLast) {
      lineRanges.push(`${rangeStart}`);
    } else {
      lineRanges.push(`${rangeStart}-${rangeLast}`);
    }
  }

  results.push({
    path: relativePath,
    coverage: linePct,
    uncoveredCount: uniqueLines.length,
    uncoveredLines: uniqueLines,
    lineRanges: lineRanges.join(", "),
    totalLines: summary.lines.total,
    coveredLines: summary.lines.covered,
  });
}

// Sort by coverage (lowest first)
results.sort((a, b) => a.coverage - b.coverage);

// Display
if (results.length === 0) {
  console.log("\n✅ No files match the criteria.\n");
  process.exit(0);
}

console.log(`\n${"=".repeat(100)}`);
console.log(`  Uncovered Lines Report`);
if (filterPattern) console.log(`  Filter: "${filterPattern}"`);
if (onlyZero) console.log(`  Showing: Files with 0% coverage only`);
if (belowThreshold !== null) console.log(`  Showing: Files below ${belowThreshold}% coverage`);
console.log(`${"=".repeat(100)}\n`);

console.log(`Found ${results.length} file(s) with uncovered lines\n`);
console.log(`${"─".repeat(100)}\n`);

for (const result of results) {
  const covStr = result.coverage.toFixed(1).padStart(5);
  const countStr = `${result.uncoveredCount}`.padStart(4);
  const totalStr = `${result.totalLines}`.padStart(4);

  console.log(`📄 ${result.path}`);
  console.log(`   Coverage:  ${covStr}%  (${result.coveredLines}/${totalStr} lines covered)`);
  console.log(`   Uncovered: ${countStr} line(s)`);

  if (result.uncoveredLines.length > 0) {
    console.log(`   Lines:     ${result.lineRanges}`);
  }

  console.log();
}

console.log(`${"─".repeat(100)}\n`);

// Summary stats
const totalUncovered = results.reduce((sum, r) => sum + r.uncoveredCount, 0);
const avgCoverage = results.reduce((sum, r) => sum + r.coverage, 0) / results.length;

console.log(`📊 Summary\n`);
console.log(`   Files:          ${results.length}`);
console.log(`   Avg coverage:   ${avgCoverage.toFixed(1)}%`);
console.log(`   Total uncovered lines: ${totalUncovered}`);
console.log(`   Files with 0%:  ${results.filter((r) => r.coverage === 0).length}`);
console.log(`   Files with <50%: ${results.filter((r) => r.coverage < 50).length}`);

console.log(`\n${"=".repeat(100)}\n`);

// Show example of how to view specific file
if (results.length > 0 && !filterPattern) {
  const example = results[0].path;
  console.log(`💡 Tip: View specific file with:\n`);
  console.log(`   node scripts/coverage-lines.mjs "${example}"\n`);
  console.log(`   Or view all estuary files:\n`);
  console.log(`   node scripts/coverage-lines.mjs estuary\n`);
}
