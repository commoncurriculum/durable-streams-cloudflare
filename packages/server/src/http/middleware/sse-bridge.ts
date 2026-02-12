import { HEADER_SSE_DATA_ENCODING } from "../shared/headers";
import { Timing, attachTiming } from "../shared/timing";
import { logWarn } from "../../log";
import { applyCorsHeaders } from "./cors";
import type { StreamDO } from "../v1/streams";
import { buildSseDataEvent } from "../v1/streams/realtime/handlers";
import type { WsDataMessage, WsControlMessage } from "../v1/streams/realtime/handlers";

const sseTextEncoder = new TextEncoder();

export async function bridgeSseViaWebSocket(
  stub: DurableObjectStub<StreamDO>,
  doKey: string,
  url: URL,
  _request: Request,
  corsOrigin: string | null,
  timing: Timing | null,
): Promise<Response> {
  // Build the internal WS upgrade request to the DO.
  // Must use stub.fetch() (not RPC) because WebSocket upgrade responses
  // can't be serialized over RPC.
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("live", "ws-internal");
  const wsReq = new Request(wsUrl.toString(), {
    headers: new Headers({
      Upgrade: "websocket",
    }),
  });

  const doneOrigin = timing?.start("edge.origin");
  const wsResp = await stub.fetch(wsReq);
  doneOrigin?.();

  if (wsResp.status !== 101 || !wsResp.webSocket) {
    // DO returned an error (400, 404, etc.) — forward as-is with CORS
    const headers = new Headers(wsResp.headers);
    applyCorsHeaders(headers, corsOrigin);
    return new Response(wsResp.body, {
      status: wsResp.status,
      statusText: wsResp.statusText,
      headers,
    });
  }

  const ws = wsResp.webSocket;
  ws.accept();

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Encoding is set by the DO in the 101 response headers
  const useBase64 = wsResp.headers.get("Stream-SSE-Data-Encoding") === "base64";

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string) as WsDataMessage | WsControlMessage;

      if (msg.type === "data") {
        const dataMsg = msg as WsDataMessage;

        if (dataMsg.encoding === "base64") {
          // Decode base64 back to binary, then build SSE event
          const binary = Uint8Array.from(atob(dataMsg.payload), (c) => c.charCodeAt(0));
          const sseEvent = buildSseDataEvent(binary.buffer as ArrayBuffer, true);
          // Fire-and-forget: SSE write to closed/errored stream is non-fatal
          writer.write(sseTextEncoder.encode(sseEvent)).catch(() => {});
        } else {
          // Text payload — build SSE event from the raw text
          const encoded = sseTextEncoder.encode(dataMsg.payload);
          const sseEvent = buildSseDataEvent(encoded.buffer as ArrayBuffer, false);
          // Fire-and-forget: SSE write to closed/errored stream is non-fatal
          writer.write(sseTextEncoder.encode(sseEvent)).catch(() => {});
        }
      } else if (msg.type === "control") {
        const controlMsg = msg as WsControlMessage;
        // Build SSE control event directly from the WS message — do NOT
        // use buildSseControlEvent() which would double-process the cursor
        // through generateResponseCursor() (the DO already computed it).
        const control: Record<string, unknown> = {
          streamNextOffset: controlMsg.streamNextOffset,
        };
        if (controlMsg.streamWriteTimestamp && controlMsg.streamWriteTimestamp > 0) {
          control.streamWriteTimestamp = controlMsg.streamWriteTimestamp;
        }
        if (controlMsg.streamClosed) {
          control.streamClosed = true;
        }
        if (controlMsg.streamCursor) {
          control.streamCursor = controlMsg.streamCursor;
        }
        if (controlMsg.upToDate) {
          control.upToDate = true;
        }
        const ssePayload = `event: control\ndata:${JSON.stringify(control)}\n\n`;
        // Fire-and-forget: SSE write to closed/errored stream is non-fatal
        writer.write(sseTextEncoder.encode(ssePayload)).catch(() => {});
      }
    } catch (e) {
      logWarn({ doKey, component: "ws-bridge" }, "malformed WS message", e);
    }
  });

  ws.addEventListener("close", () => {
    // Fire-and-forget: writer may already be closed
    writer.close().catch(() => {});
  });

  ws.addEventListener("error", () => {
    // Fire-and-forget: writer may already be closed
    writer.close().catch(() => {});
  });

  // Build SSE response headers
  const sseHeaders = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  applyCorsHeaders(sseHeaders, corsOrigin);

  if (useBase64) sseHeaders.set(HEADER_SSE_DATA_ENCODING, "base64");

  return attachTiming(new Response(readable, { status: 200, headers: sseHeaders }), timing);
}
