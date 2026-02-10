import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectOverview,
});

function ProjectOverview() {
  const { projectId } = Route.useParams();

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Project Overview</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Sessions
          </div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">—</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Active Subs
          </div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">—</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Messages
          </div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">—</div>
        </div>
      </div>
    </div>
  );
}
