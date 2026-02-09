import { Hono } from "hono";
import { arktypeValidator } from "@hono/arktype-validator";
import { type } from "arktype";
import { subscribe } from "../../subscriptions/subscribe";
import { unsubscribe } from "../../subscriptions/unsubscribe";
import { deleteSession } from "../../session";
import { logError } from "../../log";
import { isValidSessionId, SESSION_ID_PATTERN, STREAM_ID_PATTERN } from "../../constants";
import type { AppEnv } from "../../env";

// #region synced-to-docs:subscribe-schema
const subscribeSchema = type({
  sessionId: type("string > 0").pipe((s, ctx) => {
    if (!SESSION_ID_PATTERN.test(s)) return ctx.error("Invalid sessionId format");
    return s;
  }),
  streamId: type("string > 0").pipe((s, ctx) => {
    if (!STREAM_ID_PATTERN.test(s)) return ctx.error("Invalid streamId format");
    return s;
  }),
  "contentType?": "string",
});

const unsubscribeSchema = type({
  sessionId: type("string > 0").pipe((s, ctx) => {
    if (!SESSION_ID_PATTERN.test(s)) return ctx.error("Invalid sessionId format");
    return s;
  }),
  streamId: type("string > 0").pipe((s, ctx) => {
    if (!STREAM_ID_PATTERN.test(s)) return ctx.error("Invalid streamId format");
    return s;
  }),
});
// #endregion synced-to-docs:subscribe-schema

export const subscribeRoutes = new Hono<{ Bindings: AppEnv }>();

subscribeRoutes.post("/subscribe", arktypeValidator("json", subscribeSchema), async (c) => {
  const projectId = c.req.param("project")!;
  const { sessionId, streamId } = c.req.valid("json");
  try {
    return c.json(await subscribe(c.env, projectId, streamId, sessionId));
  } catch (err) {
    logError({ projectId, streamId, sessionId, component: "subscribe" }, "subscribe failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to subscribe" }, 500);
  }
});

subscribeRoutes.delete("/unsubscribe", arktypeValidator("json", unsubscribeSchema), async (c) => {
  const projectId = c.req.param("project")!;
  const { sessionId, streamId } = c.req.valid("json");
  try {
    return c.json(await unsubscribe(c.env, projectId, streamId, sessionId));
  } catch (err) {
    logError({ projectId, streamId, sessionId, component: "unsubscribe" }, "unsubscribe failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to remove subscription" }, 500);
  }
});

subscribeRoutes.delete("/session/:sessionId", async (c) => {
  const projectId = c.req.param("project")!;
  const sessionId = c.req.param("sessionId");
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: "Invalid sessionId format" }, 400);
  }
  try {
    return c.json(await deleteSession(c.env, projectId, sessionId));
  } catch (err) {
    logError({ projectId, sessionId, component: "delete-session" }, "delete session failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to delete session stream" }, 500);
  }
});
