import { Hono } from "hono";
import { getSession, touchSession } from "../../session";
import type { AppEnv } from "../../env";

export const sessionRoutes = new Hono<{ Bindings: AppEnv }>();

sessionRoutes.get("/session/:sessionId", async (c) => {
  const projectId = c.req.param("project")!;
  const sessionId = c.req.param("sessionId");
  const session = await getSession(c.env, projectId, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

sessionRoutes.post("/session/:sessionId/touch", async (c) => {
  const projectId = c.req.param("project")!;
  const sessionId = c.req.param("sessionId");
  try {
    return c.json(await touchSession(c.env, projectId, sessionId));
  } catch {
    return c.json({ error: "Session not found" }, 404);
  }
});
