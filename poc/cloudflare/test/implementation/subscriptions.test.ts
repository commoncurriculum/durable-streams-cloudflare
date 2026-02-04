import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/protocol/offsets";
import { startWorker } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

async function subscribe(baseUrl: string, sessionId: string, streamId: string): Promise<Response> {
  return await fetch(`${baseUrl}/v1/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, streamId }),
  });
}

async function unsubscribe(
  baseUrl: string,
  sessionId: string,
  streamId: string,
): Promise<Response> {
  return await fetch(`${baseUrl}/v1/subscriptions`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, streamId }),
  });
}

describe("subscriptions (fan-in)", () => {
  it("stores session subscriptions and lists them", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("sub-doc");
    const sessionId = uniqueStreamId("session");

    try {
      const create = await fetch(`${handle.baseUrl}/v1/stream/${streamId}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "",
      });
      expect([200, 201]).toContain(create.status);

      const subscribed = await subscribe(handle.baseUrl, sessionId, streamId);
      expect(subscribed.status).toBe(204);

      const list = await fetch(`${handle.baseUrl}/v1/subscriptions/${sessionId}`);
      expect(list.status).toBe(200);
      const listBody = await list.json();
      expect(Array.isArray(listBody)).toBe(true);
      expect(listBody).toContain(streamId);

      const removed = await unsubscribe(handle.baseUrl, sessionId, streamId);
      expect(removed.status).toBe(204);

      const listAfter = await fetch(`${handle.baseUrl}/v1/subscriptions/${sessionId}`);
      expect(listAfter.status).toBe(200);
      const afterBody = await listAfter.json();
      expect(afterBody).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it("fan-outs append envelopes into the session fan-in stream", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("fanout-doc");
    const sessionId = uniqueStreamId("session");

    try {
      const create = await fetch(`${handle.baseUrl}/v1/stream/${streamId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ init: true }),
      });
      expect([200, 201]).toContain(create.status);

      const subscribed = await subscribe(handle.baseUrl, sessionId, streamId);
      expect(subscribed.status).toBe(204);

      const append = await fetch(`${handle.baseUrl}/v1/stream/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "insert", text: "hello" }),
      });
      expect([200, 204]).toContain(append.status);

      const fanIn = await fetch(
        `${handle.baseUrl}/v1/stream/subscriptions/${sessionId}?offset=${ZERO_OFFSET}`,
      );
      expect(fanIn.status).toBe(200);
      const payload = await fanIn.json();
      expect(Array.isArray(payload)).toBe(true);
      expect(payload.length).toBeGreaterThan(0);
      const envelope = payload[payload.length - 1] as {
        stream: string;
        offset: string;
        type: string;
        payload: unknown;
      };
      expect(envelope.stream).toBe(streamId);
      expect(typeof envelope.offset).toBe("string");
      expect(envelope.type).toBe("data");
      expect(envelope.payload).toEqual({ op: "insert", text: "hello" });
    } finally {
      await handle.stop();
    }
  });
});
