import { createFileRoute, Outlet, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <Link to="/projects" className="hover:text-zinc-200">
          Projects
        </Link>
        <span>/</span>
        <span className="font-mono text-zinc-100">{projectId}</span>
      </div>
      <Outlet />
    </div>
  );
}
