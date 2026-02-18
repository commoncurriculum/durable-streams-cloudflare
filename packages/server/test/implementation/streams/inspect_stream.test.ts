import { describe, expect, it } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("GET /v1/streams/:streamId/inspect", () => {
  it("returns 404 for non-existent stream", async () => {
    const streamId = uniqueStreamId("inspect-notfound");
    const response = await fetch(`${BASE_URL}/v1/streams/${streamId}/inspect`);
    expect(response.status).toBe(404);
  });

  it("returns stream metadata after stream is created", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("inspect-meta");
    
    // Create a stream
    await client.createStream(streamId, "initial data", "text/plain");

    // Inspect it
    const response = await fetch(`${BASE_URL}/v1/streams/${streamId}/inspect`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    
    const metadata = await response.json() as {
      streamId: string;
      contentType: string;
      tailOffset: number;
      closed: boolean;
      public: boolean;
      createdAt?: number;
      closedAt?: number;
    };
    expect(metadata).toHaveProperty("streamId");
    expect(metadata).toHaveProperty("contentType");
    expect(metadata).toHaveProperty("tailOffset");
    expect(metadata).toHaveProperty("closed");
    expect(metadata.streamId).toBe(streamId);
    expect(metadata.contentType).toBe("text/plain");
    expect(metadata.closed).toBe(false);
  });

  it("returns metadata including tail offset after appends", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("inspect-offset");
    
    // Create and append to stream
    await client.createStream(streamId, "data1", "text/plain");
    await client.appendStream(streamId, "data2", "text/plain");

    // Inspect it
    const response = await fetch(`${BASE_URL}/v1/streams/${streamId}/inspect`);
    expect(response.status).toBe(200);
    
    const metadata = await response.json() as { tailOffset: number };
    expect(metadata.tailOffset).toBeGreaterThan(0);
  });

  it("returns metadata for closed stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("inspect-closed");
    
    // Create a closed stream
    const createResponse = await fetch(client.streamUrl(streamId, { public: "true" }), {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Closed": "true",
      },
      body: "final data",
    });
    expect(createResponse.status).toBe(201);

    // Inspect it
    const response = await fetch(`${BASE_URL}/v1/streams/${streamId}/inspect`);
    expect(response.status).toBe(200);
    
    const metadata = await response.json() as { closed: boolean; closedAt?: number };
    expect(metadata.closed).toBe(true);
    expect(metadata).toHaveProperty("closedAt");
  });
});
