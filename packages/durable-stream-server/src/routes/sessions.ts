import { Hono } from "hono";
import type { EdgeBindings } from "../hono/types";

export function createSessionRoutes() {
  const app = new Hono<EdgeBindings>();

  app.post("/", async (c) => {
    const sessionId = crypto.randomUUID();
    const sessionStreamId = `subscriptions/${sessionId}`;

    const response = await forwardToSessionDO(
      c.env,
      sessionStreamId,
      "POST",
      { sessionId },
      "/internal/session",
    );

    if (!response.ok) {
      return c.json({ error: "failed to create session" }, response.status as 500);
    }

    return c.json({ sessionId }, 201);
  });

  return app;
}

async function forwardToSessionDO(
  env: EdgeBindings["Bindings"],
  sessionStreamId: string,
  method: string,
  body?: Record<string, string>,
  path = "/internal/session",
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
