import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";
const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("getSession", () => {
  it("returns null when session does not exist", async () => {
    const { getSession } = await import("../src/session");
    const result = await getSession(env as never, PROJECT_ID, SESSION_ID);

    expect(result).toBeNull();
  });

  it("returns session info when session exists", async () => {
    // Create the session stream first
    await env.CORE.putStream(`${PROJECT_ID}/${SESSION_ID}`, { contentType: "application/json" });

    const { getSession } = await import("../src/session");
    const result = await getSession(env as never, PROJECT_ID, SESSION_ID);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(SESSION_ID);
    expect(result!.sessionStreamPath).toBe(`/v1/${PROJECT_ID}/stream/${SESSION_ID}`);
    // No subscriptions added yet
    expect(result!.subscriptions).toEqual([]);
  });

  it("includes subscriptions after subscribing", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await subscribe(env as never, PROJECT_ID, streamId, sessionId);

    const { getSession } = await import("../src/session");
    const result = await getSession(env as never, PROJECT_ID, sessionId);

    expect(result).not.toBeNull();
    expect(result!.subscriptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ streamId })]),
    );
  });

  it("removes subscription from getSession after unsubscribing", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const { unsubscribe } = await import("../src/subscriptions/unsubscribe");
    const { getSession } = await import("../src/session");

    await subscribe(env as never, PROJECT_ID, streamId, sessionId);
    await unsubscribe(env as never, PROJECT_ID, streamId, sessionId);

    const result = await getSession(env as never, PROJECT_ID, sessionId);
    expect(result).not.toBeNull();
    expect(result!.subscriptions).toEqual([]);
  });
});

describe("touchSession", () => {
  it("creates a new session stream", async () => {
    const sessionId = crypto.randomUUID();

    const { touchSession } = await import("../src/session");
    const result = await touchSession(env as never, PROJECT_ID, sessionId);

    expect(result.sessionId).toBe(sessionId);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("succeeds when session already exists", async () => {
    const sessionId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

    const { touchSession } = await import("../src/session");
    const result = await touchSession(env as never, PROJECT_ID, sessionId);

    expect(result.sessionId).toBe(sessionId);
  });

  it("throws on core failure", async () => {
    const mockPutStream = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, body: "internal error" });
    const failEnv = { ...env, CORE: { ...env.CORE, putStream: mockPutStream } };

    const { touchSession } = await import("../src/session");
    await expect(touchSession(failEnv as never, PROJECT_ID, SESSION_ID)).rejects.toThrow(
      "Failed to touch session: internal error (status: 500)",
    );
  });
});

describe("deleteSession", () => {
  it("deletes an existing session", async () => {
    const sessionId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

    const { deleteSession } = await import("../src/session");
    const result = await deleteSession(env as never, PROJECT_ID, sessionId);

    expect(result).toEqual({ sessionId, deleted: true });
  });

  it("succeeds when session does not exist (idempotent)", async () => {
    const sessionId = crypto.randomUUID();

    const { deleteSession } = await import("../src/session");
    const result = await deleteSession(env as never, PROJECT_ID, sessionId);

    expect(result).toEqual({ sessionId, deleted: true });
  });

  it("throws on core failure", async () => {
    const mockDeleteStream = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, body: "internal error" });
    const failEnv = { ...env, CORE: { ...env.CORE, deleteStream: mockDeleteStream } };

    const { deleteSession } = await import("../src/session");
    await expect(deleteSession(failEnv as never, PROJECT_ID, SESSION_ID)).rejects.toThrow(
      "Failed to delete session: internal error (status: 500)",
    );
  });
});
