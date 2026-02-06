import { createFileRoute, Link } from "@tanstack/react-router";
import { useStreamInspect } from "../lib/queries";
import { formatBytes, relTime } from "../lib/formatters";

export const Route = createFileRoute("/inspect/$streamId")({
  component: StreamInspectPage,
});

function StreamInspectPage() {
  const { streamId } = Route.useParams();
  const { data, isLoading, error } = useStreamInspect(streamId);

  if (isLoading) return <InspectSkeleton />;

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
        Stream not found
      </div>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  const m = d.meta;
  const ops = d.ops;
  const segments = d.segments ?? [];
  const producers = d.producers ?? [];

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
        to="/inspect"
        className="text-sm text-zinc-400 hover:text-zinc-200"
      >
        &larr; Back to search
      </Link>

      {/* Realtime badges */}
      <div className="flex gap-4">
        <RealtimeBadge
          label="SSE Clients"
          count={d.sseClientCount}
          color="cyan"
        />
        <RealtimeBadge
          label="Long-Poll Waiters"
          count={d.longPollWaiterCount}
          color="blue"
        />
      </div>

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
    </div>
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

function InspectSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex gap-4">
        <div className="h-16 w-40 animate-pulse rounded-lg bg-zinc-800" />
        <div className="h-16 w-40 animate-pulse rounded-lg bg-zinc-800" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-zinc-800" />
        ))}
      </div>
      <div className="h-24 animate-pulse rounded-lg bg-zinc-800" />
    </div>
  );
}
