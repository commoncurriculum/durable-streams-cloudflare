import { type } from "arktype";
import { getProjectEntry, putProjectEntry } from "../../../storage/registry";
import { PROJECT_ID_PATTERN } from "../../router";
import { errorResponse } from "../../shared/errors";

// ============================================================================
// Validation schemas (used by router for arktypeValidator)
// ============================================================================

export const projectIdParamSchema = type({
  projectId: type("string > 0").pipe((s, ctx) => {
    if (!PROJECT_ID_PATTERN.test(s)) return ctx.error("invalid project id");
    return s;
  }),
});

export const putConfigRequestSchema = type({
  signingSecrets: "string[] >= 1",
  "corsOrigins?": "string[]",
  "isPublic?": "boolean",
});

export const getConfigResponseSchema = type({
  signingSecrets: "string[]",
  corsOrigins: "string[]",
  isPublic: "boolean",
});

export type GetConfigResponse = typeof getConfigResponseSchema.infer;

export const putConfigResponseSchema = type({
  ok: "boolean",
});

export type PutConfigResponse = typeof putConfigResponseSchema.infer;

// ============================================================================
// Handlers
// ============================================================================

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function getConfig(c: any): Promise<Response> {
  const jwtClaims = c.get("jwtClaims");
  if (!jwtClaims) {
    return errorResponse(401, "unauthorized");
  }
  const { projectId } = c.req.valid("param");
  if (jwtClaims.sub !== projectId || jwtClaims.scope !== "manage") {
    return errorResponse(403, "forbidden");
  }
  const entry = await getProjectEntry(c.env.REGISTRY, projectId);
  if (!entry) {
    return c.json({ error: "project not found" }, 404);
  }
  const data: GetConfigResponse = {
    signingSecrets: entry.signingSecrets,
    corsOrigins: entry.corsOrigins ?? [],
    isPublic: entry.isPublic ?? false,
  };
  return c.json(data);
}

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function putConfig(c: any): Promise<Response> {
  const jwtClaims = c.get("jwtClaims");
  if (!jwtClaims) {
    return errorResponse(401, "unauthorized");
  }
  const { projectId } = c.req.valid("param");
  if (jwtClaims.sub !== projectId || jwtClaims.scope !== "manage") {
    return errorResponse(403, "forbidden");
  }
  const body = c.req.valid("json");
  await putProjectEntry(c.env.REGISTRY, projectId, {
    signingSecrets: body.signingSecrets,
    corsOrigins: body.corsOrigins,
    isPublic: body.isPublic,
  });
  const data: PutConfigResponse = { ok: true };
  return c.json(data);
}
