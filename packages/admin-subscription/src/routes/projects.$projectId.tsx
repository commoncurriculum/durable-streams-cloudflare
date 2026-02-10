import { createFileRoute, Link, Outlet, useMatches } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.pathname ?? "";

  const tabs = [
    { to: `/projects/${projectId}`, label: "Overview", exact: true },
    { to: `/projects/${projectId}/sessions`, label: "Sessions" },
    { to: `/projects/${projectId}/publish`, label: "Publish" },
  ];

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm text-zinc-400">
        <Link to="/projects" className="hover:text-zinc-200">
          Projects
        </Link>
        <span>/</span>
        <span className="text-zinc-100">{projectId}</span>
      </div>

      <nav className="mb-6 flex border-b border-zinc-800">
        {tabs.map(({ to, label, exact }) => {
          const isActive = exact
            ? currentPath === to || currentPath === `${to}/`
            : currentPath.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
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
