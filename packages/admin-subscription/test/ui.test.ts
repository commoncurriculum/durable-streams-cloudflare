import { describe, expect, it } from "vitest";
import { renderAdminPage } from "../src/ui/page";

describe("renderAdminPage", () => {
  it("returns valid HTML with doctype", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("</html>");
  });

  it("includes all three tab panels", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="inspect"');
    expect(html).toContain('data-tab="test"');
    expect(html).toContain('id="panel-overview"');
    expect(html).toContain('id="panel-inspect"');
    expect(html).toContain('id="panel-test"');
  });

  it("includes top row stat cards", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain("stat-publishes");
    expect(html).toContain("stat-fanout-latency");
    expect(html).toContain("stat-sessions");
    expect(html).toContain("stat-streams");
  });

  it("includes bottom row stat cards", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain("stat-fanout-rate");
    expect(html).toContain("stat-subscribes");
    expect(html).toContain("stat-unsubscribes");
    expect(html).toContain("stat-expired");
  });

  it("includes API endpoint URLs in script", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain("/api/stats");
    expect(html).toContain("/api/sessions");
    expect(html).toContain("/api/streams");
    expect(html).toContain("/api/hot");
    expect(html).toContain("/api/timeseries");
  });

  it("embeds the CORE_PUBLIC_URL for SSE connections", () => {
    const html = renderAdminPage({ corePublicUrl: "https://my-core.example.com", subscriptionPublicUrl: "" });
    expect(html).toContain("https://my-core.example.com");
  });

  it("embeds the SUBSCRIPTION_PUBLIC_URL", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "https://my-sub.example.com" });
    expect(html).toContain("https://my-sub.example.com");
  });

  it("handles empty corePublicUrl with error message", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain("CORE_PUBLIC_URL not configured");
  });

  it("includes session inspect search bar", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain('id="session-inspect-input"');
    expect(html).toContain("inspectSession()");
  });

  it("includes stream inspect search bar", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain('id="stream-inspect-input"');
    expect(html).toContain("inspectStream()");
  });

  it("includes test form elements", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain('id="test-stream-id-publish"');
    expect(html).toContain('id="test-body"');
    expect(html).toContain('id="test-content-type"');
    expect(html).toContain('id="test-session-id-subscribe"');
    expect(html).toContain("sendTest()");
  });

  it("includes action toggle with all actions", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain("Subscribe");
    expect(html).toContain("Unsub");
    expect(html).toContain("Publish");
    expect(html).toContain("Touch");
    expect(html).toContain("Delete");
  });

  it("includes the timeseries chart SVG", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain('id="timeseries-chart"');
  });

  it("includes essential CSS variables", () => {
    const html = renderAdminPage({ corePublicUrl: "", subscriptionPublicUrl: "" });
    expect(html).toContain("--bg-page:#0a0a0f");
    expect(html).toContain("--blue:#5b8df8");
    expect(html).toContain("--green:#34d399");
  });
});
