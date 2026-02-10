import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService, SubscriptionService } from "../../types";

export const Route = createFileRoute(
  "/api/projects/$projectId/sessions/$sessionId/subscribe",
)({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request, params }) => {
          const { projectId, sessionId } = params;
          const body = (await request.json()) as { streamId: string };
          const streamId = body.streamId?.trim();
          if (!streamId) {
            return new Response(
              JSON.stringify({ error: "streamId required" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const core = (env as Record<string, unknown>).CORE as CoreService;
          const subscription = (env as Record<string, unknown>)
            .SUBSCRIPTION as SubscriptionService;

          // Ensure the source stream exists on core (PUT is idempotent)
          const doKey = `${projectId}/${streamId}`;
          const putResult = await core.putStream(doKey, {
            contentType: "application/json",
          });
          if (!putResult.ok) {
            return new Response(
              JSON.stringify({
                error: `Failed to ensure stream exists (${putResult.status})`,
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }

          const result = await subscription.adminSubscribe(
            projectId,
            streamId,
            sessionId,
          );
          return new Response(JSON.stringify({ ok: true, body: result }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
  },
});
