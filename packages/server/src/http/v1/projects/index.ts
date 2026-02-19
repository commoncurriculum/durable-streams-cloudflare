import { type } from "arktype";
import { listProjects, listProjectStreams } from "../../../storage/registry";
import { PROJECT_ID_PATTERN } from "../../router";

// ============================================================================
// Validation schemas
// ============================================================================

export const projectIdParamSchema = type({
  projectId: type("string > 0").pipe((s, ctx) => {
    if (!PROJECT_ID_PATTERN.test(s)) return ctx.error("invalid project id");
    return s;
  }),
});

export const streamIdParamSchema = type({
  streamId: type("string > 0"),
});

export const listProjectsResponseSchema = type("string[]");

export type ListProjectsResponse = typeof listProjectsResponseSchema.infer;

export const listProjectStreamsResponseSchema = type([{
  streamId: "string",
  createdAt: "number",
}]);

export type ListProjectStreamsResponse = typeof listProjectStreamsResponseSchema.infer;

export const inspectStreamResponseSchema = type({
  streamId: "string",
  contentType: "string",
  tailOffset: "number",
  closed: "boolean",
  "public": "boolean",
  "createdAt?": "number",
  "closedAt?": "number",
  "ttlSeconds?": "number",
  "expiresAt?": "number",
});

export type InspectStreamResponse = typeof inspectStreamResponseSchema.infer;

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /v1/projects
 * List all project IDs.
 * Public endpoint - no auth required.
 */
// biome-ignore lint: Hono context typing is complex
export async function listProjectsHandler(c: any): Promise<Response> {
  const projects = await listProjects(c.env.REGISTRY);
  return c.json(projects);
}

/**
 * GET /v1/projects/:projectId/streams
 * List streams in a project.
 * Public endpoint - no auth required.
 */
// biome-ignore lint: Hono context typing is complex
export async function listProjectStreamsHandler(c: any): Promise<Response> {
  const { projectId } = c.req.valid("param");
  const streams = await listProjectStreams(c.env.REGISTRY, projectId);
  return c.json(streams);
}

/**
 * GET /v1/inspect/:streamPath{.+}
 * Get stream metadata (tail offset, content type, etc.)
 * Public endpoint - no auth required. Does not use pathParsingMiddleware.
 */
// biome-ignore lint: Hono context typing is complex
export async function inspectStreamHandler(c: any): Promise<Response> {
  // Get streamPath from params directly (not from context variables)
  const streamPath = c.req.param("streamPath");
  
  if (!streamPath) {
    return c.json({ code: "STREAM_NOT_FOUND", error: "stream path missing" }, 404);
  }
  
  try {
    // The streamPath is the full DO key (projectId/streamId or just streamId)
    const stub = c.env.STREAMS.get(c.env.STREAMS.idFromName(streamPath));
    
    // Call the getStreamMeta RPC method
    const metadata = await stub.getStreamMeta(streamPath);
    
    if (!metadata) {
      return c.json({ code: "STREAM_NOT_FOUND", error: "stream not found" }, 404);
    }

    const response: InspectStreamResponse = {
      streamId: metadata.stream_id,
      contentType: metadata.content_type,
      tailOffset: metadata.tail_offset,
      closed: metadata.closed === 1,
      public: metadata.public === 1,
    };

    if (metadata.created_at) {
      response.createdAt = metadata.created_at;
    }
    if (metadata.closed_at) {
      response.closedAt = metadata.closed_at;
    }
    if (metadata.ttl_seconds) {
      response.ttlSeconds = metadata.ttl_seconds;
    }
    if (metadata.expires_at) {
      response.expiresAt = metadata.expires_at;
    }

    return c.json(response);
  } catch (error) {
    return c.json({ code: "INTERNAL_ERROR", error: String(error) }, 500);
  }
}

