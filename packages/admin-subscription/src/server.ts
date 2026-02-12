import handler from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification (defense-in-depth)
// ---------------------------------------------------------------------------

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(certsUrl: string) {
  if (!jwksCache.has(certsUrl)) {
    jwksCache.set(certsUrl, createRemoteJWKSet(new URL(certsUrl)));
  }
  return jwksCache.get(certsUrl)!;
}

async function verifyAccessJwt(jwt: string, certsUrl: string): Promise<boolean> {
  try {
    const JWKS = getJWKS(certsUrl);
    await jwtVerify(jwt, JWKS, {
      algorithms: ["RS256"],
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request) {
    const teamDomain = (env as Record<string, unknown>).CF_ACCESS_TEAM_DOMAIN as string | undefined;

    if (teamDomain) {
      const jwt = request.headers.get("cf-access-jwt-assertion");
      if (!jwt) return new Response("Unauthorized", { status: 401 });

      const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
      const valid = await verifyAccessJwt(jwt, certsUrl);
      if (!valid) return new Response("Forbidden", { status: 403 });
    }

    return handler.fetch(request);
  },
};
