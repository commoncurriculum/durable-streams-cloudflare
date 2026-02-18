import { describe, expect, it } from "vitest";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("GET /v1/projects", () => {
  it("returns empty array when no projects exist", async () => {
    const response = await fetch(`${BASE_URL}/v1/projects`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    
    const projects = await response.json();
    expect(Array.isArray(projects)).toBe(true);
  });

  it("returns list of project IDs after creating projects", async () => {
    // Create a project by setting its config
    const projectId = `test-project-${crypto.randomUUID()}`;
    const configResponse = await fetch(`${BASE_URL}/v1/config/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: [],
        isPublic: false,
      }),
    });
    expect(configResponse.status).toBe(200);

    // Now list projects
    const listResponse = await fetch(`${BASE_URL}/v1/projects`);
    expect(listResponse.status).toBe(200);
    
    const projects = await listResponse.json();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects).toContain(projectId);
  });
});
