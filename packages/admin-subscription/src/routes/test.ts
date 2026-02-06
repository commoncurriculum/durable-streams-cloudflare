import type { Context } from "hono";
import type { AdminSubscriptionEnv } from "../types";

type TestPayload = {
  action: "subscribe" | "unsubscribe" | "publish" | "touch" | "delete";
  sessionId?: string;
  streamId?: string;
  contentType?: string;
  body?: string;
};

const VALID_ACTIONS = ["subscribe", "unsubscribe", "publish", "touch", "delete"];

export async function handleTest(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const payload = await c.req.json<TestPayload>();

  if (!payload.action || !VALID_ACTIONS.includes(payload.action)) {
    return c.json({ error: "action must be one of: subscribe, unsubscribe, publish, touch, delete" }, 400);
  }

  const authHeaders: Record<string, string> = {};
  if (c.env.ADMIN_TOKEN) {
    authHeaders["Authorization"] = `Bearer ${c.env.ADMIN_TOKEN}`;
  }

  let request: Request;

  switch (payload.action) {
    case "subscribe": {
      if (!payload.sessionId || !payload.streamId) {
        return c.json({ error: "subscribe requires sessionId and streamId" }, 400);
      }
      request = new Request("https://internal/v1/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ sessionId: payload.sessionId, streamId: payload.streamId }),
      });
      break;
    }
    case "unsubscribe": {
      if (!payload.sessionId || !payload.streamId) {
        return c.json({ error: "unsubscribe requires sessionId and streamId" }, 400);
      }
      request = new Request("https://internal/v1/unsubscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ sessionId: payload.sessionId, streamId: payload.streamId }),
      });
      break;
    }
    case "publish": {
      if (!payload.streamId) {
        return c.json({ error: "publish requires streamId" }, 400);
      }
      const contentType = payload.contentType ?? "application/json";
      request = new Request(`https://internal/v1/publish/${encodeURIComponent(payload.streamId)}`, {
        method: "POST",
        headers: { "Content-Type": contentType, ...authHeaders },
        body: payload.body ?? "",
      });
      break;
    }
    case "touch": {
      if (!payload.sessionId) {
        return c.json({ error: "touch requires sessionId" }, 400);
      }
      request = new Request(`https://internal/v1/session/${encodeURIComponent(payload.sessionId)}/touch`, {
        method: "POST",
        headers: authHeaders,
      });
      break;
    }
    case "delete": {
      if (!payload.sessionId) {
        return c.json({ error: "delete requires sessionId" }, 400);
      }
      request = new Request(`https://internal/v1/session/${encodeURIComponent(payload.sessionId)}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      break;
    }
  }

  const response = await c.env.SUBSCRIPTION.fetch(request);

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
