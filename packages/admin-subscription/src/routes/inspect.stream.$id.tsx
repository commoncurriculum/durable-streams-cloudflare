import { createFileRoute, Link } from "@tanstack/react-router";
import { useStreamSubscribers } from "../lib/queries";

export const Route = createFileRoute("/inspect/stream/$id")({
  component: StreamInspectPage,
});

function StreamInspectPage() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useStreamSubscribers(id);

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
    <div className="space-y-6">
      <Link
        to="/inspect"
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
  );
}
