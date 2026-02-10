import { createFileRoute, Link } from "@tanstack/react-router";
import { useProjectStreams } from "../lib/queries";
import { formatBytes, relTime } from "../lib/formatters";
import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/projects/$projectId/streams/")({
  component: StreamsIndexPage,
});

function StreamsIndexPage() {
  const { projectId } = Route.useParams();
  const { data: streams, isFetched, isFetching } = useProjectStreams(projectId);
  const loading = !isFetched && isFetching;

  return (
    <div>
      {loading ? (
        <div className="p-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-zinc-800" />
          ))}
        </div>
      ) : (
        <Table aria-label="Streams">
          <TableHeader>
            <TableColumn isRowHeader>Stream Key</TableColumn>
            <TableColumn>Messages</TableColumn>
            <TableColumn>Size</TableColumn>
            <TableColumn>Last Write</TableColumn>
            <TableColumn>Actions</TableColumn>
          </TableHeader>
          <TableBody
            items={streams ?? []}
            renderEmptyState={() => (
              <div className="py-6 text-center text-sm text-zinc-500">
                No streams found. Use the search bar above to open or create a stream.
              </div>
            )}
          >
            {(s) => (
              <TableRow id={s.stream_id}>
                <TableCell>
                  <Link
                    to="/projects/$projectId/streams/$streamId"
                    params={{ projectId, streamId: s.stream_id }}
                    className="font-mono text-blue-400 hover:underline"
                  >
                    {s.stream_id}
                  </Link>
                </TableCell>
                <TableCell className="font-mono">{s.messages.toLocaleString()}</TableCell>
                <TableCell>{formatBytes(s.bytes)}</TableCell>
                <TableCell>{relTime(new Date(s.last_seen).getTime() / 1000)}</TableCell>
                <TableCell>
                  <Link
                    to="/projects/$projectId/streams/$streamId"
                    params={{ projectId, streamId: s.stream_id }}
                    className="text-xs text-blue-400 hover:underline"
                  >
                    View
                  </Link>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
