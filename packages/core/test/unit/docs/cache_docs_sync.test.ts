import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..", "docs");

describe("cdn-cache-flow.md documents correct cache policy", () => {
  const doc = readFileSync(path.join(DOCS_ROOT, "cdn-cache-flow.md"), "utf-8");
  // Normalize whitespace within each row for easier matching
  const rows = doc.split("\n").map((line) => line.replace(/\s+/g, " ").trim());

  it("documents that at-tail plain GET is NOT cached", () => {
    const row = rows.find(
      (r) => r.includes("at tail") && !r.includes("long-poll") && !r.includes("204"),
    );
    expect(row).toBeTruthy();
    expect(row).toContain("No");
  });

  it("documents that at-tail long-poll 200s are cached", () => {
    const longPollTailRow = rows.find(
      (r) => r.includes("long-poll") && r.includes("at tail") && r.includes("200"),
    );
    expect(longPollTailRow).toBeTruthy();
    expect(longPollTailRow).toContain("Yes");
  });

  it("documents that 204 timeout is NOT cached", () => {
    const row = rows.find((r) => r.includes("204"));
    expect(row).toBeTruthy();
    expect(row).toContain("No");
  });

  it("documents that offset=now is NOT cached", () => {
    const row = rows.find((r) => r.includes("offset=now"));
    expect(row).toBeTruthy();
    expect(row).toContain("No");
  });

  it("documents the X-Cache header", () => {
    expect(doc).toContain("X-Cache");
  });
});
