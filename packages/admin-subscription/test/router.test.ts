import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("router", () => {
  const routerSource = readFileSync(resolve(__dirname, "../src/router.tsx"), "utf-8");

  it("exports getRouter (required by TanStack Start server handler)", () => {
    expect(routerSource).toMatch(/export\s+function\s+getRouter\b/);
  });
});
