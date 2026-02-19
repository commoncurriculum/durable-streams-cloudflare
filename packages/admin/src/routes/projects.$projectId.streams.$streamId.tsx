import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { inspectStream, sendTestAction } from "../lib/analytics";
import { relTime } from "../lib/formatters";
import { useDurableStream, type StreamEvent } from "../hooks/use-durable-stream";
import { stream as readStreamClient } from "@durable-streams/client";
import { streamUrl } from "../lib/stream-url";
import { useCoreUrl, useStreamToken, useStreamTimeseries } from "../lib/queries";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

export const Route = createFileRoute("/projects/$projectId/streams/$streamId")({
  loader: async ({ params }) => {
    const doKey = `${params.projectId}/${params.streamId}`;
    try {
      const inspect = await inspectStream({ data: doKey });
      return { inspect };
    } catch {
      return { inspect: null as null };
    }
  },
  component: StreamDetailPage,
});

function StreamDetailPage() {
  const loaderData = Route.useLoaderData();
  const data = loaderData.inspect;
  const { projectId, streamId } = Route.useParams();
  const doKey = `${projectId}/${streamId}`;

  if (!data) {
    return <CreateStreamForm projectId={projectId} streamId={streamId} doKey={doKey} />;
  }

  return (
    <StreamConsole
      projectId={projectId}
      streamId={streamId}
      doKey={doKey}
      metadata={data}
    />
  );
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
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>
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
  metadata,
}: {
  projectId: string;
  streamId: string;
  doKey: string;
  metadata: {
    streamId: string;
    contentType: string;
    tailOffset: number;
    closed: boolean;
    public: boolean;
    createdAt?: number;
    closedAt?: number;
    ttlSeconds?: number;
    expiresAt?: number;
  };
}) {
  const { data: coreUrl, error: coreUrlError } = useCoreUrl();
  const { data: tokenData } = useStreamToken(projectId);
  const { data: timeseriesData } = useStreamTimeseries(doKey);

  const chartData = (timeseriesData ?? []).map((r) => ({
    time: new Date(r.bucket * 1000).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    messages: r.messages,
  }));

  const {
    status: sseStatus,
    events,
    addEvent,
    clearEvents,
  } = useDurableStream({
    coreUrl,
    projectId,
    streamKey: streamId,
    token: tokenData?.token,
    enabled: true,
  });

  const metaFields: [string, string][] = [
    ["Stream ID", metadata.streamId],
    ["Content Type", metadata.contentType],
    ["Status", metadata.closed ? "Closed" : "Open"],
    ["Created", metadata.createdAt ? relTime(metadata.createdAt) : "—"],
    ["Tail Offset", Number(metadata.tailOffset).toLocaleString() + " bytes"],
    ["Public", metadata.public ? "Yes" : "No"],
    ["TTL", metadata.ttlSeconds ? metadata.ttlSeconds + "s" : "none"],
    ["Expires", metadata.expiresAt ? relTime(metadata.expiresAt) : "never"],
  ];

  if (metadata.closed && metadata.closedAt) {
    metaFields.push(["Closed At", relTime(metadata.closedAt)]);
  }

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
        <RealtimeBadge label="SSE Clients" count={0} color="cyan" />
        <RealtimeBadge label="Long-Poll Waiters" count={0} color="blue" />
        <SseStatusBadge status={coreUrlError ? "error" : sseStatus} />
      </div>

      {coreUrlError && (
        <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
          <span className="font-semibold text-red-400">SSE unavailable: </span>
          {coreUrlError instanceof Error ? coreUrlError.message : String(coreUrlError)}
        </div>
      )}

      {/* Message Volume chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-3 text-sm font-medium text-zinc-400">Message Volume</h3>
        {(timeseriesData?.length ?? 0) > 0 ? (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="gradMsgs" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5b8df8" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#5b8df8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#606075" }} />
              <YAxis tick={{ fontSize: 11, fill: "#606075" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1a1a26",
                  border: "1px solid #2a2a3a",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="messages"
                stroke="#5b8df8"
                fill="url(#gradMsgs)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-[180px] items-center justify-center text-sm text-zinc-500">
            No data
          </div>
        )}
      </div>

      {/* Send Message panel */}
      <SendMessagePanel doKey={doKey} contentType={metadata.contentType} addEvent={addEvent} />

      {/* Two-column layout: info left, event log right */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr]">
        {/* Left column: metadata + stats + tables */}
        <div className="space-y-6">
          {/* Metadata grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {metaFields.map(([label, val]) => (
              <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
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
              Tail Offset
            </div>
            <div className="mt-1 font-mono text-2xl font-bold text-blue-400">
              {Number(metadata.tailOffset).toLocaleString()}
            </div>
            <div className="mt-2 text-xs text-zinc-500">bytes</div>
          </div>

          {/* Note about detailed data not available */}
          <div className="rounded-lg border border-amber-800 bg-amber-950/30 px-4 py-3">
            <div className="text-xs font-medium text-amber-400">
              Detailed segment and producer data not available via HTTP API
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              The simplified HTTP-only admin doesn't have access to internal DO state
            </div>
          </div>
        </div>

        {/* Right column: live event log */}
        <EventLog
          coreUrl={coreUrl}
          token={tokenData?.token}
          projectId={projectId}
          streamId={streamId}
          events={events}
          sseStatus={sseStatus}
          clearEvents={clearEvents}
          addEvent={addEvent}
        />
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
  addEvent: (type: StreamEvent["type"], content: string) => void;
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
  coreUrl,
  token,
  projectId,
  streamId,
  events,
  sseStatus,
  clearEvents,
  addEvent,
}: {
  coreUrl: string | undefined;
  token: string | undefined;
  projectId: string;
  streamId: string;
  events: StreamEvent[];
  sseStatus: string;
  clearEvents: () => void;
  addEvent: (type: StreamEvent["type"], content: string) => void;
}) {
  const [fetching, setFetching] = useState(false);

  const fetchEarlier = useCallback(async () => {
    if (!coreUrl || !token) return;
    setFetching(true);
    try {
      const res = await readStreamClient({
        url: streamUrl(coreUrl, projectId, streamId),
        offset: "-1",
        live: false,
        headers: { Authorization: `Bearer ${token}` },
      });
      const items = await res.json();
      if (items.length === 0) {
        addEvent("control", "No earlier messages found");
      } else {
        for (const item of items) {
          const display = typeof item === "string" ? item : JSON.stringify(item, null, 2);
          addEvent("data", display);
        }
        addEvent("control", `Loaded ${items.length} earlier message(s)`);
      }
    } catch (e) {
      addEvent("error", e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [coreUrl, token, projectId, streamId, addEvent]);

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
            <button onClick={clearEvents} className="text-xs text-zinc-500 hover:text-zinc-300">
              Clear
            </button>
          )}
          <SseStatusBadge status={sseStatus} />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-zinc-800 p-2">
        {events.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-500">Waiting for events...</div>
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
    error: "text-red-400",
  };
  return (
    <span className={`font-mono text-xs ${colors[status] ?? "text-zinc-500"}`}>SSE: {status}</span>
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
        <pre className="mt-1 whitespace-pre-wrap break-all text-zinc-400">{event.content}</pre>
      ) : (
        <span className="ml-2 text-zinc-400">{event.content}</span>
      )}
    </div>
  );
}
