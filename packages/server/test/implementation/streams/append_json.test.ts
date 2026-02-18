import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

describe("append JSON", () => {
  it("appends a JSON array to an application/json stream and reads it back", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("json-append");

    await client.createStream(streamId, "", "application/json");

    const appendRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ key: "value" }]),
    });

    expect([200, 204]).toContain(appendRes.status);

    // Read back at ZERO_OFFSET
    const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    expect(readRes.status).toBe(200);

    const body = await readRes.text();
    expect(body).toContain('"key"');
    expect(body).toContain('"value"');
    // The response should contain our JSON data
    const parsed = JSON.parse(body);
    expect(parsed).toEqual([{ key: "value" }]);
  });

  it("appends multiple JSON messages from a single array", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("json-multi");

    await client.createStream(streamId, "", "application/json");

    const appendRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ a: 1 }, { b: 2 }]),
    });

    expect([200, 204]).toContain(appendRes.status);

    // Read back at ZERO_OFFSET
    const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    expect(readRes.status).toBe(200);

    const body = await readRes.text();
    const parsed = JSON.parse(body);
    // Should contain both messages
    expect(parsed).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("rejects invalid JSON with 400", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("json-invalid");

    await client.createStream(streamId, "", "application/json");

    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });

    expect(res.status).toBe(400);
  });

  it("rejects empty JSON array with 400", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("json-empty-array");

    await client.createStream(streamId, "", "application/json");

    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });

    expect(res.status).toBe(400);
  });

  it("echoes and validates Stream-Seq header, rejects regression with 409", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("stream-seq");

    await client.createStream(streamId, "", "text/plain");

    // First append with Stream-Seq: 1
    const first = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Seq": "1",
      },
      body: "message-1",
    });

    expect([200, 204]).toContain(first.status);
    expect(first.headers.get("Stream-Next-Offset")).toBeTruthy();

    // Second append with Stream-Seq: 2 (advancing) → should succeed
    const second = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Seq": "2",
      },
      body: "message-2",
    });

    expect([200, 204]).toContain(second.status);

    // Third append with Stream-Seq: 1 (regression) → should fail with 409
    const regression = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Seq": "1",
      },
      body: "message-regression",
    });

    expect(regression.status).toBe(409);
  });

  it("appends with producer headers and Stream-Closed in one request", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("producer-close");

    await client.createStream(streamId, "", "text/plain");

    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
        "Stream-Closed": "true",
      },
      body: "final-message",
    });

    // Producer appends return 200 (with producer state)
    expect(res.status).toBe(200);
    expect(res.headers.get("Producer-Epoch")).toBe("1");
    expect(res.headers.get("Producer-Seq")).toBe("0");
    expect(res.headers.get("Stream-Closed")).toBe("true");
    expect(res.headers.get("Stream-Next-Offset")).toBeTruthy();

    // Verify the data was written before the stream closed
    const text = await client.readAllText(streamId, ZERO_OFFSET);
    expect(text).toBe("final-message");
  });
});
