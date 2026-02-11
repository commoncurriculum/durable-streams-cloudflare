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

  // Config routes: extract projectId from /v1/config/:projectId
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "v1" && segments[1] === "config" && segments.length === 3) {
    projectId = segments[2];
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      projectId = null;
    }
  }

  // Look up project config from KV
  if (projectId && c.env.REGISTRY) {
    const projectConfig = await lookupProjectConfig(c.env.REGISTRY, projectId);
    c.set("projectConfig", projectConfig);
  }
  return next();
}
