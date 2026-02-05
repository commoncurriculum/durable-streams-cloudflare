import { createMiddleware } from "hono/factory";
import type { EdgeBindings } from "../types";

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Stream-Seq",
  "Stream-TTL",
  "Stream-Expires-At",
  "Stream-Closed",
  "If-None-Match",
  "Producer-Id",
  "Producer-Epoch",
  "Producer-Seq",
  "Authorization",
];

const CORS_EXPOSE_HEADERS = [
  "Stream-Next-Offset",
  "Stream-Cursor",
  "Stream-Up-To-Date",
  "Stream-Closed",
  "ETag",
  "Location",
  "Producer-Epoch",
  "Producer-Seq",
  "Producer-Expected-Seq",
  "Producer-Received-Seq",
  "Stream-SSE-Data-Encoding",
];

export function applyCorsHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
}

export const corsMiddleware = createMiddleware<EdgeBindings>(async (c, next) => {
  if (c.req.method === "OPTIONS") {
    const headers = new Headers();
    applyCorsHeaders(headers);
    return new Response(null, { status: 204, headers });
  }

  await next();

  const response = c.res;
  const newHeaders = new Headers(response.headers);
  applyCorsHeaders(newHeaders);

  c.res = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
});
