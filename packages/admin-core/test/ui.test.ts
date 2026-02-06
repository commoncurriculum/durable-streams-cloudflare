import { describe, expect, it } from "vitest";
import { renderAdminPage } from "../src/ui/page";

describe("renderAdminPage", () => {
  it("returns valid HTML with doctype", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("</html>");
  });

  it("includes all three tab panels", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="inspect"');
    expect(html).toContain('data-tab="test"');
    expect(html).toContain('id="panel-overview"');
    expect(html).toContain('id="panel-inspect"');
    expect(html).toContain('id="panel-test"');
  });

  it("includes stat cards", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain("stat-appends");
    expect(html).toContain("stat-bytes");
    expect(html).toContain("stat-streams");
    expect(html).toContain("stat-sse");
  });

  it("includes API endpoint URLs in script", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain("/api/stats");
    expect(html).toContain("/api/streams");
    expect(html).toContain("/api/hot");
    expect(html).toContain("/api/timeseries");
  });

  it("embeds the CORE_PUBLIC_URL for SSE connections", () => {
    const html = renderAdminPage({ corePublicUrl: "https://my-core.example.com" });
    expect(html).toContain("https://my-core.example.com");
  });

  it("handles empty corePublicUrl", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain('CORE_PUBLIC_URL not configured');
  });

  it("includes inspect search bar", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain('id="inspect-input"');
    expect(html).toContain("inspectStream()");
  });

  it("includes test form elements", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain('id="test-stream-id"');
    expect(html).toContain('id="test-body"');
    expect(html).toContain('id="test-content-type"');
    expect(html).toContain("sendTest()");
  });

  it("includes the timeseries chart SVG", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain('id="timeseries-chart"');
  });

  it("includes essential CSS variables", () => {
    const html = renderAdminPage({ corePublicUrl: "" });
    expect(html).toContain("--bg-page:#0a0a0f");
    expect(html).toContain("--blue:#5b8df8");
    expect(html).toContain("--green:#34d399");
  });
});
