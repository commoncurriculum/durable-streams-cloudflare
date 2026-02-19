import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectEstuaries } from "../lib/queries";
import { createEstuary } from "../lib/analytics";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/projects/$projectId/estuaries/")({
  component: EstuariesIndex,
});

function EstuariesIndex() {
  const { projectId } = Route.useParams();
  const { data: estuaries } = useProjectEstuaries(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    const estuaryId = crypto.randomUUID();
    try {
      await createEstuary({ data: { projectId, estuaryId } });
      await queryClient.invalidateQueries({ queryKey: ["projectEstuaries", projectId] });
      navigate({
        to: "/projects/$projectId/estuaries/$id",
        params: { projectId, id: estuaryId },
      });
    } finally {
      setCreating(false);
    }
  };

  const items = (estuaries ?? []).map((e) => ({ id: e.estuaryId, ...e }));

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Estuaries</h2>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create Estuary"}
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <Table aria-label="Estuaries">
          <TableHeader>
            <TableColumn isRowHeader>Estuary ID</TableColumn>
            <TableColumn>Created</TableColumn>
          </TableHeader>
          <TableBody
            items={items}
            renderEmptyState={() => (
              <div className="py-12 text-center text-zinc-500">
                No estuaries found. Create one to get started.
              </div>
            )}
          >
            {(item) => (
              <TableRow id={item.id}>
                <TableCell>
                  <Link
                    to="/projects/$projectId/estuaries/$id"
                    params={{ projectId, id: item.estuaryId }}
                    className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {item.estuaryId}
                  </Link>
                </TableCell>
                <TableCell>
                  {item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
