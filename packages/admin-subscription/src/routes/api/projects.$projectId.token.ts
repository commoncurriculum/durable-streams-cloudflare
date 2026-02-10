import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import type { CoreService } from "../../types";
import { mintJwt } from "../../lib/jwt";

export const Route = createFileRoute("/api/projects/$projectId/token")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: async ({ params }) => {
          const { projectId } = params;
          const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
          if (!core) {
            return new Response(
              JSON.stringify({ error: "CORE service not configured" }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }

          const config = await core.getProjectConfig(projectId);
          if (!config) {
            return new Response(
              JSON.stringify({ error: `Project "${projectId}" not found` }),
              { status: 404, headers: { "Content-Type": "application/json" } },
            );
          }

          const primarySecret = config.signingSecrets[0];
          if (!primarySecret) {
            return new Response(
              JSON.stringify({ error: `No signing secret for project "${projectId}"` }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }

          const now = Math.floor(Date.now() / 1000);
          const expiresAt = now + 300; // 5 minutes
          const token = await mintJwt(
            { sub: projectId, scope: "read", iat: now, exp: expiresAt },
            primarySecret,
          );

          return new Response(JSON.stringify({ token, expiresAt }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      }),
  },
});
