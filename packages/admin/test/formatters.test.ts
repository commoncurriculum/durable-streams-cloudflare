import { describe, expect, it } from "vitest";
import { formatBytes, formatRate, relTime } from "../src/lib/formatters";

describe("formatBytes", () => {
  it("formats 0", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

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

  it("formats hours ago", () => {
    const ts = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(relTime(ts)).toMatch(/\d+h ago/);
  });

  it("formats days ago", () => {
    const ts = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(relTime(ts)).toMatch(/\d+d ago/);
  });

  it("returns string for invalid date", () => {
    expect(relTime("not-a-date")).toBe("not-a-date");
  });
});
