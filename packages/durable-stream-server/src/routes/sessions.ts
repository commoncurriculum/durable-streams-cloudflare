import { Hono } from "hono";
import type { EdgeBindings } from "../hono/types";

// Session TTL: 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

    // Also write to D1 for admin API visibility
    const db = c.env.ADMIN_DB;
    if (db) {
      const now = Date.now();
      const expiresAt = now + SESSION_TTL_MS;
      try {
        await db
          .prepare(
            `INSERT INTO sessions (session_id, created_at, expires_at) VALUES (?, ?, ?)`
          )
          .bind(sessionId, now, expiresAt)
          .run();
      } catch {
        // Log but don't fail - DO is the source of truth
        console.error("Failed to write session to D1");
      }
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
