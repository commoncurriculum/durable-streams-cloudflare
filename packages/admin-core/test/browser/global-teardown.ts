import fs from "node:fs";
import path from "node:path";

const PID_FILE = path.resolve(import.meta.dirname, ".worker-pids.json");

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
}
