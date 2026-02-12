import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService } from "../../types";

export const Route = createFileRoute("/api/streams/$projectId/$id")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        PUT: async ({ params, request }) => {
          const doKey = `${params.projectId}/${params.id}`;
          const core = (env as Record<string, unknown>).CORE as CoreService;
          const contentType = request.headers.get("Content-Type") || "application/json";
          const body = await request.arrayBuffer().catch(() => undefined);
          const result = await core.putStream(doKey, { contentType, body });
          return new Response(null, { status: result.ok ? 201 : result.status });
        },
        POST: async ({ params, request }) => {
          const doKey = `${params.projectId}/${params.id}`;
          const core = (env as Record<string, unknown>).CORE as CoreService;
          const contentType = request.headers.get("Content-Type") || "application/json";
          const payload = await request.arrayBuffer();
          const result = await core.postStream(doKey, payload, contentType);
          const headers: Record<string, string> = {};
          if (result.nextOffset) headers["Stream-Next-Offset"] = result.nextOffset;
          return new Response(null, {
            status: result.ok ? 204 : result.status,
            headers,
          });
        },
        GET: async ({ params, request }) => {
          const doKey = `${params.projectId}/${params.id}`;
          const core = (env as Record<string, unknown>).CORE as CoreService;
          const url = new URL(request.url);
          const offset = url.searchParams.get("offset") ?? "now";
          const result = await core.readStream(doKey, offset);
          return new Response(result.body, {
            status: result.status,
            headers: {
              "Content-Type": result.contentType || "application/json",
              ...(result.nextOffset ? { "Stream-Next-Offset": result.nextOffset } : {}),
            },
          });
        },
      }),
  },
});
