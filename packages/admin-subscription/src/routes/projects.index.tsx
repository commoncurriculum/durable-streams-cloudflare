import { createFileRoute, Link } from "@tanstack/react-router";
import { useProjects } from "../lib/queries";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/projects/")({
  component: ProjectsIndex,
});

function ProjectsIndex() {
  const { data: projects } = useProjects();

  const items = (projects ?? []).map((p) => ({ id: p }));

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Projects</h2>
      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <Table aria-label="Projects">
          <TableHeader>
            <TableColumn isRowHeader>Project ID</TableColumn>
          </TableHeader>
          <TableBody
            items={items}
            renderEmptyState={() => (
              <div className="py-12 text-center text-zinc-500">
                No projects found. Create projects in the Core admin.
              </div>
            )}
          >
            {(item) => (
              <TableRow id={item.id}>
                <TableCell>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: item.id }}
                    className="text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {item.id}
                  </Link>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
