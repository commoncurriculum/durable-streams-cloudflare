import { describe, expect, it } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

describe("DELETE stream", () => {
	it("returns 204 and removes the stream", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("delete");

		await client.createStream(streamId, "hello", "text/plain");

		const deleteRes = await client.deleteStream(streamId);
		expect(deleteRes.status).toBe(204);

		// Stream should be gone — GET returns 404
		const getRes = await fetch(client.streamUrl(streamId));
		expect(getRes.status).toBe(404);
	});

	it("returns 404 when deleting a nonexistent stream", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("delete-missing");

		const deleteRes = await client.deleteStream(streamId);
		expect(deleteRes.status).toBe(404);
	});
});
