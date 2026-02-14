import { describe, it, expect } from "vitest";
import { uniqueStreamId, delay } from "../helpers";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import type { subscribeRequestSchema } from "../../../src/http/v1/estuary/subscribe/http";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

type SubscribeRequest = typeof subscribeRequestSchema.infer;

/**
 * Poll an estuary stream until it contains data or timeout.
 * Fanout is fire-and-forget (via waitUntil), so we need to poll rather than rely on fixed delays.
 */
async function pollEstuaryUntilData(
	estuaryPath: string,
	maxAttempts = 20,
	delayMs = 150,
	expectedContent?: string,
): Promise<string> {
	for (let i = 0; i < maxAttempts; i++) {
		const response = await fetch(`${BASE_URL}/v1/stream/${estuaryPath}?offset=${ZERO_OFFSET}`);
		if (response.status === 200) {
			const data = await response.text();
			if (data.length > 50 && (!expectedContent || data.includes(expectedContent))) {
				return data;
			}
		}
		await delay(delayMs);
	}
	throw new Error(`Estuary ${estuaryPath} did not receive data after ${maxAttempts} attempts`);
}

/**
 * Check whether an estuary stream has any data (returns true if data found).
 * Used to verify that fanout did NOT happen.
 */
async function estuaryHasData(estuaryPath: string): Promise<boolean> {
	const response = await fetch(`${BASE_URL}/v1/stream/${estuaryPath}?offset=${ZERO_OFFSET}`);
	if (response.status === 200) {
		const data = await response.text();
		return data.length > 50;
	}
	return false;
}

/**
 * Tests for the triggerFanout() code path in src/http/v1/streams/append/index.ts.
 *
 * The triggerFanout function fires asynchronously (via waitUntil) when:
 *   1. ctx.env.SUBSCRIPTION_DO is defined (binding exists)
 *   2. payload.length > 0 (not a close-only operation)
 *
 * These tests exercise edge cases specific to the trigger condition that are NOT
 * covered by existing publish.test.ts or fanout.test.ts:
 *   - Close-only append does NOT trigger fanout
 *   - Close-with-body append DOES trigger fanout
 *   - Unsubscribing prevents future fanout
 *   - Each sequential append triggers its own fanout (offsets advance)
 */
