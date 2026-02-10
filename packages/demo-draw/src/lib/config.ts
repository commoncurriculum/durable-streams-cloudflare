import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { SignJWT } from "jose";

export type RoomConfig = {
  coreUrl: string;
  projectId: string;
  writeToken: string;
};

/**
 * Returns the core URL, project ID, and a write token.
 * The token is minted once per room join — all writes reuse it.
 * Reads need no auth (streams are created as public).
 */
export const getRoomConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<RoomConfig> => {
    const e = env as Record<string, unknown>;
    const coreUrl = (e.CORE_URL as string) ?? "http://localhost:8787";
    const projectId = (e.PROJECT_ID as string) ?? "demo-draw";
    const signingSecret = e.SIGNING_SECRET as string | undefined;

    let writeToken = "";
    if (signingSecret) {
      const secret = new TextEncoder().encode(signingSecret);
      writeToken = await new SignJWT({ sub: projectId, scope: "write" })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("24h")
        .sign(secret);
    }

    return { coreUrl, projectId, writeToken };
  },
);
