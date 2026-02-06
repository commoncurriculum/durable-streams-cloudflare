import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService } from "../../types";

export const Route = createFileRoute("/api/sse/$project/$id")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: async ({ params, request }) => {
          const { project, id: streamId } = params;
          const core = (env as Record<string, unknown>).CORE as CoreService;
          const doKey = `${project}/${streamId}`;

          const url = new URL(request.url);
          const sseRequest = new Request(
            `https://internal/v1/stream?${url.searchParams.toString()}`,
          );

          const response = await core.routeRequest(doKey, sseRequest);
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        },
      }),
  },
});
