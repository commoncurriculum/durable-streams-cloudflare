import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary delete", () => {
  it("can delete an estuary stream", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${sourceStreamId}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe to create the estuary
    await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId }),
    });

    // Delete the estuary
    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as any;

    expect(result).toMatchObject({
      estuaryId,
      deleted: true,
    });
  });

  it("can delete estuary with multiple subscriptions", async () => {
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

    // Delete the estuary
    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    const result = (await response.json()) as any;

    expect(result).toMatchObject({
      estuaryId,
      deleted: true,
    });
  });

  it("succeeds when deleting non-existent estuary (idempotent)", async () => {
    const projectId = "test-project";
    const nonExistentEstuaryId = crypto.randomUUID();

    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${nonExistentEstuaryId}`, {
      method: "DELETE",
    });

    // Delete is idempotent - succeeds even if estuary doesn't exist
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result).toMatchObject({
      estuaryId: nonExistentEstuaryId,
      deleted: true,
    });
  });

  it("validates estuaryId format", async () => {
    const projectId = "test-project";
    const invalidEstuaryId = "not-a-uuid";

    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${invalidEstuaryId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(500);
    const result = (await response.json()) as any;
    expect(result.error).toContain("Invalid estuaryId format");
  });
});
