import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { sendTestAction } from "../lib/analytics";
import { useSSE, type SseEvent } from "../hooks/use-sse";

export const Route = createFileRoute("/test")({
  component: TestPage,
});

function TestPage() {
  const [streamId, setStreamId] = useState("");
  const [action, setAction] = useState<"create" | "append">("create");
  const [contentType, setContentType] = useState("application/json");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sseUrl, setSseUrl] = useState<string | null>(null);
  const { status, events, addEvent, clearEvents } = useSSE(sseUrl);

  const handleSend = useCallback(async () => {
    const id = streamId.trim();
    if (!id) return;

    setSending(true);
    try {
      const result = await sendTestAction({
        data: { streamId: id, action, contentType, body },
      });
      addEvent(
        "control",
        `${action.toUpperCase()} => ${result.status} ${result.statusText}`,
      );

      // Connect SSE after first action
      if (!sseUrl) {
        setSseUrl(
          `/api/sse/${encodeURIComponent(id)}?live=sse&offset=now`,
        );
      }
    } catch (e) {
      addEvent("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [streamId, action, contentType, body, sseUrl, addEvent]);

  return (
    <div className="grid min-h-[500px] grid-cols-1 gap-6 lg:grid-cols-[2fr_3fr]">
      {/* Form */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <FormLabel first>Stream ID</FormLabel>
        <input
          type="text"
          value={streamId}
          onChange={(e) => setStreamId(e.target.value)}
          placeholder="my-stream"
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
        />

        <FormLabel>Action</FormLabel>
        <div className="flex overflow-hidden rounded-md border border-zinc-700">
          {(["create", "append"] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAction(a)}
              className={`flex-1 px-3 py-2 text-sm capitalize ${
                action === a
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {a}
            </button>
          ))}
        </div>

        <FormLabel>Content Type</FormLabel>
        <select
          value={contentType}
          onChange={(e) => setContentType(e.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
        >
          <option value="application/json">application/json</option>
          <option value="text/plain">text/plain</option>
          <option value="application/octet-stream">
            application/octet-stream
          </option>
        </select>

        <FormLabel>Body</FormLabel>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='{"hello":"world"}'
          className="min-h-[120px] w-full resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
        />

        <button
          onClick={handleSend}
          disabled={sending || !streamId.trim()}
          className={`mt-5 w-full rounded-md px-4 py-2.5 text-sm font-medium transition-colors ${
            action === "create"
              ? "bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-emerald-800"
              : "bg-blue-600 text-white hover:bg-blue-500 disabled:bg-blue-800"
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>

      {/* Event log */}
      <div className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="text-sm font-medium text-zinc-400">Live Event Log</h3>
          <div className="flex items-center gap-3">
            {events.length > 0 && (
              <button
                onClick={clearEvents}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Clear
              </button>
            )}
            <StatusBadge status={status} />
          </div>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2" style={{ maxHeight: 500 }}>
          {events.length === 0 ? (
            <div className="py-12 text-center text-sm text-zinc-500">
              Enter a stream ID and click Send to start streaming
            </div>
          ) : (
            events.map((evt, i) => <LogEntry key={i} event={evt} />)
          )}
        </div>
      </div>
    </div>
  );
}

function FormLabel({
  children,
  first,
}: {
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <label
      className={`block text-xs font-medium uppercase tracking-wide text-zinc-500 ${first ? "" : "mt-4"} mb-1`}
    >
      {children}
    </label>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    connected: "text-emerald-400",
    connecting: "text-amber-400",
    disconnected: "text-zinc-500",
  };
  return (
    <span className={`font-mono text-xs ${colors[status] ?? "text-zinc-500"}`}>
      {status}
    </span>
  );
}

function LogEntry({ event }: { event: SseEvent }) {
  const time = event.timestamp.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const badgeColors: Record<string, string> = {
    data: "bg-blue-500/15 text-blue-400",
    control: "bg-purple-500/15 text-purple-400",
    error: "bg-red-500/15 text-red-400",
  };

  const isLong = event.content.includes("\n") || event.content.length > 80;

  return (
    <div className="rounded bg-zinc-800 px-3 py-2 font-mono text-xs">
      <span className="text-zinc-500">{time}</span>{" "}
      <span
        className={`ml-1 inline-block rounded px-1.5 py-0.5 text-[0.65rem] font-semibold ${badgeColors[event.type] ?? ""}`}
      >
        {event.type}
      </span>
      {isLong ? (
        <pre className="mt-1 whitespace-pre-wrap break-all text-zinc-400">
          {event.content}
        </pre>
      ) : (
        <span className="ml-2 text-zinc-400">{event.content}</span>
      )}
    </div>
  );
}
