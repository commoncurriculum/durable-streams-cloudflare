import type { Context } from "hono";
import type { AdminEnv } from "../types";

export async function handleStreamInspect(c: Context<{ Bindings: AdminEnv }>) {
  const streamId = c.req.param("id");
  if (!streamId) return c.json({ error: "missing stream id" }, 400);

  const response = await c.env.CORE.fetch(
    new Request(`https://internal/v1/stream/${encodeURIComponent(streamId)}/admin`, {
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
