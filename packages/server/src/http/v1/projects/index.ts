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

export const listProjectsResponseSchema = type("string[]");

export type ListProjectsResponse = typeof listProjectsResponseSchema.infer;

export const listProjectStreamsResponseSchema = type([{
  streamId: "string",
  createdAt: "number",
}]);

export type ListProjectStreamsResponse = typeof listProjectStreamsResponseSchema.infer;

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /v1/projects
 * List all project IDs.
 */
// biome-ignore lint: Hono context typing is complex
export async function listProjectsHandler(c: any): Promise<Response> {
  const projects = await listProjects(c.env.REGISTRY);
  return c.json(projects);
}

/**
 * GET /v1/projects/:projectId/streams
 * List streams in a project.
 */
// biome-ignore lint: Hono context typing is complex
export async function listProjectStreamsHandler(c: any): Promise<Response> {
  const { projectId } = c.req.valid("param");
  const streams = await listProjectStreams(c.env.REGISTRY, projectId);
  return c.json(streams);
}
