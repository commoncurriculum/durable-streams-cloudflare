import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

describe("append close", () => {
	it("close-only on open stream returns 204 with Stream-Closed header", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("close-only");

		await client.createStream(streamId, "data", "text/plain");

		const closeRes = await fetch(client.streamUrl(streamId), {
			method: "POST",
			headers: { "Stream-Closed": "true" },
		});

		expect(closeRes.status).toBe(204);
		expect(closeRes.headers.get("Stream-Closed")).toBe("true");
		expect(closeRes.headers.get("Stream-Next-Offset")).toBeTruthy();
	});

	it("close-only on already-closed stream is idempotent (204)", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("close-idempotent");

		await client.createStream(streamId, "data", "text/plain");

		// First close
		await fetch(client.streamUrl(streamId), {
			method: "POST",
			headers: { "Stream-Closed": "true" },
		});

		// Second close — should be idempotent
		const secondClose = await fetch(client.streamUrl(streamId), {
			method: "POST",
			headers: { "Stream-Closed": "true" },
		});

		expect(secondClose.status).toBe(204);
		expect(secondClose.headers.get("Stream-Closed")).toBe("true");
	});

	it("append with data and close returns 204 with Stream-Closed", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("close-with-data");

		await client.createStream(streamId, "", "text/plain");

		const res = await fetch(client.streamUrl(streamId), {
			method: "POST",
			headers: {
				"Content-Type": "text/plain",
				"Stream-Closed": "true",
			},
			body: "final message",
		});

		expect(res.status).toBe(204);
		expect(res.headers.get("Stream-Closed")).toBe("true");

		// Read back — should contain the final message
		const text = await client.readAllText(streamId, ZERO_OFFSET);
		expect(text).toBe("final message");
	});

	it("append to closed stream returns 409", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("append-closed");

		await client.createStream(streamId, "data", "text/plain");

		// Close the stream
		await fetch(client.streamUrl(streamId), {
			method: "POST",
			headers: { "Stream-Closed": "true" },
		});

		// Try to append — should be rejected
		const appendRes = await fetch(client.streamUrl(streamId), {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			body: "more data",
		});

		expect(appendRes.status).toBe(409);
		expect(appendRes.headers.get("Stream-Closed")).toBe("true");
	});
});
