import { createFileRoute, Outlet, Link, useMatches } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.pathname ?? "";

  const tabs = [
    { to: "/projects/$projectId", label: "Overview", end: true },
    { to: "/projects/$projectId/streams", label: "Streams" },
    { to: "/projects/$projectId/settings", label: "Settings" },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        <Link to="/projects" className="hover:text-zinc-200">
          Projects
        </Link>
        <span>/</span>
        <span className="font-mono text-zinc-100">{projectId}</span>
      </div>

      <nav className="flex border-b border-zinc-800">
        {tabs.map(({ to, label, ...rest }) => {
          const end = "end" in rest && rest.end;
          const resolved = to.replace("$projectId", projectId);
          const isActive = end
            ? currentPath === resolved || currentPath === resolved + "/"
            : currentPath.startsWith(resolved);
          return (
            <Link
              key={to}
              to={to}
              params={{ projectId }}
              className={`border-b-2 px-5 py-2.5 text-sm transition-colors ${
                isActive
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <Outlet />
    </div>
  );
}
