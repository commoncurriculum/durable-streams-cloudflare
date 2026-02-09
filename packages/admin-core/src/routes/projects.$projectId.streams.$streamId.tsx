import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { inspectStream, getStreamMessages, sendTestAction } from "../lib/analytics";
import { formatBytes, relTime } from "../lib/formatters";
import { useSSE, type SseEvent } from "../hooks/use-sse";

export const Route = createFileRoute(
  "/projects/$projectId/streams/$streamId",
)({
  loader: async ({ params }) => {
    const doKey = `${params.projectId}/${params.streamId}`;
    try {
      const inspect = await inspectStream({ data: doKey });
      return { inspect };
    } catch {
      return { inspect: null };
    }
  },
  component: StreamDetailPage,
});

function StreamDetailPage() {
  const { inspect: data } = Route.useLoaderData();
  const { projectId, streamId } = Route.useParams();
  const doKey = `${projectId}/${streamId}`;

  if (!data) {
    return <CreateStreamForm projectId={projectId} streamId={streamId} doKey={doKey} />;
  }

  return <StreamConsole projectId={projectId} streamId={streamId} doKey={doKey} data={data} />;
}

/* ─── State A: Stream not found ─── */

function CreateStreamForm({
  projectId,
  streamId,
  doKey,
}: {
  projectId: string;
  streamId: string;
  doKey: string;
}) {
  const router = useRouter();
  const contentType = "application/json";
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setSending(true);
    setError(null);
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await sendTestAction({
          data: { streamId: doKey, action: "create", contentType, body },
        });
        if (result.status >= 200 && result.status < 300) {
          await router.invalidate();
          setSending(false);
          return;
        }
        setError(`${result.status} ${result.statusText}`);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_RETRIES && msg.includes("restarted")) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        setError(msg);
      }
    }
    setSending(false);
  }, [doKey, contentType, body, router]);

  return (
    <div className="space-y-6">
      <Link
        to="/projects/$projectId/streams"
        params={{ projectId }}
        className="text-sm text-zinc-400 hover:text-zinc-200"
      >
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
            <div className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100">
              {contentType}
            </div>
          </div>

          <div>
            <FormLabel>Body</FormLabel>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleCreate();
                }
              }}
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
  projectId,
  streamId,
  doKey,
  data,
}: {
  projectId: string;
  streamId: string;
  doKey: string;
  data: unknown;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  const m = d.meta;
  const ops = d.ops;
  const segments = d.segments ?? [];
  const producers = d.producers ?? [];

  const sseUrl = `/api/sse/${encodeURIComponent(projectId)}/${encodeURIComponent(streamId)}?live=sse&offset=now`;
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
      <Link
        to="/projects/$projectId/streams"
        params={{ projectId }}
        className="text-sm text-zinc-400 hover:text-zinc-200"
      >
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
      <SendMessagePanel doKey={doKey} contentType={m.content_type} addEvent={addEvent} />

      {/* Two-column layout: info left, event log right */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr]">
        {/* Left column: metadata + stats + tables */}
        <div className="space-y-6">
          {/* Metadata grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        </div>

        {/* Right column: live event log */}
        <EventLog doKey={doKey} events={events} sseStatus={sseStatus} clearEvents={clearEvents} addEvent={addEvent} />
      </div>
    </div>
  );
}

/* ─── Send Message Panel ─── */

function SendMessagePanel({
  doKey,
  contentType,
  addEvent,
}: {
  doKey: string;
  contentType: string;
  addEvent: (type: SseEvent["type"], content: string) => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<{ status: number; statusText: string } | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const handleSend = useCallback(async () => {
    setSending(true);
    setLastResult(null);
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await sendTestAction({
          data: { streamId: doKey, action: "append", contentType, body },
        });
        setLastResult(result);
        addEvent("control", `APPEND => ${result.status} ${result.statusText}`);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_RETRIES && msg.includes("restarted")) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        addEvent("error", msg);
        setLastResult({ status: 0, statusText: msg });
      }
    }
    setSending(false);
  }, [doKey, contentType, body, addEvent]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-zinc-400 hover:text-zinc-200"
      >
        <span>Send Message</span>
        <span className="ml-2 font-mono text-xs text-zinc-600">{contentType}</span>
        <span className="ml-auto text-xs">{collapsed ? "\u25B6" : "\u25BC"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-zinc-800 px-4 py-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
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
  doKey,
  events,
  sseStatus,
  clearEvents,
  addEvent,
}: {
  doKey: string;
  events: SseEvent[];
  sseStatus: string;
  clearEvents: () => void;
  addEvent: (type: SseEvent["type"], content: string) => void;
}) {
  const [fetching, setFetching] = useState(false);

  const fetchEarlier = useCallback(async () => {
    setFetching(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (await getStreamMessages({ data: doKey })) as any;
      const msgs: unknown[] = result?.messages ?? [];
      if (msgs.length === 0) {
        addEvent("control", "No earlier messages found");
      } else {
        for (const msg of msgs) {
          const display = typeof msg === "string" ? msg : JSON.stringify(msg, null, 2);
          addEvent("data", display);
        }
        addEvent("control", `Loaded ${msgs.length} earlier message(s)`);
      }
    } catch (e) {
      addEvent("error", e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [doKey, addEvent]);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 lg:sticky lg:top-6 lg:max-h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium text-zinc-400">Live Event Log</span>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchEarlier}
            disabled={fetching}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
          >
            {fetching ? "Loading..." : "Fetch Earlier Messages"}
          </button>
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
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-zinc-800 p-2">
        {events.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-500">
            Waiting for events...
          </div>
        ) : (
          events.map((evt, i) => <LogEntry key={i} event={evt} />)
        )}
      </div>
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
