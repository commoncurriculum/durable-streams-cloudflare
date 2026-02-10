import { useEffect, useRef, useState, useCallback } from "react";

export type SseEvent = {
  type: "data" | "control" | "error";
  content: string;
  timestamp: Date;
};

export type SseStatus = "disconnected" | "connecting" | "connected";

export function useSSE(url: string | null) {
  const [status, setStatus] = useState<SseStatus>("disconnected");
  const [events, setEvents] = useState<SseEvent[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  const addEvent = useCallback(
    (type: SseEvent["type"], content: string) => {
      setEvents((prev) => [...prev, { type, content, timestamp: new Date() }]);
    },
    [],
  );

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  useEffect(() => {
    if (!url) {
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      setStatus("disconnected");
      return;
    }

    const source = new EventSource(url);
    sourceRef.current = source;
    setStatus("connecting");

    source.addEventListener("open", () => {
      setStatus("connected");
    });

    source.addEventListener("data", (e: MessageEvent) => {
      let display = e.data;
      try {
        const parsed = JSON.parse(e.data);
        display = JSON.stringify(parsed, null, 2);
      } catch {
        // not JSON, use raw
      }
      addEvent("data", display);
    });

    source.addEventListener("control", (e: MessageEvent) => {
      addEvent("control", e.data);
    });

    source.addEventListener("error", () => {
      setStatus("disconnected");
    });

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [url, addEvent]);

  return { status, events, clearEvents, addEvent };
}
