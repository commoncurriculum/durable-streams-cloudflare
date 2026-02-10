import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import { Header } from "@/components/header";
import { Toolbar } from "@/components/toolbar";
import { Canvas } from "@/components/canvas";
import { useDrawing } from "@/hooks/use-drawing";
import {
  createStream,
  appendToStream,
  subscribeToStream,
  type DrawMessage,
  type StrokeMessage,
} from "@/lib/stream";
import { getRoomConfig } from "@/lib/config";

export const Route = createFileRoute("/room/$roomId")({
  loader: () => getRoomConfig(),
  component: DrawingRoom,
});

function DrawingRoom() {
  const { roomId } = Route.useParams();
  const { coreUrl, projectId } = Route.useLoaderData();
  const [userId] = useState(() => crypto.randomUUID().slice(0, 8));
  const streamCreatedRef = useRef(false);
  const renderRemoteRef = useRef<((msg: DrawMessage) => void) | null>(null);

  const handleStrokeEnd = useCallback(
    (msg: StrokeMessage) => {
      if (!streamCreatedRef.current) {
        // First stroke creates the stream via proxy
        streamCreatedRef.current = true;
        createStream(projectId, roomId, msg);
      } else {
        appendToStream(projectId, roomId, msg);
      }
    },
    [projectId, roomId],
  );

  const handleClear = useCallback(() => {
    const msg: DrawMessage = { type: "clear", userId };
    if (streamCreatedRef.current) {
      appendToStream(projectId, roomId, msg);
    }
  }, [projectId, roomId, userId]);

  const drawing = useDrawing(userId, handleStrokeEnd, handleClear);

  renderRemoteRef.current = drawing.renderRemoteMessage;

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    async function init() {
      // Subscribe to the stream directly from core (reads are public)
      const ds = subscribeToStream(coreUrl, projectId, roomId);

      // Try to read — if the stream doesn't exist yet, retry after a delay
      let res;
      try {
        res = await ds.stream({ offset: "-1", live: "sse" });
      } catch {
        // Stream doesn't exist yet — someone else might create it, or we will on first stroke
        // Retry in a bit
        await new Promise((r) => setTimeout(r, 1000));
        if (cancelled) return;
        try {
          res = await ds.stream({ offset: "-1", live: "sse" });
        } catch {
          // Still not there — wait for creation
          return;
        }
      }
      if (cancelled) {
        res.cancel();
        return;
      }

      // Mark stream as existing so writes use append (POST) not create (PUT)
      streamCreatedRef.current = true;

      unsub = res.subscribeJson<DrawMessage>((batch) => {
        for (const msg of batch.items) {
          if (msg.userId === userId) continue;
          renderRemoteRef.current?.(msg);
        }
      });
    }

    init();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [coreUrl, projectId, roomId, userId]);

  return (
    <div className="flex h-screen flex-col">
      <Header roomId={roomId} />
      <Toolbar drawing={drawing} />
      <Canvas drawing={drawing} />
    </div>
  );
}
