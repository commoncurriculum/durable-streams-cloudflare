import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_CWD = path.resolve(__dirname, "..", "..", "core");
const LOCAL_CORE_BUILD = path.resolve(__dirname, "..", ".core-build");

export default function () {
  console.time("Built core worker");
  childProcess.execSync(
    "pnpm exec wrangler deploy --dry-run --outdir .wrangler/build",
    { cwd: CORE_CWD, stdio: "inherit" },
  );
  console.timeEnd("Built core worker");

  // Copy built worker into subscription package so miniflare can access it
  // (workerd rejects paths that escape the starting directory via "..")
  fs.mkdirSync(LOCAL_CORE_BUILD, { recursive: true });
  fs.copyFileSync(
    path.resolve(CORE_CWD, ".wrangler/build/worker.js"),
    path.resolve(LOCAL_CORE_BUILD, "worker.js"),
  );
}
