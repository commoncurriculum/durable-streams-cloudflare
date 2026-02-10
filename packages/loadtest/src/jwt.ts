/**
 * Minimal HS256 JWT signer for load test auth.
 */

import { SignJWT } from "jose";

export async function signJwt(
  projectId: string,
  secret: string,
  scope: "write" | "read" = "write",
  ttlSeconds = 3600,
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  const jwt = await new SignJWT({
    sub: projectId,
    scope,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secretKey);

  return jwt;
}
