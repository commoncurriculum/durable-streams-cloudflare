import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

export type RoomConfig = {
  coreUrl: string;
  projectId: string;
};

/**
 * Returns the core URL and project ID.
 * Writes go through the same-origin proxy (JWT added server-side).
 * Reads go directly to coreUrl (streams are public, no auth needed).
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
