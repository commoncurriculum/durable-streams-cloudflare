import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PID_FILE = path.join(ROOT, "test/browser/.worker-pids.json");

export default async function globalTeardown() {
  if (!fs.existsSync(PID_FILE)) return;

  const { pids } = JSON.parse(fs.readFileSync(PID_FILE, "utf-8"));
  for (const pid of pids) {
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already dead
      }
    }
  }

  fs.unlinkSync(PID_FILE);
}
