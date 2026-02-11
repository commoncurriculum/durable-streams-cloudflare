import { type } from "arktype";
import { subscribe as subscribeEstuary } from "../../../subscriptions/subscribe";
import { unsubscribe as unsubscribeEstuary } from "../../../subscriptions/unsubscribe";
import { isValidEstuaryId } from "../../../constants";
import { logError } from "../../../log";

// ============================================================================
// Validation schemas
// ============================================================================

export const subscribeBodySchema = type({
  estuaryId: type("string > 0").pipe((s, ctx) => {
    if (!isValidEstuaryId(s)) return ctx.error("Invalid estuaryId format");
    return s;
  }),
  "contentType?": "string",
});

export const unsubscribeBodySchema = type({
  estuaryId: type("string > 0").pipe((s, ctx) => {
    if (!isValidEstuaryId(s)) return ctx.error("Invalid estuaryId format");
    return s;
  }),
});

// ============================================================================
// Handlers
// ============================================================================

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function subscribe(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const streamId = c.get("streamId");
  const { estuaryId } = c.req.valid("json");
  try {
    return c.json(await subscribeEstuary(c.env, projectId, streamId, estuaryId));
  } catch (err) {
    logError({ projectId, streamId, estuaryId, component: "subscribe" }, "subscribe failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to subscribe" }, 500);
  }
}

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function unsubscribe(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const streamId = c.get("streamId");
  const { estuaryId } = c.req.valid("json");
  try {
    return c.json(await unsubscribeEstuary(c.env, projectId, streamId, estuaryId));
  } catch (err) {
    logError({ projectId, streamId, estuaryId, component: "unsubscribe" }, "unsubscribe failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to remove subscription" }, 500);
  }
}
