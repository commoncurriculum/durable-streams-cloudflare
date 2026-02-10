import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { SubscriptionService } from "../../types";

export const Route = createFileRoute("/api/sessions")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const body = (await request.json()) as {
            projectId: string;
            sessionId?: string;
          };
          const projectId = body.projectId?.trim();
          if (!projectId) {
            return new Response(
              JSON.stringify({ error: "projectId required" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const sessionId = body.sessionId?.trim() || crypto.randomUUID();

          const subscription = (env as Record<string, unknown>)
            .SUBSCRIPTION as SubscriptionService | undefined;
          if (subscription) {
            await subscription.adminTouchSession(projectId, sessionId);
          }

          return new Response(
            JSON.stringify({ ok: true, sessionId }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        },
      }),
  },
});
