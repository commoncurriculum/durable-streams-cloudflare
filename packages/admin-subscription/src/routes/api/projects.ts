import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { generateSecret, exportJWK } from "jose";
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

          const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
          if (!core) {
            return new Response(JSON.stringify({ error: "CORE service not configured" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          const key = await generateSecret("HS256", { extractable: true });
          const secret = JSON.stringify(await exportJWK(key));

          // Use core RPC to create the project with wildcard CORS so the
          // browser can open SSE connections directly to core.
          try {
            await core.registerProject(projectId, secret, { corsOrigins: ["*"] });
          } catch (err) {
            return new Response(
              JSON.stringify({ error: err instanceof Error ? err.message : "Failed to create project" }),
              {
                status: 500,
                headers: { "Content-Type": "application/json" },
              },
            );
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
