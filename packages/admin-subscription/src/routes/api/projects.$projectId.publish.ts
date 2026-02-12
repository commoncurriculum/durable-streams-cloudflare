import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService, SubscriptionService } from "../../types";

export const Route = createFileRoute("/api/projects/$projectId/publish")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request, params }) => {
          const { projectId } = params;
          const body = (await request.json()) as {
            streamId: string;
            body?: string;
            contentType?: string;
          };
          const streamId = body.streamId?.trim();
          if (!streamId) {
            return new Response(JSON.stringify({ error: "streamId required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const contentType = body.contentType || "application/json";
          const core = (env as Record<string, unknown>).CORE as CoreService;
          const subscription = (env as Record<string, unknown>).SUBSCRIPTION as SubscriptionService;

          // Ensure the source stream exists on core (PUT is idempotent)
          const doKey = `${projectId}/${streamId}`;
          const putResult = await core.putStream(doKey, { contentType });
          if (!putResult.ok) {
            return new Response(
              JSON.stringify({
                error: `Failed to ensure stream exists (${putResult.status})`,
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }

          const payload = new TextEncoder().encode(body.body ?? "");
          const result = (await subscription.adminPublish(
            projectId,
            streamId,
            payload.buffer as ArrayBuffer,
            contentType,
          )) as { status: number; body?: string };

          if (result.status >= 400) {
            return new Response(
              JSON.stringify({ error: result.body ?? `Publish failed (${result.status})` }),
              { status: result.status, headers: { "Content-Type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ ok: true, body: result }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
  },
});
