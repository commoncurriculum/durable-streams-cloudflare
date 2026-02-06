import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

export const Route = createFileRoute("/api/sse/$id")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: async ({ params, request }) => {
          const streamId = params.id;
          const core = (env as Record<string, unknown>).CORE as {
            fetch: typeof fetch;
          };
          const adminToken = (env as Record<string, unknown>).ADMIN_TOKEN as
            | string
            | undefined;

          const url = new URL(
            `/v1/stream/${encodeURIComponent(streamId)}`,
            "https://internal",
          );
          url.search = new URL(request.url).search;

          const headers: Record<string, string> = {};
          if (adminToken) headers["Authorization"] = `Bearer ${adminToken}`;

          const response = await core.fetch(
            new Request(url.toString(), { headers }),
          );
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        },
      }),
  },
});
