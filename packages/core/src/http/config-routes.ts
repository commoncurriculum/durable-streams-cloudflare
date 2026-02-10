import { Hono } from "hono";
import { arktypeValidator } from "@hono/arktype-validator";
import { type } from "arktype";
import { getProjectEntry, putProjectEntry } from "./project-registry";
import type { BaseEnv } from "./create_worker";
import { PROJECT_ID_PATTERN } from "./create_worker";

// ============================================================================
// Validation schemas
// ============================================================================

const projectIdParamSchema = type({
  projectId: type("string > 0").pipe((s, ctx) => {
    if (!PROJECT_ID_PATTERN.test(s)) return ctx.error("invalid project id");
    return s;
  }),
});

const configBodySchema = type({
  signingSecrets: "string[] >= 1",
  "corsOrigins?": "string[]",
  "isPublic?": "boolean",
});

// ============================================================================
// Routes
// ============================================================================

export const configRoutes = new Hono<{ Bindings: BaseEnv }>();

configRoutes.get(
  "/v1/config/:projectId",
  arktypeValidator("param", projectIdParamSchema),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const entry = await getProjectEntry(c.env.REGISTRY, projectId);
    if (!entry) {
      return c.json({ error: "project not found" }, 404);
    }
    return c.json({
      signingSecrets: entry.signingSecrets,
      corsOrigins: entry.corsOrigins ?? [],
      isPublic: entry.isPublic ?? false,
    });
  },
);

configRoutes.put(
  "/v1/config/:projectId",
  arktypeValidator("param", projectIdParamSchema),
  arktypeValidator("json", configBodySchema),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    await putProjectEntry(c.env.REGISTRY, projectId, {
      signingSecrets: body.signingSecrets,
      corsOrigins: body.corsOrigins,
      isPublic: body.isPublic,
    });
    return c.json({ ok: true });
  },
);
