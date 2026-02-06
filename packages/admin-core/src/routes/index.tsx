import { createFileRoute, Link } from "@tanstack/react-router";
import { useStats, useStreams, useHotStreams, useTimeseries } from "../lib/queries";
import { formatRate, formatBytes, relTime } from "../lib/formatters";
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
  const streams = useStreams();
  const hot = useHotStreams();
  const timeseries = useTimeseries();

  const byType: Record<string, AnalyticsRow> = {};
  for (const row of stats.data ?? []) {
    if (row.event_type) byType[row.event_type as string] = row;
  }

  const appends = (byType.append?.total as number) ?? 0;
  const bytes = (byType.append?.total_bytes as number) ?? 0;
  const sseCount = (byType.sse_connect?.total as number) ?? 0;
  const streamCount = streams.data?.length ?? 0;

  const chartData = buildChartData(timeseries.data ?? []);

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Appends / min"
          value={stats.isLoading ? null : formatRate(appends, 3600)}
          color="text-blue-400"
        />
        <StatCard
          label="Bytes / min"
          value={stats.isLoading ? null : formatBytes(bytes / 60) + "/m"}
          color="text-purple-400"
        />
        <StatCard
          label="Active Streams (24h)"
          value={streams.isLoading ? null : String(streamCount)}
          color="text-emerald-400"
        />
        <StatCard
          label="SSE Connects (1h)"
          value={stats.isLoading ? null : String(sseCount)}
          color="text-cyan-400"
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
                <linearGradient id="gradAppends" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5b8df8" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#5b8df8" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradBytes" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
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
                dataKey="appends"
                stroke="#5b8df8"
                fill="url(#gradAppends)"
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="bytes"
                stroke="#a78bfa"
                fill="url(#gradBytes)"
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
          <EmptyRow colSpan={3} message="No activity" />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <Th>Stream ID</Th>
                <Th>Appends</Th>
                <Th>Bytes</Th>
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
                      to="/streams/$streamId"
                      params={{ streamId: row.stream_id as string }}
                      className="text-blue-400 hover:underline"
                    >
                      {row.stream_id as string}
                    </Link>
                  </Td>
                  <Td>{row.events as number}</Td>
                  <Td>{formatBytes(row.bytes as number)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* All streams table */}
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
          All Streams (last 24h)
        </h3>
        {streams.isLoading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : (streams.data?.length ?? 0) === 0 ? (
          <EmptyRow colSpan={4} message="No streams" />
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
                      to="/streams/$streamId"
                      params={{ streamId: row.stream_id as string }}
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

function EmptyRow({
  colSpan,
  message,
}: {
  colSpan: number;
  message: string;
}) {
  return (
    <table className="w-full">
      <tbody>
        <tr>
          <td
            colSpan={colSpan}
            className="px-4 py-6 text-center text-sm text-zinc-500"
          >
            {message}
          </td>
        </tr>
      </tbody>
    </table>
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
  const buckets: Record<string, { appends: number; bytes: number }> = {};
  for (const row of timeseries) {
    const key = String(row.bucket);
    if (!buckets[key]) buckets[key] = { appends: 0, bytes: 0 };
    if (row.event_type === "append") {
      buckets[key].appends += (row.total as number) ?? 0;
      buckets[key].bytes += (row.bytes as number) ?? 0;
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
        appends: vals.appends,
        bytes: vals.bytes,
      };
    });
}
