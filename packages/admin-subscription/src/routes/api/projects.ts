import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService } from "../../types";

export const Route = createFileRoute("/api/projects")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const body = (await request.json()) as { projectId: string };
          const projectId = body.projectId?.trim();
          if (!projectId) {
            return new Response(JSON.stringify({ error: "projectId required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
          if (!kv) {
            return new Response(JSON.stringify({ error: "REGISTRY not configured" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          const secret = crypto.randomUUID() + crypto.randomUUID();
          await kv.put(projectId, JSON.stringify({ signingSecrets: [secret] }));

          // Also register in core so core can verify JWTs
          const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
          if (core) {
            await core.registerProject(projectId, secret);
          }

          return new Response(
            JSON.stringify({ ok: true, signingSecret: secret }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      }),
  },
});
