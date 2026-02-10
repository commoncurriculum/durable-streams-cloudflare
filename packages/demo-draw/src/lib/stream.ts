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
 * Create a stream via the demo-draw proxy (same-origin, JWT added server-side).
 */
export async function createStream(
  projectId: string,
  roomId: string,
  initialMessage: DrawMessage,
): Promise<Response> {
  return fetch(streamPath(projectId, roomId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(initialMessage),
  });
}

/**
 * Append a message via the demo-draw proxy (same-origin, JWT added server-side).
 */
export async function appendToStream(
  projectId: string,
  roomId: string,
  message: DrawMessage,
): Promise<Response> {
  return fetch(streamPath(projectId, roomId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

/**
 * Subscribe to a stream directly from the core worker (cross-origin).
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
