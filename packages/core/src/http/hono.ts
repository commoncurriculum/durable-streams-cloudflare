import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { StreamContext } from "./router";

// ============================================================================
// Types
// ============================================================================

export type EdgeEnv = {
  STREAMS: DurableObjectNamespace;
  AUTH_TOKEN?: string;
  CACHE_MODE?: string;
  READ_JWT_SECRET?: string;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_TIMING?: string;
  METRICS?: AnalyticsEngineDataset;
};

export type EdgeBindings = {
  Bindings: EdgeEnv;
  Variables: {
    timing?: { start: (name: string) => () => void } | null;
  };
};

export type DoBindings = {
  Bindings: Record<string, never>;
  Variables: {
    ctx: StreamContext;
    streamId: string;
  };
};

export type EdgeContext = Context<EdgeBindings>;
export type DoContext = Context<DoBindings>;

// ============================================================================
// CORS Middleware
// ============================================================================

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Stream-Seq",
  "Stream-TTL",
  "Stream-Expires-At",
  "Stream-Closed",
  "If-None-Match",
  "Producer-Id",
  "Producer-Epoch",
  "Producer-Seq",
  "Authorization",
];

const CORS_EXPOSE_HEADERS = [
  "Stream-Next-Offset",
  "Stream-Cursor",
  "Stream-Up-To-Date",
  "Stream-Closed",
  "ETag",
  "Location",
  "Producer-Epoch",
  "Producer-Seq",
  "Producer-Expected-Seq",
  "Producer-Received-Seq",
  "Stream-SSE-Data-Encoding",
];

export function applyCorsHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
}

export const corsMiddleware = createMiddleware<EdgeBindings>(async (c, next) => {
  if (c.req.method === "OPTIONS") {
    const headers = new Headers();
    applyCorsHeaders(headers);
    return new Response(null, { status: 204, headers });
  }

  await next();

  const response = c.res;
  const newHeaders = new Headers(response.headers);
  applyCorsHeaders(newHeaders);

  c.res = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
});

// ============================================================================
// Auth Middleware
// ============================================================================

export const bearerAuthMiddleware = createMiddleware<EdgeBindings>(async (c, next) => {
  const authToken = c.env.AUTH_TOKEN;

  if (!authToken) {
    return await next();
  }

  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${authToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  return await next();
});

// ============================================================================
// DO Context Middleware
// ============================================================================

export function createDoContextMiddleware(ctx: StreamContext, streamId: string) {
  return createMiddleware<DoBindings>(async (c, next) => {
    c.set("ctx", ctx);
    c.set("streamId", streamId);
    return next();
  });
}

// ============================================================================
// Edge App
// ============================================================================

export function createEdgeApp() {
  const app = new Hono<EdgeBindings>();

  app.onError((err, c) => {
    console.error("Hono error:", err);
    return c.json({ error: err.message }, 500);
  });

  app.use("*", corsMiddleware);
  app.use("*", bearerAuthMiddleware);

  // Core package only handles streams - no admin/subscription routes
  app.all("*", (c) => {
    return c.json({ error: "not found" }, 404);
  });

  return app;
}

export type EdgeAppType = ReturnType<typeof createEdgeApp>;

// ============================================================================
// DO App
// ============================================================================

export function createDoApp(ctx: StreamContext, streamId: string) {
  const app = new Hono<DoBindings>();

  app.use("*", createDoContextMiddleware(ctx, streamId));

  // Admin config endpoint - returns stream metadata for admin queries
  app.get("/internal/admin/config", async (c) => {
    const streamCtx = c.get("ctx");
    const id = c.get("streamId");

    const meta = await streamCtx.getStream(id);
    if (!meta) {
      return c.json({ error: "stream not found" }, 404);
    }

    return c.json({
      streamId: id,
      contentType: meta.content_type,
      closed: meta.closed === 1,
      tailOffset: meta.tail_offset,
      createdAt: meta.created_at,
      expiresAt: meta.expires_at,
    });
  });

  return app;
}

export type DoAppType = ReturnType<typeof createDoApp>;
