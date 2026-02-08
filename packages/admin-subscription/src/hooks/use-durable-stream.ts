import { useEffect, useRef, useState, useCallback } from "react";
import { stream } from "@durable-streams/client";

export type StreamEvent = {
  type: "data" | "control" | "error";
  content: string;
  timestamp: Date;
};

export type StreamStatus = "disconnected" | "connecting" | "connected";

export function useDurableStream(options: {
  coreUrl: string | undefined;
  projectId: string;
  streamKey: string;
  token: string | undefined;
  enabled: boolean;
}) {
  const { coreUrl, projectId, streamKey, token, enabled } = options;

  const [status, setStatus] = useState<StreamStatus>("disconnected");
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const cancelRef = useRef<(() => void) | null>(null);

  const addEvent = useCallback(
    (type: StreamEvent["type"], content: string) => {
      setEvents((prev) => [...prev, { type, content, timestamp: new Date() }]);
    },
    [],
  );

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  useEffect(() => {
    if (!coreUrl || !token || !enabled) {
      if (cancelRef.current) {
        cancelRef.current();
        cancelRef.current = null;
      }
      setStatus("disconnected");
      return;
    }

    let cancelled = false;
    setStatus("connecting");

    const url = `${coreUrl}/v1/${encodeURIComponent(projectId)}/stream/${encodeURIComponent(streamKey)}`;

    stream({
      url,
      live: "sse",
      offset: "-1",
      headers: {
        Authorization: () => `Bearer ${tokenRef.current}`,
      },
    })
      .then((response) => {
        if (cancelled) {
          response.cancel();
          return;
        }

        cancelRef.current = () => response.cancel();
        setStatus("connected");

        response.subscribeBytes((chunk) => {
          // Skip empty chunks (e.g. initial SSE connection handshake)
          if (chunk.data.byteLength === 0) return;

          let display: string;
          try {
            display = new TextDecoder().decode(chunk.data);
            // Try to pretty-print JSON
            const parsed = JSON.parse(display);
            display = JSON.stringify(parsed, null, 2);
          } catch {
            // not JSON or decode failed, use raw text
            if (!display!) {
              display = `[${chunk.data.byteLength} bytes]`;
            }
          }
          setEvents((prev) => [
            ...prev,
            { type: "data", content: display, timestamp: new Date() },
          ]);

          if (chunk.streamClosed) {
            setEvents((prev) => [
              ...prev,
              {
                type: "control",
                content: "Stream closed",
                timestamp: new Date(),
              },
            ]);
          }
        });

        response.closed.then(() => {
          if (!cancelled) {
            setStatus("disconnected");
          }
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus("disconnected");
          setEvents((prev) => [
            ...prev,
            {
              type: "error",
              content: err instanceof Error ? err.message : String(err),
              timestamp: new Date(),
            },
          ]);
        }
      });

    return () => {
      cancelled = true;
      if (cancelRef.current) {
        cancelRef.current();
        cancelRef.current = null;
      }
    };
  }, [coreUrl, projectId, streamKey, enabled]); // token intentionally excluded — tokenRef handles refresh

  return { status, events, clearEvents, addEvent };
}
