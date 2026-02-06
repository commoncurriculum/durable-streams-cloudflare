import handler from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification (defense-in-depth)
// ---------------------------------------------------------------------------

let cachedKeys: { keys: CryptoKey[]; expiresAt: number } | null = null;

async function fetchPublicKeys(certsUrl: string): Promise<CryptoKey[]> {
  if (cachedKeys && Date.now() < cachedKeys.expiresAt) {
    return cachedKeys.keys;
  }

  const response = await fetch(certsUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Access certs: ${response.status}`);
  }

  const { keys } = (await response.json()) as {
    keys: JsonWebKey[];
  };

  const imported = await Promise.all(
    keys.map((jwk) =>
      crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    ),
  );

  // Cache for 5 minutes
  cachedKeys = { keys: imported, expiresAt: Date.now() + 5 * 60 * 1000 };
  return imported;
}

function decodeBase64Url(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function verifyAccessJwt(
  jwt: string,
  certsUrl: string,
): Promise<boolean> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;

  const payload = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(parts[1])),
  ) as { exp?: number };

  // Check expiration
  if (payload.exp && payload.exp < Date.now() / 1000) {
    return false;
  }

  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = decodeBase64Url(parts[2]);

  const keys = await fetchPublicKeys(certsUrl);

  // Try each key — Cloudflare rotates keys
  for (const key of keys) {
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.buffer as ArrayBuffer,
      signingInput,
    );
    if (valid) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request) {
    const teamDomain = (env as Record<string, unknown>)
      .CF_ACCESS_TEAM_DOMAIN as string | undefined;

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
