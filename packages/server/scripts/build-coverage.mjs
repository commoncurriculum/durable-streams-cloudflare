// scripts/build-coverage.mjs
//
// Builds the integration test worker with Istanbul code coverage instrumentation
// applied to all src/ files. The output is a single ESM bundle that wrangler can
// load directly (no further TS compilation needed).
//
// Usage (from packages/server):
//   node scripts/build-coverage.mjs
//
// The instrumented worker exposes globalThis.__coverage__ which accumulates
// hit counts across requests. A debug action ("X-Debug-Action: coverage")
// in the test worker returns this data as JSON so the test harness can
// collect it after a run and feed it to `nyc report`.

import * as esbuild from "esbuild";
import { createInstrumenter } from "istanbul-lib-instrument";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();

const instrumenter = createInstrumenter({
  esModules: true,
  compact: false,
  coverageVariable: "__coverage__",
  coverageGlobalScope: "globalThis",
  coverageGlobalScopeFunc: false,
  preserveComments: true,
});

let instrumentedCount = 0;
let skippedCount = 0;

const istanbulPlugin = {
  name: "istanbul-instrument",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      const rel = path.relative(ROOT, args.path);
      if (!rel.startsWith("src/") && !rel.startsWith("src\\")) {
        skippedCount++;
        return undefined;
      }

      const source = await fs.promises.readFile(args.path, "utf8");

      const { code } = await esbuild.transform(source, {
        loader: "ts",
        target: "esnext",
        format: "esm",
      });

      const instrumented = instrumenter.instrumentSync(code, rel);
      instrumentedCount++;

      return {
        contents: instrumented,
        loader: "js",
      };
    });
  },
};

const outfile = path.join(ROOT, "dist", "test-worker-instrumented.js");

await esbuild.build({
  entryPoints: [path.join(ROOT, "test/implementation/test-worker.ts")],
  bundle: true,
  outfile,
  format: "esm",
  target: "esnext",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import"],
  external: ["cloudflare:workers", "cloudflare:test", "node:*"],
  loader: {
    ".sql": "text",
  },
  sourcemap: true,
  minify: false,
  treeShaking: false,
  logLevel: "info",
  plugins: [istanbulPlugin],
});

// ── Post-build: patch out ArkType's `new Function()` CSP detection ──────────
//
// ArkType uses `new Function("return false")()` lazily via a `cached()` wrapper
// to detect Content-Security-Policy restrictions. In wrangler's own esbuild
// pipeline the module structure ensures this runs during startup (where eval is
// allowed). In our pre-built bundle the lazy evaluation can fire during a
// request handler, which workerd blocks with:
//   "Code generation from strings disallowed for this context"
//
// We know Workers restrict eval at request time, so we replace the detection
// with the hard-coded answer: `envHasCsp = true`.
let bundle = fs.readFileSync(outfile, "utf8");
const before = bundle.length;
bundle = bundle.replace(
  /envHasCsp\s*=\s*cached\(\s*\(\)\s*=>\s*\{[\s\S]*?new\s+Function\([\s\S]*?\}\s*\)/,
  "envHasCsp = cached(() => true)",
);
if (bundle.length !== before) {
  fs.writeFileSync(outfile, bundle);
  console.log("Patched ArkType CSP detection (new Function → true)");
}

console.log("");
console.log("Instrumented " + instrumentedCount + " file(s), skipped " + skippedCount + " file(s)");
console.log("Output: " + path.relative(ROOT, outfile));
