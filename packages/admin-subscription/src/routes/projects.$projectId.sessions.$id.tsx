import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useSessionInspect, useCoreUrl, useStreamToken } from "../lib/queries";
import { sendSessionAction } from "../lib/analytics";
import { stream as readStreamClient } from "@durable-streams/client";
import { useDurableStream, type StreamEvent } from "../hooks/use-durable-stream";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

type SessionData = {
  sessionId?: string;
  session_id?: string;
  sessionStreamPath?: string;
  session_stream_path?: string;
  subscriptions?: { streamId?: string; stream_id?: string }[];
};

export const Route = createFileRoute("/projects/$projectId/sessions/$id")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { projectId, id } = Route.useParams();
  const { data, isLoading, error } = useSessionInspect(id, projectId);

  const [streamIdInput, setStreamIdInput] = useState("");
  const [sending, setSending] = useState(false);

  const { data: coreUrl } = useCoreUrl();
  const { data: tokenData } = useStreamToken(projectId);

  const { status, events, addEvent, clearEvents } = useDurableStream({
    coreUrl,
    projectId,
    streamKey: id,
    token: tokenData?.token,
    enabled: !!data,
  });

  const doAction = useCallback(
    async (
      action: "subscribe" | "unsubscribe" | "touch" | "delete",
      streamId?: string,
    ) => {
      setSending(true);
      try {
        const payload: Parameters<typeof sendSessionAction>[0]["data"] =
          action === "subscribe" || action === "unsubscribe"
            ? { action, projectId, sessionId: id, streamId: streamId! }
            : { action, projectId, sessionId: id };

        const MAX_RETRIES = 2;
        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await sendSessionAction({ data: payload });
            const body = result.body as Record<string, unknown> | undefined;
            let message: string;
            switch (action) {
              case "subscribe":
                message = `Subscribed to ${(body?.streamId as string) ?? streamId}`;
                break;
              case "unsubscribe":
                message = `Unsubscribed from ${streamId}`;
                break;
              case "touch":
                message = "Session touched";
                break;
              case "delete":
                message = "Session deleted";
                break;
            }
            addEvent("control", message);
            lastError = undefined;
            break;
          } catch (e) {
            lastError = e;
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt < MAX_RETRIES && msg.includes("restarted")) {
              await new Promise((r) => setTimeout(r, 300));
              continue;
            }
          }
        }
        if (lastError) {
          addEvent(
            "error",
            lastError instanceof Error ? lastError.message : String(lastError),
          );
        }
      } finally {
        setSending(false);
      }
    },
    [projectId, id, addEvent],
  );

  const handleSubscribe = useCallback(async () => {
    if (!streamIdInput.trim()) return;
    await doAction("subscribe", streamIdInput.trim());
    setStreamIdInput("");
  }, [streamIdInput, doAction]);

  const [fetching, setFetching] = useState(false);

  const fetchEarlier = useCallback(async () => {
    if (!coreUrl || !tokenData?.token) return;
    setFetching(true);
    try {
      const res = await readStreamClient({
        url: `${coreUrl}/v1/stream/${projectId}/${id}`,
        offset: "-1",
        live: false,
        headers: { Authorization: `Bearer ${tokenData.token}` },
      });
      const items = await res.json();
      if (items.length === 0) {
        addEvent("control", "No earlier messages found");
      } else {
        for (const item of items) {
          const display =
            typeof item === "string" ? item : JSON.stringify(item, null, 2);
          addEvent("data", display);
        }
        addEvent("control", `Loaded ${items.length} earlier message(s)`);
      }
    } catch (e) {
      addEvent("error", e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }, [coreUrl, tokenData?.token, projectId, id, addEvent]);

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

  const d = data as SessionData;
  const sessionId = d.sessionId || d.session_id || "\u2014";
  const sessionStreamPath = d.sessionStreamPath || d.session_stream_path || "\u2014";
  const subscriptions = d.subscriptions ?? [];

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        to="/projects/$projectId/sessions"
        params={{ projectId }}
        className="text-sm text-zinc-400 hover:text-zinc-200"
      >
        &larr; Back to sessions
      </Link>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <MetaItem label="Session ID" value={sessionId} />
        <MetaItem label="Subscriptions" value={String(subscriptions.length)} />
        <MetaItem label="Messages" value="\u2014" />
        <MetaItem label="Session Stream" value={sessionStreamPath} />
      </div>

      {/* Two-column: left (chart + subscriptions) / right (subscribe + event log) */}
      <div className="grid min-h-[400px] grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left column */}
        <div className="space-y-6">
          {/* Message Volume */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="mb-3 text-sm font-medium text-zinc-400">Message Volume</h3>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={[]}>
                  <defs>
                    <linearGradient id="sessionMsgGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" stroke="#52525b" fontSize={11} />
                  <YAxis stroke="#52525b" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 6 }}
                    labelStyle={{ color: "#a1a1aa" }}
                    itemStyle={{ color: "#3b82f6" }}
                  />
                  <Area type="monotone" dataKey="messages" stroke="#3b82f6" fill="url(#sessionMsgGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Subscriptions */}
          <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
              Subscriptions ({subscriptions.length})
            </h3>
            {subscriptions.length > 0 ? (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Stream ID
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-zinc-500">
                      Actions
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
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => doAction("unsubscribe", sid)}
                            disabled={sending}
                            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                          >
                            Unsubscribe
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="py-8 text-center text-zinc-500">
                No active subscriptions
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-6">
          {/* Add Subscription form */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500 mb-2">
              Add Subscription
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={streamIdInput}
                onChange={(e) => setStreamIdInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubscribe()}
                placeholder="stream-id"
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
              />
              <button
                onClick={handleSubscribe}
                disabled={sending || !streamIdInput.trim()}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Subscribe
              </button>
            </div>

            {/* Utility actions */}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => doAction("touch")}
                disabled={sending}
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
              >
                Touch
              </button>
              <button
                onClick={() => doAction("delete")}
                disabled={sending}
                className="flex-1 rounded-md border border-red-900 bg-zinc-800 px-3 py-2 text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>

          {/* Event log */}
          <div className="flex flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h3 className="text-sm font-medium text-zinc-400">Live Event Log</h3>
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
                <StreamStatusBadge status={status} />
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

function StreamStatusBadge({ status }: { status: string }) {
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