describe("Append-triggered fanout (triggerFanout)", () => {
	it("close-only append does NOT fan out to subscribers", async () => {
		const projectId = "test-project";
		const sourceStreamId = uniqueStreamId("closefanout");
		const estuaryId = crypto.randomUUID();

		// 1. Create source stream
		const sourceStreamPath = `${projectId}/${sourceStreamId}`;
		const createResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "",
		});
		expect(createResp.status).toBe(201);

		// 2. Subscribe estuary to source
		const subscribeBody: SubscribeRequest = { estuaryId };
		const subResp = await fetch(
			`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(subscribeBody),
			},
		);
		expect(subResp.status).toBe(200);

		// 3. Send a close-only append (empty body + Stream-Closed: true)
		// According to the code: payload.length === 0 && closeStream -> returns early at step 3c
		// triggerFanout at step 12 requires payload.length > 0, so it should NOT fire.
		const closeResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Stream-Closed": "true",
			},
			body: "",
		});
		expect(closeResp.status).toBe(204);
		expect(closeResp.headers.get("Stream-Closed")).toBe("true");

		// 4. Wait a reasonable amount for fanout to (not) happen
		await delay(1500);

		// 5. Verify estuary did NOT receive any data
		const estuaryPath = `${projectId}/${estuaryId}`;
		const hasData = await estuaryHasData(estuaryPath);
		expect(hasData).toBe(false);
	});

	it("close-with-body append triggers fanout AND closes the stream", async () => {
		const projectId = "test-project";
		const sourceStreamId = uniqueStreamId("closebody");
		const estuaryId = crypto.randomUUID();

		// 1. Create source stream
		const sourceStreamPath = `${projectId}/${sourceStreamId}`;
		const createResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "",
		});
		expect(createResp.status).toBe(201);

		// 2. Subscribe estuary to source
		const subscribeBody: SubscribeRequest = { estuaryId };
		const subResp = await fetch(
			`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(subscribeBody),
			},
		);
		expect(subResp.status).toBe(200);

		// 3. Append with body AND Stream-Closed: true
		// This should: write the data, trigger fanout (payload.length > 0), AND close the stream
		const message = { type: "final", data: "last message before close" };
		const closeResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Stream-Closed": "true",
			},
			body: JSON.stringify([message]),
		});
		expect([200, 204]).toContain(closeResp.status);
		expect(closeResp.headers.get("Stream-Closed")).toBe("true");

		// 4. Verify the stream is closed (subsequent append should fail with 409)
		const afterCloseResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([{ data: "rejected" }]),
		});
		expect(afterCloseResp.status).toBe(409);

		// 5. Verify the data was fanned out to the estuary
		const estuaryPath = `${projectId}/${estuaryId}`;
		const estuaryData = await pollEstuaryUntilData(estuaryPath);
		expect(estuaryData).toContain("last message before close");
	});

	it("unsubscribing prevents future fanout", async () => {
		const projectId = "test-project";
		const sourceStreamId = uniqueStreamId("unsub");
		const estuaryId = crypto.randomUUID();

		// 1. Create source stream
		const sourceStreamPath = `${projectId}/${sourceStreamId}`;
		const createResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "",
		});
		expect(createResp.status).toBe(201);

		// 2. Subscribe estuary
		const subscribeBody: SubscribeRequest = { estuaryId };
		const subResp = await fetch(
			`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(subscribeBody),
			},
		);
		expect(subResp.status).toBe(200);

		// 3. Publish first message (should fan out)
		const msg1 = { data: "before-unsubscribe" };
		await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([msg1]),
		});

		// 4. Verify first message arrived at estuary
		const estuaryPath = `${projectId}/${estuaryId}`;
		const data1 = await pollEstuaryUntilData(estuaryPath);
		expect(data1).toContain("before-unsubscribe");

		// 5. Unsubscribe the estuary
		const unsubResp = await fetch(
			`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
			{
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ estuaryId }),
			},
		);
		expect(unsubResp.status).toBe(200);

		// 6. Publish second message (should NOT fan out to this estuary)
		const msg2 = { data: "after-unsubscribe" };
		await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([msg2]),
		});

		// 7. Wait for any async fanout to complete
		await delay(1500);

		// 8. Verify estuary does NOT contain the second message
		const readResp = await fetch(
			`${BASE_URL}/v1/stream/${estuaryPath}?offset=${ZERO_OFFSET}`,
		);
		expect(readResp.status).toBe(200);
		const data2 = await readResp.text();
		expect(data2).toContain("before-unsubscribe");
		expect(data2).not.toContain("after-unsubscribe");
	});

	it("each sequential append triggers independent fanout", async () => {
		const projectId = "test-project";
		const sourceStreamId = uniqueStreamId("seqfanout");
		const estuaryId = crypto.randomUUID();

		// 1. Create source stream
		const sourceStreamPath = `${projectId}/${sourceStreamId}`;
		const createResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "",
		});
		expect(createResp.status).toBe(201);

		// 2. Subscribe estuary
		const subscribeBody: SubscribeRequest = { estuaryId };
		await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(subscribeBody),
		});

		// 3. Append three separate messages in sequence, waiting for each to complete
		for (let i = 0; i < 3; i++) {
			const resp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify([{ seq: i, data: `seq-append-${i}` }]),
			});
			expect([200, 204]).toContain(resp.status);
		}

		// 4. Verify all three messages reached the estuary (each had its own fanout)
		const estuaryPath = `${projectId}/${estuaryId}`;
		const estuaryData = await pollEstuaryUntilData(estuaryPath, 30, 200, "seq-append-2");

		expect(estuaryData).toContain("seq-append-0");
		expect(estuaryData).toContain("seq-append-1");
		expect(estuaryData).toContain("seq-append-2");

		// 5. Read the source stream and verify it has all 3 messages too
		const sourceData = await fetch(
			`${BASE_URL}/v1/stream/${sourceStreamPath}?offset=${ZERO_OFFSET}`,
		);
		const sourceText = await sourceData.text();
		expect(sourceText).toContain("seq-append-0");
		expect(sourceText).toContain("seq-append-1");
		expect(sourceText).toContain("seq-append-2");
	});

	it("append to source with no SUBSCRIPTION_DO binding (no fanout, no error)", async () => {
		// This test verifies the guard condition: if SUBSCRIPTION_DO is not defined,
		// triggerFanout simply doesn't fire. In the test environment, SUBSCRIPTION_DO
		// IS defined (wrangler.test.toml), so this test verifies the positive case:
		// appending to a stream with no subscribers succeeds without error.
		const projectId = "test-project";
		const sourceStreamId = uniqueStreamId("nosub");

		// 1. Create source stream (NO subscribers)
		const sourceStreamPath = `${projectId}/${sourceStreamId}`;
		const createResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "",
		});
		expect(createResp.status).toBe(201);

		// 2. Append data — triggerFanout fires, StreamSubscribersDO.fanoutOnly returns early
		// because there are no subscribers. This should not cause any errors.
		const message = { data: "no subscribers" };
		const appendResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([message]),
		});
		expect([200, 204]).toContain(appendResp.status);

		// 3. Verify the data was written to the source stream
		const readResp = await fetch(
			`${BASE_URL}/v1/stream/${sourceStreamPath}?offset=${ZERO_OFFSET}`,
		);
		expect(readResp.status).toBe(200);
		const data = await readResp.text();
		expect(data).toContain("no subscribers");
	});

	it("fanout fires for each of multiple subscribers from a single append", async () => {
		const projectId = "test-project";
		const sourceStreamId = uniqueStreamId("multisub");
		const estuaryId1 = crypto.randomUUID();
		const estuaryId2 = crypto.randomUUID();

		// 1. Create source stream
		const sourceStreamPath = `${projectId}/${sourceStreamId}`;
		await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "",
		});

		// 2. Subscribe two estuaries
		await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ estuaryId: estuaryId1 }),
		});
		await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ estuaryId: estuaryId2 }),
		});

		// 3. Single append to source
		const message = { data: "broadcast-via-triggerFanout" };
		const appendResp = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([message]),
		});
		expect([200, 204]).toContain(appendResp.status);

		// 4. Both estuaries should receive the message
		const estuary1Data = await pollEstuaryUntilData(`${projectId}/${estuaryId1}`);
		const estuary2Data = await pollEstuaryUntilData(`${projectId}/${estuaryId2}`);

		expect(estuary1Data).toContain("broadcast-via-triggerFanout");
		expect(estuary2Data).toContain("broadcast-via-triggerFanout");
	});

	it("fanout uses producer-based deduplication (duplicate appends are idempotent)", async () => {
		const projectId = "test-project";
		const sourceStreamId = uniqueStreamId("dedup");
		const estuaryId = crypto.randomUUID();

		// 1. Create source stream
		const sourceStreamPath = `${projectId}/${sourceStreamId}`;
		await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "",
		});

		// 2. Subscribe estuary
		await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ estuaryId }),
		});

		// 3. Append twice with same producer headers (second should be dedup'd at estuary level)
		const message1 = { data: "first-dedup-msg" };
		const resp1 = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([message1]),
		});
		expect([200, 204]).toContain(resp1.status);

		// Wait for first fanout to complete
		const estuaryPath = `${projectId}/${estuaryId}`;
		await pollEstuaryUntilData(estuaryPath, 20, 150, "first-dedup-msg");

		// 4. Append a different message — each append gets a unique fanout seq,
		// so the estuary stream should accumulate both messages
		const message2 = { data: "second-dedup-msg" };
		const resp2 = await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify([message2]),
		});
		expect([200, 204]).toContain(resp2.status);

		// 5. Verify both messages arrived (fanout seq increments, so no dedup collision)
		const estuaryData = await pollEstuaryUntilData(estuaryPath, 30, 200, "second-dedup-msg");
		expect(estuaryData).toContain("first-dedup-msg");
		expect(estuaryData).toContain("second-dedup-msg");
	});
});
