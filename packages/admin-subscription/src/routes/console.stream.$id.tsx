import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useStreamSubscribers } from "../lib/queries";
import { sendTestAction } from "../lib/analytics";

type LogEvent = {
  type: "control" | "error";
  content: string;
  timestamp: Date;
};

export const Route = createFileRoute("/console/stream/$id")({
  component: StreamConsolePage,
});

function StreamConsolePage() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useStreamSubscribers(id);

  const [contentType, setContentType] = useState("application/json");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [events, setEvents] = useState<LogEvent[]>([]);

  const addEvent = useCallback((type: LogEvent["type"], content: string) => {
    setEvents((prev) => [...prev, { type, content, timestamp: new Date() }]);
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const handlePublish = useCallback(async () => {
    setSending(true);
    try {
      const result = await sendTestAction({
        data: {
          action: "publish",
          streamId: id,
          contentType,
          body,
        },
      });
      addEvent(
        "control",
        `PUBLISH => ${result.status} ${result.statusText}`,
      );
    } catch (e) {
      addEvent("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [id, contentType, body, addEvent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handlePublish();
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-4 animate-pulse rounded bg-zinc-800" />
        ))}
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

  return (
    <div className="grid min-h-[500px] grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Left column — stream info */}
      <div className="space-y-6">
        <Link
          to="/console"
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          &larr; Back to search
        </Link>

        {!data || data.length === 0 ? (
          <div className="py-12 text-center text-zinc-500">
            No active subscribers for this stream
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
              Subscribers ({data.length})
            </h3>
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Session ID
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Net Subscriptions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                  >
                    <td className="px-4 py-2 font-mono text-sm text-zinc-400">
                      {row.session_id as string}
                    </td>
                    <td className="px-4 py-2 font-mono text-sm text-zinc-400">
                      {row.net as number}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Right column — publish + event log */}
      <div className="flex flex-col gap-6">
        {/* Publish panel */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1">
            Content Type
          </label>
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

          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500 mt-4 mb-1">
            Body
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='{"hello":"world"}'
            className="min-h-[120px] w-full resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
          />

          <button
            onClick={handlePublish}
            disabled={sending}
            className="mt-5 w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending..." : "Publish"}
          </button>
        </div>

        {/* Event log */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <h3 className="text-sm font-medium text-zinc-400">Event Log</h3>
            {events.length > 0 && (
              <button
                onClick={clearEvents}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Clear
              </button>
            )}
          </div>
          <div
            className="flex-1 space-y-1 overflow-y-auto p-2"
            style={{ maxHeight: 500 }}
          >
            {events.length === 0 ? (
              <div className="py-12 text-center text-sm text-zinc-500">
                Publish a message to see results
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

function LogEntry({ event }: { event: LogEvent }) {
  const time = event.timestamp.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const badgeColors: Record<string, string> = {
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
