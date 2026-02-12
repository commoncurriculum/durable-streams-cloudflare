import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { SubscriptionService } from "../../types";

export const Route = createFileRoute("/api/projects/$projectId/sessions/$sessionId/unsubscribe")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request, params }) => {
          const { projectId, sessionId } = params;
          const body = (await request.json()) as { streamId: string };
          const streamId = body.streamId?.trim();
          if (!streamId) {
            return new Response(JSON.stringify({ error: "streamId required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const subscription = (env as Record<string, unknown>).SUBSCRIPTION as SubscriptionService;

          const result = await subscription.adminUnsubscribe(projectId, streamId, sessionId);
          return new Response(JSON.stringify({ ok: true, body: result }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
  },
});
