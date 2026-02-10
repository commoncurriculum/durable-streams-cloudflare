import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettings,
});

function ProjectSettings() {
  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="text-sm font-medium text-zinc-400">Privacy</h3>
        <p className="mt-2 text-sm text-zinc-500">Settings coming soon.</p>
      </div>
    </div>
  );
}
