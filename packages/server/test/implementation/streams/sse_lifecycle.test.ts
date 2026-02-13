import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

describe("SSE lifecycle", () => {
	it("catches up on existing data and sends control event", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("sse-catchup");

		await client.createStream(streamId, "existing", "text/plain");

		const response = await fetch(
			client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		// Read until we see the control event (which comes after data catch-up)
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !buffer.includes("event: control")) {
			const result = await Promise.race([
				reader.read(),
				delay(deadline - Date.now()).then(() => ({ done: true, value: undefined })),
			]);
			if (result.done) break;
			if (result.value) buffer += decoder.decode(result.value, { stream: true });
		}

		await reader.cancel();

		expect(buffer).toContain("event: data\n");
		expect(buffer).toContain("data:existing\n");
		expect(buffer).toContain("event: control\n");
	});

	it("receives broadcast data when appended after SSE connect", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("sse-broadcast");

		await client.createStream(streamId, "", "text/plain");

		// Connect SSE at tail (no catch-up data)
		const response = await fetch(
			client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
		);

		expect(response.status).toBe(200);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		// Read the initial control event
		const initDeadline = Date.now() + 3000;
		while (Date.now() < initDeadline && !buffer.includes("event: control")) {
			const result = await Promise.race([
				reader.read(),
				delay(initDeadline - Date.now()).then(() => ({ done: true, value: undefined })),
			]);
			if (result.done) break;
			if (result.value) buffer += decoder.decode(result.value, { stream: true });
		}

		// Now append data
		await client.appendStream(streamId, "broadcast-test", "text/plain");

		// Read the broadcast data event
		const bcastDeadline = Date.now() + 5000;
		while (Date.now() < bcastDeadline && !buffer.includes("data:broadcast-test")) {
			const result = await Promise.race([
				reader.read(),
				delay(bcastDeadline - Date.now()).then(() => ({ done: true, value: undefined })),
			]);
			if (result.done) break;
			if (result.value) buffer += decoder.decode(result.value, { stream: true });
		}

		await reader.cancel();

		expect(buffer).toContain("event: data\n");
		expect(buffer).toContain("data:broadcast-test\n");
	});

	it("receives stream-closed control event on close-only (no body)", async () => {
		const client = createClient();
		const streamId = uniqueStreamId("sse-close");

		await client.createStream(streamId, "", "text/plain");

		// Connect SSE
		const response = await fetch(
			client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
		);

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		// Read the initial control event
		const initDeadline = Date.now() + 3000;
		while (Date.now() < initDeadline && !buffer.includes("event: control")) {
			const result = await Promise.race([
				reader.read(),
				delay(initDeadline - Date.now()).then(() => ({ done: true, value: undefined })),
			]);
			if (result.done) break;
			if (result.value) buffer += decoder.decode(result.value, { stream: true });
		}

		// Close the stream with NO body — SSE clients should still be notified
		await fetch(client.streamUrl(streamId), {
			method: "POST",
			headers: { "Stream-Closed": "true" },
		});

		// Read until we see "streamClosed" in a control event
		const closeDeadline = Date.now() + 5000;
		while (Date.now() < closeDeadline && !buffer.includes('"streamClosed":true')) {
			const result = await Promise.race([
				reader.read(),
				delay(closeDeadline - Date.now()).then(() => ({ done: true, value: undefined })),
			]);
			if (result.done) break;
			if (result.value) buffer += decoder.decode(result.value, { stream: true });
		}

		await reader.cancel();

		expect(buffer).toContain('"streamClosed":true');
	});
});
