import { describe, expect, it } from "vitest";
import { formatRate, relTime } from "../src/lib/formatters";

describe("formatRate", () => {
  it("formats rate per minute from hourly total", () => {
    expect(formatRate(3600, 3600)).toBe("60");
  });

  it("formats low rates with decimal", () => {
    expect(formatRate(5, 60)).toBe("5.0");
  });

  it("formats high rates as integers", () => {
    expect(formatRate(600, 60)).toBe("600");
  });
});

describe("relTime", () => {
  it("returns dash for null", () => {
    expect(relTime(null)).toBe("\u2014");
  });

  it("returns dash for undefined", () => {
    expect(relTime(undefined)).toBe("\u2014");
  });

  it("formats seconds ago", () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(relTime(ts)).toMatch(/\d+s ago/);
  });

  it("formats minutes ago", () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relTime(ts)).toMatch(/\d+m ago/);
  });

  it("returns string for invalid date", () => {
    expect(relTime("not-a-date")).toBe("not-a-date");
  });
});
