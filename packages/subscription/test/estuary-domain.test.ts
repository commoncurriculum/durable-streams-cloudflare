import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";
const ESTUARY_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("getEstuary", () => {
  it("returns null when estuary does not exist", async () => {
    const { getEstuary } = await import("../src/estuary");
    const result = await getEstuary(env as never, PROJECT_ID, ESTUARY_ID);

    expect(result).toBeNull();
  });

  it("returns estuary info when estuary exists", async () => {
    // Create the estuary stream first
    await env.CORE.putStream(`${PROJECT_ID}/${ESTUARY_ID}`, { contentType: "application/json" });

    const { getEstuary } = await import("../src/estuary");
    const result = await getEstuary(env as never, PROJECT_ID, ESTUARY_ID);

    expect(result).not.toBeNull();
    expect(result!.estuaryId).toBe(ESTUARY_ID);
    expect(result!.estuaryStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${ESTUARY_ID}`);
    // No subscriptions added yet
    expect(result!.subscriptions).toEqual([]);
  });

  it("includes subscriptions after subscribing", async () => {
    const estuaryId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await subscribe(env as never, PROJECT_ID, streamId, estuaryId);

    const { getEstuary } = await import("../src/estuary");
    const result = await getEstuary(env as never, PROJECT_ID, estuaryId);

    expect(result).not.toBeNull();
    expect(result!.subscriptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ streamId })]),
    );
  });

  it("removes subscription from getEstuary after unsubscribing", async () => {
    const estuaryId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const { unsubscribe } = await import("../src/subscriptions/unsubscribe");
    const { getEstuary } = await import("../src/estuary");

    await subscribe(env as never, PROJECT_ID, streamId, estuaryId);
    await unsubscribe(env as never, PROJECT_ID, streamId, estuaryId);

    const result = await getEstuary(env as never, PROJECT_ID, estuaryId);
    expect(result).not.toBeNull();
    expect(result!.subscriptions).toEqual([]);
  });
});

describe("touchEstuary", () => {
  it("creates a new estuary stream", async () => {
    const estuaryId = crypto.randomUUID();

    const { touchEstuary } = await import("../src/estuary");
    const result = await touchEstuary(env as never, PROJECT_ID, estuaryId);

    expect(result.estuaryId).toBe(estuaryId);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("succeeds when estuary already exists", async () => {
    const estuaryId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/json" });

    const { touchEstuary } = await import("../src/estuary");
    const result = await touchEstuary(env as never, PROJECT_ID, estuaryId);

    expect(result.estuaryId).toBe(estuaryId);
  });

  it("throws on core failure", async () => {
    const mockPutStream = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, body: "internal error" });
    const failEnv = { ...env, CORE: { ...env.CORE, putStream: mockPutStream } };

    const { touchEstuary } = await import("../src/estuary");
    await expect(touchEstuary(failEnv as never, PROJECT_ID, ESTUARY_ID)).rejects.toThrow(
      "Failed to touch estuary: internal error (status: 500)",
    );
  });
});

describe("deleteEstuary", () => {
  it("deletes an existing estuary", async () => {
    const estuaryId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/json" });

    const { deleteEstuary } = await import("../src/estuary");
    const result = await deleteEstuary(env as never, PROJECT_ID, estuaryId);

    expect(result).toEqual({ estuaryId, deleted: true });
  });

  it("succeeds when estuary does not exist (idempotent)", async () => {
    const estuaryId = crypto.randomUUID();

    const { deleteEstuary } = await import("../src/estuary");
    const result = await deleteEstuary(env as never, PROJECT_ID, estuaryId);

    expect(result).toEqual({ estuaryId, deleted: true });
  });

  it("throws on core failure", async () => {
    const mockDeleteStream = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, body: "internal error" });
    const failEnv = { ...env, CORE: { ...env.CORE, deleteStream: mockDeleteStream } };

    const { deleteEstuary } = await import("../src/estuary");
    await expect(deleteEstuary(failEnv as never, PROJECT_ID, ESTUARY_ID)).rejects.toThrow(
      "Failed to delete estuary: internal error (status: 500)",
    );
  });
});
