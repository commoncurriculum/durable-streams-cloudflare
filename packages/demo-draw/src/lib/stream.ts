import { DurableStream } from "@durable-streams/client";

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
 * The write token is minted once when the room config is fetched —
 * every write reuses the same static Authorization header.
 * Includes ?public=true so created streams are readable without auth.
 */
export function getWriteStream(
  coreUrl: string,
  projectId: string,
  roomId: string,
  writeToken: string,
): DurableStream {
  return new DurableStream({
    url: `${coreUrl}${streamPath(projectId, roomId)}`,
    contentType: "application/json",
    headers: writeToken
      ? { Authorization: `Bearer ${writeToken}` }
      : undefined,
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
