import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useProjects } from "../lib/queries";
import { createProject } from "../lib/analytics";
import { useQueryClient } from "@tanstack/react-query";

export const Route = createFileRoute("/projects/")({
  component: ProjectsIndexPage,
});

function ProjectsIndexPage() {
  const { data: projects, isFetched, isFetching } = useProjects();
  const loading = !isFetched && isFetching;
  const [input, setInput] = useState("");
  const [showModal, setShowModal] = useState(false);
  const navigate = useNavigate();

  const handleGo = () => {
    const id = input.trim();
    if (id) {
      navigate({ to: "/projects/$projectId/streams", params: { projectId: id } });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleGo()}
          placeholder="Enter project ID..."
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
        />
        <button
          onClick={handleGo}
          className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Open Project
        </button>
        <button
          onClick={() => setShowModal(true)}
          className="rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Create Project
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
          Projects
        </h3>
        {loading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-zinc-800" />
            ))}
          </div>
        ) : (projects?.length ?? 0) === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-zinc-500">
            No projects found. Enter a project ID above to navigate directly.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Project ID
                </th>
              </tr>
            </thead>
            <tbody>
              {projects!.map((projectId) => (
                <tr
                  key={projectId}
                  className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
                >
                  <td className="px-4 py-2 font-mono text-sm">
                    <Link
                      to="/projects/$projectId/streams"
                      params={{ projectId }}
                      className="text-blue-400 hover:underline"
                    >
                      {projectId}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <CreateProjectModal onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const [projectId, setProjectId] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const handleCreate = useCallback(async () => {
    if (!projectId.trim() || !authKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createProject({ data: { projectId: projectId.trim(), authKey: authKey.trim() } });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [projectId, authKey, queryClient, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-zinc-100">Create Project</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Map an API auth key to a project ID.
        </p>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Project ID
            </label>
            <input
              type="text"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="my-project"
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Auth Key
            </label>
            <input
              type="password"
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="sk-..."
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={saving || !projectId.trim() || !authKey.trim()}
              className="rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
