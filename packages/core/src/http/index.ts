import { Hono } from "hono";
import { applyCorsHeaders, parseGlobalCorsOrigins, resolveCorsOrigin } from "./middleware/cors";
import type { ProjectConfig, ProjectJwtClaims } from "./middleware/auth";
import { lookupProjectConfig, extractBearerToken, verifyProjectJwtMultiKey } from "./middleware/auth";
import { parseStreamPathFromUrl, PROJECT_ID_PATTERN } from "./shared/stream-path";
import type { StreamDO } from "./durable-object";
import type { InFlightResult } from "./middleware/coalesce";
import { mountRoutes } from "./router";

// ============================================================================
// Types
// ============================================================================

export type BaseEnv = {
  STREAMS: DurableObjectNamespace<StreamDO>;
  R2?: R2Bucket;
  DEBUG_TIMING?: string;
  METRICS?: AnalyticsEngineDataset;
  /**
   * KV namespace storing per-project signing secrets and stream metadata.
   * SECURITY: Must use private ACL — contains JWT signing secrets.
   */
  REGISTRY: KVNamespace;
  /**
   * Comma-separated list of CORS origins that are allowed for ALL projects,
   * in addition to each project's own corsOrigins list.
   * Example: "https://admin.example.com,https://dashboard.example.com"
   */
  CORS_ORIGINS?: string;
};

export { PROJECT_ID_PATTERN } from "./shared/stream-path";

// ============================================================================
// Factory
// ============================================================================

export function createStreamWorker<E extends BaseEnv = BaseEnv>(): ExportedHandler<E> {
  type AppEnv = {
    Bindings: E;
    Variables: {
      projectConfig: ProjectConfig | null;
      jwtClaims: ProjectJwtClaims | null;
      projectId: string | null;
      streamId: string | null;
      streamPath: string | null;
      corsOrigin: string | null;
    };
  };

  const inFlight = new Map<string, Promise<InFlightResult>>();
  const app = new Hono<AppEnv>();

  // ================================================================
  // Path Parsing + Project Config Lookup Middleware
  // ================================================================
  app.use("*", async (c, next) => {
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
  });

  // ================================================================
  // CORS Middleware
  // ================================================================
  app.use("*", async (c, next) => {
    const projectConfig = c.get("projectConfig");
    const globalOrigins = parseGlobalCorsOrigins(c.env.CORS_ORIGINS);
    let corsOrigin = resolveCorsOrigin(projectConfig?.corsOrigins, globalOrigins, c.req.header("Origin") ?? null);

    // ?public=true implies wildcard CORS when no origins are configured
    if (!corsOrigin && new URL(c.req.url).searchParams.get("public") === "true") {
      corsOrigin = "*";
    }

    c.set("corsOrigin", corsOrigin);

    // Handle OPTIONS preflight
    if (c.req.method === "OPTIONS") {
      const headers = new Headers();
      applyCorsHeaders(headers, corsOrigin);
      return new Response(null, { status: 204, headers });
    }

    await next();

    // Apply CORS headers to response
    applyCorsHeaders(c.res.headers, corsOrigin);
  });

  // ================================================================
  // JWT Auth Middleware (shared across all routes)
  // ================================================================
  app.use("*", async (c, next) => {
    const token = extractBearerToken(c.req.raw);
    if (!token) {
      c.set("jwtClaims", null);
      return next();
    }

    const projectConfig = c.get("projectConfig");
    if (!projectConfig) {
      c.set("jwtClaims", null);
      return next();
    }

    // Validate JWT signature against project's signing secrets
    const claims = await verifyProjectJwtMultiKey(token, projectConfig);
    if (!claims) {
      c.set("jwtClaims", null);
      return next();
    }

    // Check token is not expired
    if (Date.now() >= claims.exp * 1000) {
      c.set("jwtClaims", null);
      return next();
    }

    c.set("jwtClaims", claims);
    return next();
  });

  // ================================================================
  // Routes (all defined in router.ts)
  // ================================================================
  mountRoutes<E>(app, inFlight);

  return {
    fetch: app.fetch,
  };
}
