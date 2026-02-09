import { Hono } from "hono";
import { getSession, touchSession } from "../../session";
import { logError } from "../../log";
import { isValidSessionId } from "../../constants";
import type { AppEnv } from "../../env";

export const sessionRoutes = new Hono<{ Bindings: AppEnv }>();

sessionRoutes.get("/session/:sessionId", async (c) => {
  const projectId = c.req.param("project")!;
  const sessionId = c.req.param("sessionId");
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: "Invalid sessionId format" }, 400);
  }
  const session = await getSession(c.env, projectId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

sessionRoutes.post("/session/:sessionId/touch", async (c) => {
  const projectId = c.req.param("project")!;
  const sessionId = c.req.param("sessionId");
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: "Invalid sessionId format" }, 400);
  }
  try {
    return c.json(await touchSession(c.env, projectId, sessionId));
  } catch (err) {
    logError({ projectId, sessionId, component: "touch-session" }, "touch session failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Session not found" }, 404);
  }
});
