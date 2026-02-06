import type { Context } from "hono";
import type { AdminSubscriptionEnv } from "../types";
import { queryAnalytics, QUERIES } from "../analytics";

export async function handleSessionInspect(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const sessionId = c.req.param("id");
  if (!sessionId) return c.json({ error: "missing session id" }, 400);

  const response = await c.env.SUBSCRIPTION.fetch(
    new Request(`https://internal/v1/session/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${c.env.ADMIN_TOKEN}` },
    }),
  );

  if (!response.ok) {
    const text = await response.text();
    return c.json({ error: text }, response.status as 400);
  }

  const data = await response.json();
  return c.json(data);
}

export async function handleStreamInspect(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const streamId = c.req.param("id");
  if (!streamId) return c.json({ error: "missing stream id" }, 400);

  const rows = await queryAnalytics(c.env, QUERIES.streamSubscribers(streamId));
  return c.json(rows);
}
