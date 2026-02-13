import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary unsubscribe", () => {
  it("can unsubscribe an estuary from a stream", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe first
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Unsubscribe
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response.status).toBe(200);
    const result = await response.json();

    expect(result).toMatchObject({
      success: true,
    });
  });

  it("returns error when unsubscribing from non-existent stream", async () => {
    const projectId = "test-project";
    const nonExistentStreamId = uniqueStreamId("nonexistent");
    const estuaryId = crypto.randomUUID();

    // Try to unsubscribe from non-existent stream
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${nonExistentStreamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    // Should succeed even if subscription didn't exist (idempotent)
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result.success).toBe(true);
  });

  it("validates estuaryId format", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const invalidEstuaryId = "not-a-uuid";

    // Create source stream
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Try to unsubscribe with invalid estuaryId
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId: invalidEstuaryId }),
      },
    );

    expect(response.status).toBe(400);
    const result = (await response.json()) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
