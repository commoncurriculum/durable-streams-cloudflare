import type { Context } from "hono";
import type { AdminEnv } from "../types";

type TestPayload = {
  streamId: string;
  contentType?: string;
  body: string;
  action: "create" | "append";
};

export async function handleTest(c: Context<{ Bindings: AdminEnv }>) {
  const payload = await c.req.json<TestPayload>();
  if (!payload.streamId) return c.json({ error: "missing streamId" }, 400);
  if (!payload.action || !["create", "append"].includes(payload.action)) {
    return c.json({ error: "action must be 'create' or 'append'" }, 400);
  }

  const contentType = payload.contentType ?? "application/json";
  const method = payload.action === "create" ? "PUT" : "POST";

  const response = await c.env.CORE.fetch(
    new Request(`https://internal/v1/stream/${encodeURIComponent(payload.streamId)}`, {
      method,
      headers: {
        "Content-Type": contentType,
        Authorization: `Bearer ${c.env.ADMIN_TOKEN}`,
      },
      body: payload.body,
    }),
  );

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return c.json({
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
