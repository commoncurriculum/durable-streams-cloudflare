import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary touch", () => {
  it("can touch an estuary to refresh its TTL", async () => {
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
    const subscribeResponse = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    const subscribeResult = (await subscribeResponse.json()) as any;
    const initialExpiresAt = subscribeResult.expiresAt;

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Touch the estuary
    const touchResponse = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${estuaryId}`, {
      method: "POST",
    });

    expect(touchResponse.status).toBe(200);
    const touchResult = (await touchResponse.json()) as any;

    expect(touchResult).toMatchObject({
      estuaryId,
    });
    expect(touchResult.expiresAt).toBeTypeOf("number");
    expect(touchResult.expiresAt).toBeGreaterThan(initialExpiresAt);
  });

  it("creates estuary when touching non-existent one (idempotent)", async () => {
    const projectId = "test-project";
    const nonExistentEstuaryId = crypto.randomUUID();

    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${nonExistentEstuaryId}`, {
      method: "POST",
    });

    // Touch creates the estuary if it doesn't exist
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result).toMatchObject({
      estuaryId: nonExistentEstuaryId,
    });
    expect(result.expiresAt).toBeTypeOf("number");
  });

  it("validates estuaryId format", async () => {
    const projectId = "test-project";
    const invalidEstuaryId = "not-a-uuid";

    const response = await fetch(`${BASE_URL}/v1/estuary/${projectId}/${invalidEstuaryId}`, {
      method: "POST",
    });

    expect(response.status).toBe(500);
    const result = (await response.json()) as any;
    expect(result.error).toContain("Invalid estuaryId format");
  });
});
