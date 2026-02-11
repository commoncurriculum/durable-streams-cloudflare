import { describe, it, expect } from "vitest";
import {
  parseStreamPath,
  parseStreamPathFromUrl,
} from "../../src/util/stream-path";

describe("stream-path", () => {
  describe("parseStreamPath", () => {
    it("parses projectId/streamId format", () => {
      const result = parseStreamPath("my-project/my-stream");
      expect(result).toEqual({
        projectId: "my-project",
        streamId: "my-stream",
        path: "my-project/my-stream",
      });
    });

    it("parses legacy streamId only format (maps to _default project)", () => {
      const result = parseStreamPath("my-stream");
      expect(result).toEqual({
        projectId: "_default",
        streamId: "my-stream",
        path: "_default/my-stream",
      });
    });

    it("handles streamId with slashes (only first slash is delimiter)", () => {
      const result = parseStreamPath("project/stream/with/slashes");
      expect(result).toEqual({
        projectId: "project",
        streamId: "stream/with/slashes",
        path: "project/stream/with/slashes",
      });
    });
  });

  describe("parseStreamPathFromUrl", () => {
    it("extracts and parses /v1/stream/projectId/streamId paths", () => {
      const result = parseStreamPathFromUrl("/v1/stream/my-project/my-stream");
      expect(result).toEqual({
        projectId: "my-project",
        streamId: "my-stream",
        path: "my-project/my-stream",
      });
    });

    it("extracts and parses legacy /v1/stream/streamId paths", () => {
      const result = parseStreamPathFromUrl("/v1/stream/my-stream");
      expect(result).toEqual({
        projectId: "_default",
        streamId: "my-stream",
        path: "_default/my-stream",
      });
    });

    it("handles URL-encoded paths", () => {
      const result = parseStreamPathFromUrl("/v1/stream/my-project/my%20stream");
      expect(result).toEqual({
        projectId: "my-project",
        streamId: "my stream",
        path: "my-project/my stream",
      });
    });

    it("returns null for non-matching paths", () => {
      expect(parseStreamPathFromUrl("/v1/other/path")).toBeNull();
      expect(parseStreamPathFromUrl("/v2/stream/test")).toBeNull();
      expect(parseStreamPathFromUrl("/stream/test")).toBeNull();
      expect(parseStreamPathFromUrl("")).toBeNull();
    });

    it("returns null for invalid project IDs", () => {
      // Project IDs can only contain alphanumeric, hyphens, and underscores
      expect(parseStreamPathFromUrl("/v1/stream/project$/stream")).toBeNull();
      expect(parseStreamPathFromUrl("/v1/stream/pro ject/stream")).toBeNull();
      expect(parseStreamPathFromUrl("/v1/stream/project;/stream")).toBeNull();
    });

    it("returns null for URL decoding failures", () => {
      // Invalid percent encoding
      expect(parseStreamPathFromUrl("/v1/stream/test%")).toBeNull();
      expect(parseStreamPathFromUrl("/v1/stream/test%2")).toBeNull();
    });
  });
});
