import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectOverview,
});

function ProjectOverview() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Streams" value="-" />
        <StatCard label="Messages" value="-" />
        <StatCard label="Storage" value="-" />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-5 py-4">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-2xl font-bold text-blue-400">{value}</div>
    </div>
  );
}
