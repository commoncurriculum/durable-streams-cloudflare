import handler from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// JWT minting (HMAC-SHA256) — used by the /v1/* proxy to authenticate with core
// ---------------------------------------------------------------------------

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function mintJwt(
  claims: Record<string, unknown>,
  signingSecret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const payloadB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Proxy mutation requests (/v1/*) to the core worker with JWT auth.
    // Only mutations (PUT, POST, DELETE) are proxied — reads go directly
    // from the browser to core (streams are created as public).
    if (url.pathname.startsWith("/v1/") && request.method !== "GET" && request.method !== "HEAD") {
      const e = env as Record<string, unknown>;
      const coreUrl = (e.CORE_URL as string) ?? "http://localhost:8787";
      const signingSecret = e.SIGNING_SECRET as string | undefined;
      const projectId = (e.PROJECT_ID as string) ?? "demo-draw";

      // Mark new streams as public so browsers can read without auth
      const targetUrl = new URL(coreUrl + url.pathname + url.search);
      if (request.method === "PUT" && !targetUrl.searchParams.has("public")) {
        targetUrl.searchParams.set("public", "true");
      }

      const headers = new Headers(request.headers);
      if (signingSecret) {
        const token = await mintJwt(
          {
            sub: projectId,
            scope: "write",
            exp: Math.floor(Date.now() / 1000) + 300,
          },
          signingSecret,
        );
        headers.set("Authorization", `Bearer ${token}`);
      }

      return fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body: request.body,
        // @ts-expect-error — Cloudflare-specific duplex option for streaming bodies
        duplex: "half",
      });
    }

    return handler.fetch(request);
  },
};
