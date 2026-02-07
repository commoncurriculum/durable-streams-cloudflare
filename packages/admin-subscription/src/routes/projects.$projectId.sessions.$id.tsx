import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useSessionInspect, useCoreUrl, useStreamToken } from "../lib/queries";
import { sendSessionAction } from "../lib/analytics";
import {
  useDurableStream,
  type StreamEvent,
} from "../hooks/use-durable-stream";

type SessionAction = "subscribe" | "unsubscribe" | "touch" | "delete";

const SESSION_ACTIONS: { value: SessionAction; label: string }[] = [
  { value: "subscribe", label: "Subscribe" },
  { value: "unsubscribe", label: "Unsub" },
  { value: "touch", label: "Touch" },
  { value: "delete", label: "Delete" },
];

export const Route = createFileRoute("/projects/$projectId/sessions/$id")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { projectId, id } = Route.useParams();
  const { data, isLoading, error } = useSessionInspect(id, projectId);

  const [action, setAction] = useState<SessionAction>("subscribe");
  const [streamIdInput, setStreamIdInput] = useState("");
  const [sending, setSending] = useState(false);

  const { data: coreUrl } = useCoreUrl();
  const { data: tokenData } = useStreamToken(projectId);

  const { status, events, addEvent, clearEvents } = useDurableStream({
    coreUrl,
    projectId,
    streamKey: id,
    token: tokenData?.token,
    enabled: !!data && !!tokenData?.token,
  });

  const handleSend = useCallback(async () => {
    setSending(true);
    try {
      let payload: Parameters<typeof sendSessionAction>[0]["data"];

      switch (action) {
        case "subscribe":
        case "unsubscribe":
          if (!streamIdInput.trim()) return;
          payload = {
            action,
            projectId,
            sessionId: id,
            streamId: streamIdInput.trim(),
          };
          break;
        case "touch":
          payload = { action, projectId, sessionId: id };
          break;
        case "delete":
          payload = { action, projectId, sessionId: id };
          break;
      }

      const result = await sendSessionAction({ data: payload });
      const body = result.body as Record<string, unknown> | undefined;
      let message: string;
      switch (action) {
        case "subscribe":
          message = `Subscribed to ${(body?.streamId as string) ?? streamIdInput}`;
          break;
        case "unsubscribe":
          message = `Unsubscribed from ${streamIdInput}`;
          break;
        case "touch":
          message = "Session touched";
          break;
        case "delete":
          message = "Session deleted";
          break;
      }
      addEvent("control", message);
    } catch (e) {
      addEvent("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [action, projectId, id, streamIdInput, addEvent]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-lg bg-zinc-800" />
        <div className="h-16 animate-pulse rounded-lg bg-zinc-800" />
        <div className="h-32 animate-pulse rounded-lg bg-zinc-800" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center text-red-400">
        {error.message}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-12 text-center text-zinc-500">
        Session not found
      </div>
    );
  }

  const d = data as Record<string, unknown>;
  const sessionId = (d.sessionId || d.session_id || "\u2014") as string;
  const sessionStreamPath = (d.sessionStreamPath || d.session_stream_path || "\u2014") as string;
  const subscriptions: { streamId?: string; stream_id?: string }[] =
    (d.subscriptions as { streamId?: string; stream_id?: string }[]) ?? [];

  return (
    <div className="grid min-h-[500px] grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Left column — session info */}
      <div className="space-y-6">
        <Link
          to="/projects/$projectId/sessions"
          params={{ projectId }}
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          &larr; Back to search
        </Link>

        {/* Metadata */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MetaItem label="Session ID" value={sessionId} />
          <MetaItem label="Session Stream" value={sessionStreamPath} />
        </div>

        {/* Subscriptions */}
        {subscriptions.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
              Subscriptions ({subscriptions.length})
            </h3>
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Stream ID
                  </th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((s, i) => {
                  const sid =
                    typeof s === "string"
                      ? s
                      : s.streamId || s.stream_id || "\u2014";
                  return (
                    <tr
                      key={i}
                      className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                    >
                      <td className="px-4 py-2 font-mono text-sm text-zinc-400">
                        {sid}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center text-zinc-500">
            No active subscriptions
          </div>
        )}
      </div>

      {/* Right column — actions + event log */}
      <div className="flex flex-col gap-6">
        {/* Actions panel */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1">
            Action
          </label>
          <div className="flex overflow-hidden rounded-md border border-zinc-700">
            {SESSION_ACTIONS.map((a) => (
              <button
                key={a.value}
                onClick={() => setAction(a.value)}
                className={`flex-1 px-2 py-2 text-xs ${
                  action === a.value
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          {(action === "subscribe" || action === "unsubscribe") && (
            <>
              <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500 mt-4 mb-1">
                Stream ID
              </label>
              <input
                type="text"
                value={streamIdInput}
                onChange={(e) => setStreamIdInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
                placeholder="my-stream"
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
              />
            </>
          )}

          <button
            onClick={handleSend}
            disabled={sending}
            className="mt-5 w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>

        {/* Event log */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
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
              <SseStatusBadge status={status} />
            </div>
          </div>
          <div
            className="flex-1 space-y-1 overflow-y-auto p-2"
            style={{ maxHeight: 500 }}
          >
            {events.length === 0 ? (
              <div className="py-12 text-center text-sm text-zinc-500">
                Subscribe to a stream and publish to see live events
              </div>
            ) : (
              events.map((evt, i) => <LogEntry key={i} event={evt} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}

function SseStatusBadge({ status }: { status: string }) {
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

function LogEntry({ event }: { event: StreamEvent }) {
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
