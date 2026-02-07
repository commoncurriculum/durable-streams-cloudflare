import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * cloudflare:workers is not available in vitest, so we can't import analytics.ts.
 * Instead, read the source as a string and verify the publish case has the
 * required behavior: it must call core.putStream() before adminPublish(), and
 * it must propagate error status from the publish result.
 */
describe("sendSessionAction publish case", () => {
  const source = readFileSync(
    resolve(__dirname, "../src/lib/analytics.ts"),
    "utf-8",
  );

  // Extract just the publish case block
  const publishCaseMatch = source.match(
    /case\s+"publish":\s*\{([\s\S]*?)\n\s{6}\}/,
  );
  const publishCase = publishCaseMatch?.[1] ?? "";

  it("ensures stream exists via core.putStream before publishing", () => {
    expect(publishCase).toContain("core.putStream(");
    // putStream must come before adminPublish
    const putIdx = publishCase.indexOf("core.putStream(");
    const pubIdx = publishCase.indexOf("adminPublish(");
    expect(putIdx).toBeGreaterThan(-1);
    expect(pubIdx).toBeGreaterThan(-1);
    expect(putIdx).toBeLessThan(pubIdx);
  });

  it("propagates error status from publish result", () => {
    expect(publishCase).toContain("result.status >= 400");
  });
});
