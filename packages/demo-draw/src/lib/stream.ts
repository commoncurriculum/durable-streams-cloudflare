import { DurableStream } from "@durable-streams/client";
import { getWriteToken } from "./config";

export type StrokeMessage = {
  type: "stroke";
  userId: string;
  points: [number, number, number][]; // [x, y, pressure]
  color: string;
  width: number;
};

export type ClearMessage = {
  type: "clear";
  userId: string;
};

export type DrawMessage = StrokeMessage | ClearMessage;

function streamPath(projectId: string, roomId: string): string {
  return `/v1/stream/${encodeURIComponent(projectId)}/${encodeURIComponent(roomId)}`;
}

/**
 * Get a DurableStream write handle pointing directly at core.
 * Uses a dynamic Authorization header — each request calls the
 * getWriteToken server function for a fresh short-lived JWT.
 * Includes ?public=true so created streams are readable without auth.
 */
export function getWriteStream(
  coreUrl: string,
  projectId: string,
  roomId: string,
): DurableStream {
  return new DurableStream({
    url: `${coreUrl}${streamPath(projectId, roomId)}`,
    contentType: "application/json",
    headers: {
      Authorization: async () => {
        const token = await getWriteToken();
        return token ? `Bearer ${token}` : "";
      },
    },
    params: { public: "true" },
    warnOnHttp: false,
  });
}

/**
 * Subscribe to a stream directly from the core worker.
 * Streams are created as public, so no auth is needed for reads.
 */
export function subscribeToStream(
  coreUrl: string,
  projectId: string,
  roomId: string,
): DurableStream {
  return new DurableStream({
    url: `${coreUrl}${streamPath(projectId, roomId)}`,
    contentType: "application/json",
    warnOnHttp: false,
  });
}
