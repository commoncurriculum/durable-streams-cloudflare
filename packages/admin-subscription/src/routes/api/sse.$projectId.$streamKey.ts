import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService } from "../../types";

export const Route = createFileRoute("/api/sse/$projectId/$streamKey")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: async ({ params, request }) => {
          const { projectId, streamKey } = params;
          const doKey = `${projectId}/${streamKey}`;
          const core = (env as Record<string, unknown>).CORE as CoreService;

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
