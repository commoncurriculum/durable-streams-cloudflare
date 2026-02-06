import { createFileRoute, Link } from "@tanstack/react-router";
import { useSessionInspect } from "../lib/queries";

export const Route = createFileRoute("/inspect/session/$id")({
  component: SessionInspectPage,
});

function SessionInspectPage() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useSessionInspect(id);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  const sessionId = d.sessionId || d.session_id || "\u2014";
  const sessionStreamPath = d.sessionStreamPath || d.session_stream_path || "\u2014";
  const subscriptions: { streamId?: string; stream_id?: string }[] =
    d.subscriptions ?? [];

  return (
    <div className="space-y-6">
      <Link
        to="/inspect"
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
                    <td className="px-4 py-2 font-mono text-sm">
                      <Link
                        to="/inspect/stream/$id"
                        params={{ id: sid }}
                        className="text-blue-400 hover:underline"
                      >
                        {sid}
                      </Link>
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
