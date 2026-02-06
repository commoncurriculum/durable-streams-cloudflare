import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { inspectStream, getStreamMessages, sendTestAction } from "../lib/analytics";
import { formatBytes, relTime } from "../lib/formatters";
import { useSSE, type SseEvent } from "../hooks/use-sse";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoaderData = { inspect: any; messages: any };

export const Route = createFileRoute("/streams/$streamId")({
  loader: async ({ params }): Promise<LoaderData> => {
    try {
      const [inspect, messages] = await Promise.all([
        inspectStream({ data: params.streamId }),
        getStreamMessages({ data: params.streamId }),
      ]);
      return { inspect, messages };
    } catch {
      // Stream doesn't exist yet — that's fine, we'll show the create form
      return { inspect: null, messages: null };
    }
  },
  component: StreamDetailPage,
});

function StreamDetailPage() {
  const { inspect: data, messages: messagesData } = Route.useLoaderData();
  const { streamId } = Route.useParams();

  if (!data) {
    return <CreateStreamForm streamId={streamId} />;
  }

  return <StreamConsole streamId={streamId} data={data} messagesData={messagesData} />;
}

/* ─── State A: Stream not found ─── */

function CreateStreamForm({ streamId }: { streamId: string }) {
  const router = useRouter();
  const [contentType, setContentType] = useState("application/json");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const result = await sendTestAction({
        data: { streamId, action: "create", contentType, body },
      });
      if (result.status >= 200 && result.status < 300) {
        await router.invalidate();
      } else {
        setError(`${result.status} ${result.statusText}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [streamId, contentType, body, router]);

  return (
    <div className="space-y-6">
      <Link to="/streams" className="text-sm text-zinc-400 hover:text-zinc-200">
        &larr; Back to search
      </Link>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="text-lg font-semibold text-zinc-100">
          <span className="font-mono text-blue-400">{streamId}</span>
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Stream does not exist yet. Create it by sending the first message.
        </p>

        <div className="mt-5 max-w-lg space-y-4">
          <div>
            <FormLabel>Content Type</FormLabel>
            <select
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
            >
              <option value="application/json">application/json</option>
              <option value="text/plain">text/plain</option>
              <option value="application/octet-stream">application/octet-stream</option>
            </select>
          </div>

          <div>
            <FormLabel>Body</FormLabel>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder='{"hello":"world"}'
              className="min-h-[120px] w-full resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <button
            onClick={handleCreate}
            disabled={sending}
            className="rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Creating..." : "Create Stream"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── State B: Stream exists ─── */

function StreamConsole({
  streamId,
  data,
  messagesData,
}: {
  streamId: string;
  data: unknown;
  messagesData: unknown;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  const m = d.meta;
  const ops = d.ops;
  const segments = d.segments ?? [];
  const producers = d.producers ?? [];

  const messages = (messagesData as any)?.messages ?? [];
  const nextOffset = (messagesData as any)?.nextOffset ?? null;

  const sseUrl = `/api/sse/${encodeURIComponent(streamId)}?live=sse&offset=now`;
  const { status: sseStatus, events, addEvent, clearEvents } = useSSE(sseUrl);

  const metaFields: [string, string][] = [
    ["Stream ID", m.stream_id],
    ["Content Type", m.content_type],
    ["Status", m.closed ? "Closed" : "Open"],
    ["Created", relTime(m.created_at)],
    ["Tail Offset", Number(m.tail_offset).toLocaleString() + " bytes"],
    ["Read Seq", String(m.read_seq)],
    ["Segment Start", Number(m.segment_start).toLocaleString()],
    ["Segment Messages", String(m.segment_messages)],
    ["Segment Bytes", formatBytes(m.segment_bytes)],
    ["TTL", m.ttl_seconds ? m.ttl_seconds + "s" : "none"],
    ["Expires", m.expires_at ? relTime(m.expires_at) : "never"],
    ["Last Stream Seq", m.last_stream_seq != null ? String(m.last_stream_seq) : "\u2014"],
  ];

  if (m.closed) {
    metaFields.push(["Closed At", relTime(m.closed_at)]);
    if (m.closed_by_producer_id) {
      metaFields.push([
        "Closed By",
        `${m.closed_by_producer_id} (epoch ${m.closed_by_epoch}, seq ${m.closed_by_seq})`,
      ]);
    }
  }

  const segmentFill = Math.min(
    (ops.sizeBytes / (4 * 1024 * 1024)) * 100,
    100,
  );

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/streams" className="text-sm text-zinc-400 hover:text-zinc-200">
        &larr; Back to search
      </Link>

      {/* Header row */}
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="font-mono text-lg font-semibold text-blue-400">{streamId}</h2>
        <RealtimeBadge label="SSE Clients" count={d.sseClientCount} color="cyan" />
        <RealtimeBadge label="Long-Poll Waiters" count={d.longPollWaiterCount} color="blue" />
        <SseStatusBadge status={sseStatus} />
      </div>

      {/* Send Message panel */}
      <SendMessagePanel streamId={streamId} addEvent={addEvent} />

      {/* Live Event Log */}
      <EventLog events={events} sseStatus={sseStatus} clearEvents={clearEvents} />

      {/* Metadata grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {metaFields.map(([label, val]) => (
          <div
            key={label}
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {label}
            </div>
            <div className="mt-0.5 font-mono text-sm">{val}</div>
          </div>
        ))}
      </div>

      {/* Current segment stats */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-5 py-4">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Messages in Current Segment
        </div>
        <div className="mt-1 font-mono text-2xl font-bold text-blue-400">
          {ops.messageCount}
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          {formatBytes(ops.sizeBytes)}
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-blue-500 transition-all"
            style={{ width: `${segmentFill}%` }}
          />
        </div>
      </div>

      {/* Segments table */}
      {segments.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
          <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
            Segments ({segments.length})
          </h3>
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <Th>Read Seq</Th>
                <Th>Offset Range</Th>
                <Th>Size</Th>
                <Th>Messages</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {segments.map((s: any) => (
                <tr
                  key={s.read_seq}
                  className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                >
                  <Td>{s.read_seq}</Td>
                  <Td>
                    {Number(s.start_offset).toLocaleString()} &ndash;{" "}
                    {Number(s.end_offset).toLocaleString()}
                  </Td>
                  <Td>{formatBytes(s.size_bytes)}</Td>
                  <Td>{s.message_count}</Td>
                  <Td>{relTime(s.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Producers table */}
      {producers.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
          <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
            Producers ({producers.length})
          </h3>
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <Th>ID</Th>
                <Th>Epoch</Th>
                <Th>Last Seq</Th>
                <Th>Last Offset</Th>
                <Th>Last Active</Th>
              </tr>
            </thead>
            <tbody>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {producers.map((p: any) => (
                <tr
                  key={p.producer_id}
                  className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                >
                  <Td>{p.producer_id}</Td>
                  <Td>{p.epoch}</Td>
                  <Td>{p.last_seq}</Td>
                  <Td>{Number(p.last_offset).toLocaleString()}</Td>
                  <Td>{p.last_updated ? relTime(p.last_updated) : "\u2014"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Messages */}
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="text-sm font-medium text-zinc-400">
            Messages ({messages.length})
          </h3>
          {nextOffset && (
            <span className="font-mono text-xs text-zinc-600">
              next: {nextOffset}
            </span>
          )}
        </div>
        {messages.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-zinc-500">
            No messages in this stream
          </div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {messages.map((msg: unknown, i: number) => (
              <div key={i} className="px-4 py-3">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-zinc-300">
                  {typeof msg === "string" ? msg : JSON.stringify(msg, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Send Message Panel ─── */

function SendMessagePanel({
  streamId,
  addEvent,
}: {
  streamId: string;
  addEvent: (type: SseEvent["type"], content: string) => void;
}) {
  const [contentType, setContentType] = useState("application/json");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<{ status: number; statusText: string } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const handleSend = useCallback(async () => {
    setSending(true);
    setLastResult(null);
    try {
      const result = await sendTestAction({
        data: { streamId, action: "append", contentType, body },
      });
      setLastResult(result);
      addEvent("control", `APPEND => ${result.status} ${result.statusText}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addEvent("error", msg);
      setLastResult({ status: 0, statusText: msg });
    } finally {
      setSending(false);
    }
  }, [streamId, contentType, body, addEvent]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-zinc-400 hover:text-zinc-200"
      >
        <span>Send Message</span>
        <span className="text-xs">{collapsed ? "\u25B6" : "\u25BC"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-zinc-800 px-4 py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <FormLabel>Content Type</FormLabel>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value)}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
              >
                <option value="application/json">application/json</option>
                <option value="text/plain">text/plain</option>
                <option value="application/octet-stream">application/octet-stream</option>
              </select>
            </div>

            <div className="flex-1">
              <FormLabel>Body</FormLabel>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder='{"hello":"world"}'
                rows={2}
                className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSend}
                disabled={sending}
                className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? "Sending..." : "Send"}
              </button>
              {lastResult && (
                <span
                  className={`inline-block rounded px-2 py-1 font-mono text-xs font-semibold ${
                    lastResult.status >= 200 && lastResult.status < 300
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-red-500/15 text-red-400"
                  }`}
                >
                  {lastResult.status} {lastResult.statusText}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Live Event Log ─── */

function EventLog({
  events,
  sseStatus,
  clearEvents,
}: {
  events: SseEvent[];
  sseStatus: string;
  clearEvents: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
        >
          <span className="text-xs">{collapsed ? "\u25B6" : "\u25BC"}</span>
          Live Event Log
        </button>
        <div className="flex items-center gap-3">
          {events.length > 0 && (
            <button
              onClick={clearEvents}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Clear
            </button>
          )}
          <SseStatusBadge status={sseStatus} />
        </div>
      </div>
      {!collapsed && (
        <div className="max-h-64 min-h-0 space-y-1 overflow-y-auto border-t border-zinc-800 p-2">
          {events.length === 0 ? (
            <div className="py-6 text-center text-sm text-zinc-500">
              Waiting for events...
            </div>
          ) : (
            events.map((evt, i) => <LogEntry key={i} event={evt} />)
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Shared sub-components ─── */

function FormLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
      {children}
    </label>
  );
}

function RealtimeBadge({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: "cyan" | "blue";
}) {
  const colors = {
    cyan: { dot: "bg-cyan-400", text: "text-cyan-400" },
    blue: { dot: "bg-blue-400", text: "text-blue-400" },
  };
  const c = colors[color];

  return (
    <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-5 py-3">
      <span className={`inline-block h-2 w-2 animate-pulse rounded-full ${c.dot}`} />
      <div>
        <div className={`font-mono text-xl font-bold ${c.text}`}>{count}</div>
        <div className="text-xs text-zinc-500">{label}</div>
      </div>
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
      SSE: {status}
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-4 py-2 font-mono text-sm text-zinc-400">{children}</td>
  );
}
