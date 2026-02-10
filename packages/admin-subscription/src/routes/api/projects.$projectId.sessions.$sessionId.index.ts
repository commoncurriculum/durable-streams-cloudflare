import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { SubscriptionService } from "../../types";

export const Route = createFileRoute(
  "/api/projects/$projectId/sessions/$sessionId",
)({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: async ({ params }) => {
          const { projectId, sessionId } = params;
          const subscription = (env as Record<string, unknown>)
            .SUBSCRIPTION as SubscriptionService | undefined;
          if (!subscription) {
            return new Response(
              JSON.stringify({ error: "SUBSCRIPTION service not configured" }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }

          const result = await subscription.adminGetSession(projectId, sessionId);
          if (!result) {
            return new Response(JSON.stringify({ error: "Session not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
  },
});
