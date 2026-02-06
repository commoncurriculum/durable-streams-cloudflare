import { createFileRoute, Link } from "@tanstack/react-router";
import {
  useStats,
  useSessions,
  useStreams,
  useHotStreams,
  useTimeseries,
  useErrors,
} from "../lib/queries";
import { formatRate, relTime } from "../lib/formatters";
import type { AnalyticsRow } from "../types";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export const Route = createFileRoute("/")({
  component: OverviewPage,
});

function OverviewPage() {
  const stats = useStats();
  const sessions = useSessions();
  const streams = useStreams();
  const hot = useHotStreams();
  const timeseries = useTimeseries();
  const errors = useErrors();

  const byType: Record<string, AnalyticsRow> = {};
  for (const row of stats.data?.stats ?? []) {
    if (row.event_type) byType[row.event_type as string] = row;
  }

  const fanoutRow = (stats.data?.fanout ?? [])[0] ?? {};
  const cleanupRow = (stats.data?.cleanup ?? [])[0] ?? {};

  const publishCount = (byType.publish?.total as number) ?? 0;
  const subscribeCount = (byType.subscribe?.total as number) ?? 0;
  const unsubscribeCount = (byType.unsubscribe?.total as number) ?? 0;
  const expiredCount = (cleanupRow.expired_sessions as number) ?? 0;
  const avgLatency = (fanoutRow.avg_latency_ms as number) ?? 0;
  const successes = (fanoutRow.successes as number) ?? 0;
  const failures = (fanoutRow.failures as number) ?? 0;
  const successRate =
    successes + failures > 0
      ? (successes / (successes + failures)) * 100
      : 0;

  const chartData = buildChartData(timeseries.data ?? []);
  const loading = stats.isLoading;

  return (
    <div className="space-y-6">
      {/* Top row stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Publishes / min"
          value={loading ? null : formatRate(publishCount, 3600)}
          color="text-blue-400"
        />
        <StatCard
          label="Fanout Latency avg (ms)"
          value={
            loading
              ? null
              : typeof avgLatency === "number"
                ? avgLatency.toFixed(1)
                : "\u2014"
          }
          color="text-amber-400"
        />
        <StatCard
          label="Active Sessions (24h)"
          value={sessions.isLoading ? null : String(sessions.data?.length ?? 0)}
          color="text-emerald-400"
        />
        <StatCard
          label="Active Streams (24h)"
          value={streams.isLoading ? null : String(streams.data?.length ?? 0)}
          color="text-cyan-400"
        />
      </div>

      {/* Bottom row stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Fanout Success Rate"
          value={loading ? null : successRate > 0 ? successRate.toFixed(1) + "%" : "\u2014"}
          color="text-emerald-400"
        />
        <StatCard
          label="Subscribes (1h)"
          value={loading ? null : String(subscribeCount)}
          color="text-blue-400"
        />
        <StatCard
          label="Unsubscribes (1h)"
          value={loading ? null : String(unsubscribeCount)}
          color="text-purple-400"
        />
        <StatCard
          label="Expired Sessions (24h)"
          value={loading ? null : String(expiredCount)}
          color="text-amber-400"
        />
      </div>

      {/* Timeseries chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-3 text-sm font-medium text-zinc-400">
          Throughput (last hour)
        </h3>
        {timeseries.isLoading ? (
          <div className="h-[180px] animate-pulse rounded bg-zinc-800" />
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="gradPublish" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5b8df8" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#5b8df8" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradSubscribe" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
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
                dataKey="publish"
                stroke="#5b8df8"
                fill="url(#gradPublish)"
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="subscribe"
                stroke="#34d399"
                fill="url(#gradSubscribe)"
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

      {/* Hot streams table */}
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
          Hot Streams (last 5 min)
        </h3>
        {hot.isLoading ? (
          <TableSkeleton rows={3} cols={3} />
        ) : (hot.data?.length ?? 0) === 0 ? (
          <EmptyRow message="No activity" />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <Th>Stream ID</Th>
                <Th>Publishes</Th>
                <Th>Fanout Count</Th>
              </tr>
            </thead>
            <tbody>
              {hot.data!.map((row) => (
                <tr
                  key={row.stream_id as string}
                  className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                >
                  <Td>
                    <Link
                      to="/inspect/stream/$id"
                      params={{ id: row.stream_id as string }}
                      className="text-blue-400 hover:underline"
                    >
                      {row.stream_id as string}
                    </Link>
                  </Td>
                  <Td>{row.publishes as number}</Td>
                  <Td>{(row.fanout_count as number) ?? 0}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* All streams table */}
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
          All Streams (24h)
        </h3>
        {streams.isLoading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : (streams.data?.length ?? 0) === 0 ? (
          <EmptyRow message="No streams" />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <Th>Stream ID</Th>
                <Th>Events</Th>
                <Th>First Seen</Th>
                <Th>Last Seen</Th>
              </tr>
            </thead>
            <tbody>
              {streams.data!.map((row) => (
                <tr
                  key={row.stream_id as string}
                  className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                >
                  <Td>
                    <Link
                      to="/inspect/stream/$id"
                      params={{ id: row.stream_id as string }}
                      className="text-blue-400 hover:underline"
                    >
                      {row.stream_id as string}
                    </Link>
                  </Td>
                  <Td>{row.total_events as number}</Td>
                  <Td>{relTime(row.first_seen as string)}</Td>
                  <Td>{relTime(row.last_seen as string)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Errors table */}
      {(errors.data?.length ?? 0) > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
          <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
            Publish Errors (24h)
          </h3>
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <Th>Stream ID</Th>
                <Th>Error Type</Th>
                <Th>Count</Th>
                <Th>Last Seen</Th>
              </tr>
            </thead>
            <tbody>
              {errors.data!.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                >
                  <Td>{row.stream_id as string}</Td>
                  <Td>
                    <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs font-medium text-red-400">
                      {row.error_type as string}
                    </span>
                  </Td>
                  <Td>{row.total as number}</Td>
                  <Td>{relTime(row.last_seen as string)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Shared sub-components ---

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | null;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-5 py-4">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      {value === null ? (
        <div className="h-8 w-20 animate-pulse rounded bg-zinc-800" />
      ) : (
        <div className={`font-mono text-2xl font-bold ${color}`}>{value}</div>
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

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="px-4 py-6 text-center text-sm text-zinc-500">
      {message}
    </div>
  );
}

function TableSkeleton({ rows, cols }: { rows: number; cols: number }) {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4">
          {Array.from({ length: cols }).map((_, j) => (
            <div
              key={j}
              className="h-4 flex-1 animate-pulse rounded bg-zinc-800"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function buildChartData(timeseries: AnalyticsRow[]) {
  const buckets: Record<string, { publish: number; subscribe: number }> = {};
  for (const row of timeseries) {
    const key = String(row.bucket);
    if (!buckets[key]) buckets[key] = { publish: 0, subscribe: 0 };
    if (row.event_type === "publish") {
      buckets[key].publish += (row.total as number) ?? 0;
    }
    if (row.event_type === "subscribe") {
      buckets[key].subscribe += (row.total as number) ?? 0;
    }
  }

  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, vals]) => {
      const d = new Date(Number(bucket) * 1000);
      return {
        time: d.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
        publish: vals.publish,
        subscribe: vals.subscribe,
      };
    });
}
