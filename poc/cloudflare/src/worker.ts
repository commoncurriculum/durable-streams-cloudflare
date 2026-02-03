import { StreamDO } from "./stream_do";

export interface Env {
  STREAMS: DurableObjectNamespace;
  DB: D1Database;
  AUTH_TOKEN?: string;
  R2?: R2Bucket;
}

const STREAM_PREFIX = "/v1/stream/";
const REGISTRY_STREAM = "__registry__";

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

function applyCors(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
}

async function recordRegistryEvent(
  requestUrl: string,
  authToken: string | undefined,
  event: {
    type: "stream";
    key: string;
    value?: { path: string; contentType: string; createdAt: number };
    headers: { operation: "insert" | "delete" };
  },
): Promise<void> {
  const registryUrl = new URL(`${STREAM_PREFIX}${REGISTRY_STREAM}`, requestUrl);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  await fetch(
    new Request(registryUrl, {
      method: "PUT",
      headers,
    }),
  );

  await fetch(
    new Request(registryUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(STREAM_PREFIX)) {
      return new Response("not found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      const headers = new Headers();
      applyCors(headers);
      return new Response(null, { status: 204, headers });
    }

    if (env.AUTH_TOKEN) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    const streamId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
    if (!streamId) {
      return new Response("missing stream id", { status: 400 });
    }

    const id = env.STREAMS.idFromName(streamId);
    const stub = env.STREAMS.get(id);

    const headers = new Headers(request.headers);
    headers.set("X-Stream-Id", streamId);

    const upstreamReq = new Request(request, { headers });
    const response = await stub.fetch(upstreamReq);
    const responseHeaders = new Headers(response.headers);
    applyCors(responseHeaders);
    const wrapped = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    if (streamId !== REGISTRY_STREAM) {
      if (request.method === "PUT" && response.status === 201) {
        const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
        ctx.waitUntil(
          recordRegistryEvent(request.url, env.AUTH_TOKEN, {
            type: "stream",
            key: streamId,
            value: {
              path: streamId,
              contentType,
              createdAt: Date.now(),
            },
            headers: { operation: "insert" },
          }),
        );
      } else if (request.method === "DELETE" && response.status === 204) {
        ctx.waitUntil(
          recordRegistryEvent(request.url, env.AUTH_TOKEN, {
            type: "stream",
            key: streamId,
            headers: { operation: "delete" },
          }),
        );
      }
    }

    return wrapped;
  },
};

export { StreamDO };
