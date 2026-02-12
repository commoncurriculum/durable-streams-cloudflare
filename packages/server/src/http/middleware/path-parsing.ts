import { parseStreamPathFromUrl, PROJECT_ID_PATTERN } from "../shared/stream-path";
import { lookupProjectConfig } from "./authentication";

// biome-ignore lint: Hono context typing is complex; middleware is wired through the app
export async function pathParsingMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  const url = new URL(c.req.url);
  let projectId: string | null = null;

  // Stream routes: parse /v1/stream/<project>/<stream>
  const streamPath = parseStreamPathFromUrl(url.pathname);
  if (streamPath) {
    projectId = streamPath.projectId;
    c.set("projectId", streamPath.projectId);
    c.set("streamId", streamPath.streamId);
    c.set("streamPath", streamPath.path);
  }

  // Parse route segments for config and estuary routes
  const segments = url.pathname.split("/").filter(Boolean);

  // Config routes: /v1/config/:projectId
  if (segments[0] === "v1" && segments[1] === "config" && segments.length === 3) {
    projectId = segments[2];
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      projectId = null;
    }
  }

  // Estuary routes: /v1/estuary/subscribe/* or /v1/estuary/*
  if (segments[0] === "v1" && segments[1] === "estuary") {
    if (segments[2] === "subscribe" && segments.length >= 4) {
      // /v1/estuary/subscribe/<projectId>/<streamId>
      // Everything after "subscribe" is the projectId/streamId combined
      const remainingPath = segments.slice(3).join("/");
      const idx = remainingPath.indexOf("/");
      if (idx === -1) {
        // Only projectId provided
        projectId = remainingPath;
        c.set("projectId", remainingPath);
      } else {
        // projectId/streamId
        projectId = remainingPath.slice(0, idx);
        const streamId = remainingPath.slice(idx + 1);
        c.set("projectId", projectId);
        c.set("streamId", streamId);
      }
    } else if (segments.length >= 3) {
      // /v1/estuary/<projectId>/<estuaryId>
      // Everything after "estuary" is the projectId/estuaryId combined
      const remainingPath = segments.slice(2).join("/");
      const idx = remainingPath.indexOf("/");
      if (idx === -1) {
        // Only projectId provided
        projectId = remainingPath;
        c.set("projectId", remainingPath);
      } else {
        // projectId/estuaryId
        projectId = remainingPath.slice(0, idx);
        const estuaryId = remainingPath.slice(idx + 1);
        c.set("projectId", projectId);
        c.set("estuaryId", estuaryId);
      }
    }
  }

  // Look up project config from KV
  if (projectId && c.env.REGISTRY) {
    const projectConfig = await lookupProjectConfig(c.env.REGISTRY, projectId);
    c.set("projectConfig", projectConfig);
  }
  return next();
}
