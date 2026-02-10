import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService } from "../../types";

export const Route = createFileRoute("/api/projects/$projectId/sessions")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: async ({ params }) => {
          const projectId = params.projectId;
          const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
          if (!core) {
            return new Response(JSON.stringify({ error: "CORE service not configured" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          const streams = await core.listProjectStreams(projectId);
          const sessions = streams.map((s) => ({
            sessionId: s.streamId,
            createdAt: s.createdAt,
          }));

          return new Response(JSON.stringify(sessions), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
  },
});
