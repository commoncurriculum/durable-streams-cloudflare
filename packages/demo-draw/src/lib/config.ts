import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

export type RoomConfig = {
  coreUrl: string;
  projectId: string;
};

/**
 * Returns the core URL and project ID.
 * Both reads and writes go directly to coreUrl.
 * Writes include a JWT minted by getWriteToken().
 * Reads need no auth (streams are created as public).
 */
export const getRoomConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<RoomConfig> => {
    const e = env as Record<string, unknown>;
    return {
      coreUrl: (e.CORE_URL as string) ?? "http://localhost:8787",
      projectId: (e.PROJECT_ID as string) ?? "demo-draw",
    };
  },
);

// ---------------------------------------------------------------------------
// JWT minting (HMAC-SHA256) for authenticating writes to core
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

/**
 * Mint a short-lived write token for the DurableStream client.
 * Called per-request as a dynamic header so each write gets a fresh JWT.
 */
export const getWriteToken = createServerFn({ method: "GET" }).handler(
  async (): Promise<string> => {
    const e = env as Record<string, unknown>;
    const signingSecret = e.SIGNING_SECRET as string | undefined;
    if (!signingSecret) return "";
    const projectId = (e.PROJECT_ID as string) ?? "demo-draw";
    return mintJwt(
      {
        sub: projectId,
        scope: "write",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      signingSecret,
    );
  },
);
