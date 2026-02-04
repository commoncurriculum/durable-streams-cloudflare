import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { EdgeBindings } from "../hono/types";
import { subscribeBodySchema, sessionIdParamSchema } from "../schemas/subscriptions";

export function createSubscriptionRoutes() {
  const app = new Hono<EdgeBindings>();

  app.post("/", zValidator("json", subscribeBodySchema), async (c) => {
    const { sessionId, streamId } = c.req.valid("json");
    const sessionStreamId = `subscriptions/${sessionId}`;

    const response = await forwardToSessionDO(c.env, sessionStreamId, "POST", {
      sessionId,
      streamId,
    });

    return response;
  });

  app.delete("/", zValidator("json", subscribeBodySchema), async (c) => {
    const { sessionId, streamId } = c.req.valid("json");
    const sessionStreamId = `subscriptions/${sessionId}`;

    const response = await forwardToSessionDO(c.env, sessionStreamId, "DELETE", {
      sessionId,
      streamId,
    });

    return response;
  });

  app.get("/:sessionId", zValidator("param", sessionIdParamSchema), async (c) => {
    const { sessionId } = c.req.valid("param");
    const sessionStreamId = `subscriptions/${sessionId}`;

    const response = await forwardToSessionDO(c.env, sessionStreamId, "GET");

    return response;
  });

  return app;
}

async function forwardToSessionDO(
  env: EdgeBindings["Bindings"],
  sessionStreamId: string,
  method: string,
  body?: Record<string, string>,
  path = "/internal/subscriptions",
): Promise<Response> {
  const id = env.STREAMS.idFromName(sessionStreamId);
  const stub = env.STREAMS.get(id);
  const headers = new Headers();
  headers.set("X-Stream-Id", sessionStreamId);
  if (body) headers.set("Content-Type", "application/json");

  const url = new URL(`https://internal${path}`);
  return await stub.fetch(
    new Request(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
