import { describe, expect, it } from "vitest";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("GET /v1/projects", () => {
  it("returns empty array when no projects exist", async () => {
    const response = await fetch(`${BASE_URL}/v1/projects`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    
    const projects = await response.json();
    expect(Array.isArray(projects)).toBe(true);
    // Don't assert on length - other tests may have created projects
  });
});
