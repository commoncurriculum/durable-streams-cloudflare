import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock localStorage for Node test environment
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
  clear: vi.fn(() => {
    for (const key of Object.keys(store)) delete store[key];
  }),
  get length() {
    return Object.keys(store).length;
  },
  key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
};

vi.stubGlobal("localStorage", localStorageMock);

describe("recent sessions tracking", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it("stores and retrieves a recent session", async () => {
    const { addRecentSession, getRecentSessions } = await import("../src/lib/recent-sessions");
    addRecentSession("project-1", "session-abc");
    expect(getRecentSessions("project-1")).toContainEqual(
      expect.objectContaining({ sessionId: "session-abc" }),
    );
  });

  it("returns newest sessions first", async () => {
    const { addRecentSession, getRecentSessions } = await import("../src/lib/recent-sessions");
    addRecentSession("project-1", "session-old");
    addRecentSession("project-1", "session-new");
    const sessions = getRecentSessions("project-1");
    expect(sessions[0].sessionId).toBe("session-new");
    expect(sessions[1].sessionId).toBe("session-old");
  });

  it("isolates sessions between projects", async () => {
    const { addRecentSession, getRecentSessions } = await import("../src/lib/recent-sessions");
    addRecentSession("project-1", "session-a");
    addRecentSession("project-2", "session-b");
    expect(getRecentSessions("project-1")).toHaveLength(1);
    expect(getRecentSessions("project-2")).toHaveLength(1);
  });

  it("does not duplicate sessions", async () => {
    const { addRecentSession, getRecentSessions } = await import("../src/lib/recent-sessions");
    addRecentSession("project-1", "session-a");
    addRecentSession("project-1", "session-a");
    expect(getRecentSessions("project-1")).toHaveLength(1);
  });

  it("limits to a maximum number of recent sessions", async () => {
    const { addRecentSession, getRecentSessions, MAX_RECENT_SESSIONS } =
      await import("../src/lib/recent-sessions");
    for (let i = 0; i < MAX_RECENT_SESSIONS + 5; i++) {
      addRecentSession("project-1", `session-${i}`);
    }
    expect(getRecentSessions("project-1").length).toBeLessThanOrEqual(MAX_RECENT_SESSIONS);
  });
});
