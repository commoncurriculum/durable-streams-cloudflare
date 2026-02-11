import { Hono } from "hono";
import { arktypeValidator } from "@hono/arktype-validator";
import { type } from "arktype";
import { subscribe } from "../../../subscriptions/subscribe";
import { unsubscribe } from "../../../subscriptions/unsubscribe";
import { logError } from "../../../log";
import { isValidEstuaryId } from "../../../constants";
import type { BaseEnv } from "../../index";

// Validation schemas
const subscribeSchema = type({
  estuaryId: type("string > 0").pipe((s, ctx) => {
    if (!isValidEstuaryId(s)) return ctx.error("Invalid estuaryId format");
    return s;
  }),
  "contentType?": "string",
});

const unsubscribeSchema = type({
  estuaryId: type("string > 0").pipe((s, ctx) => {
    if (!isValidEstuaryId(s)) return ctx.error("Invalid estuaryId format");
    return s;
  }),
});

export const subscribeRoutes = new Hono<{ Bindings: BaseEnv }>();

subscribeRoutes.post(
  "/subscribe/:projectId/:streamId", 
  arktypeValidator("json", subscribeSchema), 
  async (c) => {
    const projectId = c.req.param("projectId");
    const streamId = c.req.param("streamId");
    const { estuaryId } = c.req.valid("json");
    try {
      return c.json(await subscribe(c.env, projectId, streamId, estuaryId));
    } catch (err) {
      logError({ projectId, streamId, estuaryId, component: "subscribe" }, "subscribe failed", err);
      return c.json({ error: err instanceof Error ? err.message : "Failed to subscribe" }, 500);
    }
  }
);

subscribeRoutes.delete(
  "/subscribe/:projectId/:streamId", 
  arktypeValidator("json", unsubscribeSchema), 
  async (c) => {
    const projectId = c.req.param("projectId");
    const streamId = c.req.param("streamId");
    const { estuaryId } = c.req.valid("json");
    try {
      return c.json(await unsubscribe(c.env, projectId, streamId, estuaryId));
    } catch (err) {
      logError({ projectId, streamId, estuaryId, component: "unsubscribe" }, "unsubscribe failed", err);
      return c.json({ error: err instanceof Error ? err.message : "Failed to remove subscription" }, 500);
    }
  }
);
