/**
 * Minimal HS256 JWT signer for load test auth.
 */

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonToBase64Url(obj: Record<string, unknown>): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function signJwt(
  projectId: string,
  secret: string,
  scope: "write" | "read" = "write",
  ttlSeconds = 3600,
): Promise<string> {
  const header = jsonToBase64Url({ alg: "HS256", typ: "JWT" });
  const payload = jsonToBase64Url({
    sub: projectId,
    scope,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}
