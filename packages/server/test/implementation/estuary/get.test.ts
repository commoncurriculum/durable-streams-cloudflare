import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary get", () => {
  it("can get estuary info with subscriptions", async () => {
    const projectId = "test-project";
    const sourceStreamId1 = uniqueStreamId("source1");
    const sourceStreamId2 = uniqueStreamId("source2");
    const estuaryId = crypto.randomUUID();

    // Create source streams
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId1}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId2}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe to both streams
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId1}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId2}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Get estuary info
    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId}`);

    expect(response.status).toBe(200);
    const result = (await response.json()) as any;

    expect(result).toMatchObject({
      estuaryId,
      estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
      contentType: "application/json",
    });

    expect(result.subscriptions).toBeInstanceOf(Array);
    expect(result.subscriptions).toHaveLength(2);

    const streamIds = result.subscriptions.map((s: { streamId: string }) => s.streamId);
    expect(streamIds).toContain(sourceStreamId1);
    expect(streamIds).toContain(sourceStreamId2);
  });

  it("returns error for non-existent estuary", async () => {
    const projectId = "test-project";
    const nonExistentEstuaryId = crypto.randomUUID();

    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${nonExistentEstuaryId}`);

    expect(response.status).toBe(500);
    const result = (await response.json()) as any;
    expect(result.error).toBeDefined();
  });

  it("validates estuaryId format", async () => {
    const projectId = "test-project";
    const invalidEstuaryId = "not-a-uuid";

    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${invalidEstuaryId}`);

    expect(response.status).toBe(500);
    const result = (await response.json()) as any;
    expect(result.error).toContain("Invalid estuaryId format");
  });
});
