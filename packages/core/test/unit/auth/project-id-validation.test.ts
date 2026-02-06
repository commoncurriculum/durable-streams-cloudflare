import { describe, it, expect } from "vitest";

// Core defines its own PROJECT_ID_PATTERN (same regex as subscription constants)
// to avoid cross-package dependency. We test it here directly.
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

describe("project ID validation", () => {
  it("accepts valid project IDs", () => {
    expect(PROJECT_ID_PATTERN.test("my-project")).toBe(true);
    expect(PROJECT_ID_PATTERN.test("test_project")).toBe(true);
    expect(PROJECT_ID_PATTERN.test("Project123")).toBe(true);
    expect(PROJECT_ID_PATTERN.test("abc")).toBe(true);
  });

  it("rejects project IDs with spaces", () => {
    expect(PROJECT_ID_PATTERN.test("bad project")).toBe(false);
  });

  it("rejects project IDs with special characters", () => {
    expect(PROJECT_ID_PATTERN.test("bad!project")).toBe(false);
    expect(PROJECT_ID_PATTERN.test("bad/project")).toBe(false);
    expect(PROJECT_ID_PATTERN.test("bad@project")).toBe(false);
    expect(PROJECT_ID_PATTERN.test("bad.project")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(PROJECT_ID_PATTERN.test("")).toBe(false);
  });
});
