import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import { Header } from "@/components/header";
import { Toolbar } from "@/components/toolbar";
import { Canvas } from "@/components/canvas";
import { useDrawing } from "@/hooks/use-drawing";
import {
  getWriteStream,
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
  const { coreUrl, projectId, writeToken } = Route.useLoaderData();
  const [userId] = useState(() => crypto.randomUUID().slice(0, 8));
  const renderRemoteRef = useRef<((msg: DrawMessage) => void) | null>(null);

  const handleStrokeEnd = useCallback(
    async (msg: StrokeMessage) => {
      const ds = getWriteStream(coreUrl, projectId, roomId, writeToken);
      await ds.append(JSON.stringify(msg));
    },
    [coreUrl, projectId, roomId, writeToken],
  );

  const handleClear = useCallback(async () => {
    const msg: DrawMessage = { type: "clear", userId };
    const ds = getWriteStream(coreUrl, projectId, roomId, writeToken);
    await ds.append(JSON.stringify(msg));
  }, [userId, coreUrl, projectId, roomId, writeToken]);

  const drawing = useDrawing(userId, handleStrokeEnd, handleClear);

  renderRemoteRef.current = drawing.renderRemoteMessage;

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;

    async function init() {
      // Subscribe to the stream directly from core (reads are public)
      const ds = subscribeToStream(coreUrl, projectId, roomId);
      console.log("ds", ds);

      // Try to read — if the stream doesn't exist yet, retry after a delay
      let res;
      try {
        res = await ds.stream({ offset: "-1", live: "sse", json: true });
      } catch {
        // Stream doesn't exist yet — someone else might create it, or we will on first stroke
        // Retry in a bit
        await new Promise((r) => setTimeout(r, 1000));
        if (cancelled) return;
        try {
          res = await ds.stream({ offset: "-1", live: "sse", json: true });
        } catch {
          // Still not there — wait for creation
          return;
        }
      }
      if (cancelled) {
        res.cancel();
        return;
      }

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
