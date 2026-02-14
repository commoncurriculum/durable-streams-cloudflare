import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

describe("read modes", () => {
  describe("HEAD request", () => {
    it("returns 200 with no body and stream metadata headers", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("head");

      await client.createStream(streamId, "hello", "text/plain");

      const res = await fetch(client.streamUrl(streamId), { method: "HEAD" });

      expect(res.status).toBe(200);
      expect(res.headers.get("Stream-Next-Offset")).toBeTruthy();
      expect(res.headers.get("Content-Type")).toMatch(/text\/plain/);

      // HEAD responses must have no body
      const body = await res.text();
      expect(body).toBe("");
    });

    it("includes Stream-Closed: true when stream is closed", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("head-closed");

      await client.createStream(streamId, "data", "text/plain");

      // Close the stream
      await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });

      const res = await fetch(client.streamUrl(streamId), { method: "HEAD" });

      expect(res.status).toBe(200);
      expect(res.headers.get("Stream-Closed")).toBe("true");
      expect(res.headers.get("Stream-Next-Offset")).toBeTruthy();
    });

    it("does not include Stream-Closed header on open stream", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("head-open");

      await client.createStream(streamId, "data", "text/plain");

      const res = await fetch(client.streamUrl(streamId), { method: "HEAD" });

      expect(res.status).toBe(200);
      expect(res.headers.get("Stream-Closed")).toBeNull();
    });
  });

  describe("offset=now", () => {
    it("returns 200 with Stream-Up-To-Date and empty body for text/plain", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("now-text");

      await client.createStream(streamId, "initial", "text/plain");

      const res = await fetch(client.streamUrl(streamId, { offset: "now" }));

      expect(res.status).toBe(200);
      expect(res.headers.get("Stream-Up-To-Date")).toBe("true");
      expect(res.headers.get("Stream-Next-Offset")).toBeTruthy();

      const body = await res.text();
      expect(body).toBe("");
    });

    it("returns 200 with empty JSON array for application/json", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("now-json");

      await client.createStream(streamId, "[]", "application/json");

      const res = await fetch(client.streamUrl(streamId, { offset: "now" }));

      expect(res.status).toBe(200);
      expect(res.headers.get("Stream-Up-To-Date")).toBe("true");

      const body = await res.text();
      expect(body).toBe("[]");
    });

    it("returns Stream-Next-Offset pointing at the tail", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("now-offset");

      await client.createStream(streamId, "data", "text/plain");

      // Append more data to advance the tail
      await client.appendStream(streamId, "more data", "text/plain");

      const res = await fetch(client.streamUrl(streamId, { offset: "now" }));
      const nextOffset = res.headers.get("Stream-Next-Offset");

      expect(nextOffset).toBeTruthy();
      // The offset should be beyond the zero offset since we have data
      expect(nextOffset).not.toBe(ZERO_OFFSET);
    });

    it("includes Stream-Closed when stream is closed", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("now-closed");

      await client.createStream(streamId, "data", "text/plain");

      await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });

      const res = await fetch(client.streamUrl(streamId, { offset: "now" }));

      expect(res.status).toBe(200);
      expect(res.headers.get("Stream-Closed")).toBe("true");
      expect(res.headers.get("Stream-Up-To-Date")).toBe("true");
    });
  });

  describe("ETag / If-None-Match", () => {
    it("returns 304 when If-None-Match matches the ETag", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("etag");

      await client.createStream(streamId, "hello", "text/plain");

      // Read at zero offset to get an ETag
      const firstRead = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      expect(firstRead.status).toBe(200);

      const etag = firstRead.headers.get("ETag");
      expect(etag).toBeTruthy();

      // Request the same URL with If-None-Match
      const conditional = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }), {
        headers: { "If-None-Match": etag! },
      });

      expect(conditional.status).toBe(304);
    });

    it("returns 200 when ETag changes after new append", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("etag-changed");

      await client.createStream(streamId, "first", "text/plain");

      const firstRead = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      const firstEtag = firstRead.headers.get("ETag");
      expect(firstEtag).toBeTruthy();

      // Append more data — changes the stream state
      await client.appendStream(streamId, "second", "text/plain");

      // Same offset but stream has changed — ETag should differ
      const secondRead = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      expect(secondRead.status).toBe(200);

      const secondEtag = secondRead.headers.get("ETag");
      expect(secondEtag).toBeTruthy();
      expect(secondEtag).not.toBe(firstEtag);
    });
  });

  describe("read 404 for nonexistent stream", () => {
    it("GET on nonexistent stream returns 404", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("nonexistent");

      const res = await fetch(client.streamUrl(streamId));

      expect(res.status).toBe(404);
    });

    it("HEAD on nonexistent stream returns 404", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("nonexistent-head");

      const res = await fetch(client.streamUrl(streamId), { method: "HEAD" });

      expect(res.status).toBe(404);
    });

    it("offset=now on nonexistent stream returns 404", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("nonexistent-now");

      const res = await fetch(client.streamUrl(streamId, { offset: "now" }));

      expect(res.status).toBe(404);
    });
  });
});
