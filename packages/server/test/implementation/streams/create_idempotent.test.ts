import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

describe("create stream idempotency and TTL", () => {
	it("returns 200 on idempotent create with same params", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("idem-same");
		const url = client.streamUrl(streamId, { public: "true" });

		const first = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain" },
			body: "hello",
		});
		expect(first.status).toBe(201);

		const second = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain" },
			body: "hello",
		});
		expect(second.status).toBe(200);
		expect(second.headers.get("Stream-Next-Offset")).toBeTruthy();
	});

	it("returns 409 on idempotent create with different content-type", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("idem-ct");
		const url = client.streamUrl(streamId, { public: "true" });

		const first = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain" },
			body: "hello",
		});
		expect(first.status).toBe(201);

		const second = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([{ key: "value" }]),
		});
		expect(second.status).toBe(409);
	});

	it("returns 409 on idempotent create with different closed status", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("idem-closed");
		const url = client.streamUrl(streamId, { public: "true" });

		const first = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain" },
			body: "hello",
		});
		expect(first.status).toBe(201);

		const second = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain", "Stream-Closed": "true" },
			body: "hello",
		});
		expect(second.status).toBe(409);
	});

	it("creates a stream with Stream-TTL header", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("ttl-create");
		const url = client.streamUrl(streamId, { public: "true" });

		const res = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain", "Stream-TTL": "60" },
			body: "ttl-data",
		});
		expect(res.status).toBe(201);
		expect(res.headers.get("Stream-Expires-At")).toBeTruthy();
	});

	it("creates a stream with Stream-Expires-At header", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("expires-create");
		const url = client.streamUrl(streamId, { public: "true" });

		const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
		const res = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain", "Stream-Expires-At": futureDate },
			body: "expires-data",
		});
		expect(res.status).toBe(201);
		expect(res.headers.get("Stream-Expires-At")).toBeTruthy();
	});

	it("returns 400 when both Stream-TTL and Stream-Expires-At are provided", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("ttl-both");
		const url = client.streamUrl(streamId, { public: "true" });

		const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
		const res = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "text/plain",
				"Stream-TTL": "60",
				"Stream-Expires-At": futureDate,
			},
			body: "data",
		});
		expect(res.status).toBe(400);
	});

	it("creates a stream with empty JSON array body and reads back empty array", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("empty-json");
		const url = client.streamUrl(streamId, { public: "true" });

		const res = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "[]",
		});
		expect([200, 201]).toContain(res.status);

		// Read back at ZERO_OFFSET — empty stream should return empty JSON array
		const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
		// An empty stream may return 200 with [] or 204 (no content yet)
		if (readRes.status === 200) {
			const body = await readRes.text();
			expect(JSON.parse(body)).toEqual([]);
		} else {
			// 204 is also acceptable for an empty stream
			expect(readRes.status).toBe(204);
		}
	});

	it("returns 409 on idempotent create with TTL mismatch", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("idem-ttl");
		const url = client.streamUrl(streamId, { public: "true" });

		const first = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain", "Stream-TTL": "60" },
			body: "data",
		});
		expect(first.status).toBe(201);

		const second = await fetch(url, {
			method: "PUT",
			headers: { "Content-Type": "text/plain", "Stream-TTL": "120" },
			body: "data",
		});
		expect(second.status).toBe(409);
	});
});
