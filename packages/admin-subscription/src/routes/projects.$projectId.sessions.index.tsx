import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectSessions } from "../lib/queries";
import { createSession } from "../lib/analytics";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/projects/$projectId/sessions/")({
  component: SessionsIndex,
});

function SessionsIndex() {
  const { projectId } = Route.useParams();
  const { data: sessions } = useProjectSessions(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    const sessionId = crypto.randomUUID();
    try {
      await createSession({ data: { projectId, sessionId } });
      await queryClient.invalidateQueries({ queryKey: ["projectSessions", projectId] });
      navigate({
        to: "/projects/$projectId/sessions/$id",
        params: { projectId, id: sessionId },
      });
    } finally {
      setCreating(false);
    }
  };

  const items = (sessions ?? []).map((s) => ({ id: s.sessionId, ...s }));

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Sessions</h2>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create Session"}
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <Table aria-label="Sessions">
          <TableHeader>
            <TableColumn isRowHeader>Session ID</TableColumn>
            <TableColumn>Created</TableColumn>
          </TableHeader>
          <TableBody
            items={items}
            renderEmptyState={() => (
              <div className="py-12 text-center text-zinc-500">
                No sessions found. Create one to get started.
              </div>
            )}
          >
            {(item) => (
              <TableRow id={item.id}>
                <TableCell>
                  <Link
                    to="/projects/$projectId/sessions/$id"
                    params={{ projectId, id: item.sessionId }}
                    className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {item.sessionId}
                  </Link>
                </TableCell>
                <TableCell>
                  {item.createdAt
                    ? new Date(item.createdAt).toLocaleString()
                    : "—"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
