import fs from "node:fs";
import path from "node:path";

const PID_FILE = path.resolve(import.meta.dirname, ".worker-pids.json");
const SUBSCRIPTION_ROOT = path.resolve(import.meta.dirname, "../../../subscription");

export default async function globalTeardown() {
  try {
    const data = JSON.parse(fs.readFileSync(PID_FILE, "utf-8"));
    for (const pid of data.pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already dead
      }
    }
    fs.unlinkSync(PID_FILE);
  } catch {
    // file doesn't exist or parse error — nothing to clean up
  }

  // Clean up temp wrangler config
  try {
    fs.unlinkSync(path.join(SUBSCRIPTION_ROOT, "wrangler.test.toml"));
  } catch {
    // already cleaned or never created
  }
}
