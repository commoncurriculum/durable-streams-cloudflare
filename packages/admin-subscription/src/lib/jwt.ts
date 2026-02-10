import { SignJWT } from "jose";

export async function mintJwt(
  claims: Record<string, unknown>,
  signingSecret: string,
): Promise<string> {
  const secret = new TextEncoder().encode(signingSecret);
  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secret);

  return jwt;
}
