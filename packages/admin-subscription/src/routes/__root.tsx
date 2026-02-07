import {
  Outlet,
  HeadContent,
  Scripts,
  createRootRoute,
  Link,
  useMatches,
  useNavigate,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { useProjects } from "../lib/queries";
import { createProject } from "../lib/analytics";
import "../styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2000 } },
});

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
    ],
    title: "Subscription Admin",
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 font-sans antialiased">
        <Header />
        <QueryClientProvider client={queryClient}>
          <Nav />
          <main className="mx-auto max-w-7xl px-6 py-6">
            <Outlet />
          </main>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="flex items-center gap-4 border-b border-zinc-800 px-6 py-4">
      <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
      <h1 className="text-base font-semibold tracking-tight">
        Subscription Service
      </h1>
    </header>
  );
}

function useCurrentProjectId(): string | undefined {
  const matches = useMatches();
  for (const match of matches) {
    const params = match.params as Record<string, string>;
    if (params.projectId) return params.projectId;
  }
  return undefined;
}

function useCurrentSubRoute(): "sessions" | "publish" | null {
  const matches = useMatches();
  const lastPath = matches[matches.length - 1]?.pathname ?? "/";
  if (lastPath.includes("/publish")) return "publish";
  if (lastPath.includes("/sessions")) return "sessions";
  return null;
}

function Nav() {
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.pathname ?? "/";
  const projectId = useCurrentProjectId();
  const subRoute = useCurrentSubRoute();
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const [showCreateModal, setShowCreateModal] = useState(false);

  const handleProjectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newProjectId = e.target.value;
    if (!newProjectId) return;
    const target = subRoute ?? "sessions";
    navigate({
      to: `/projects/$projectId/${target}`,
      params: { projectId: newProjectId },
    });
  };

  const handleProjectCreated = (newProjectId: string) => {
    setShowCreateModal(false);
    navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId: newProjectId },
    });
  };

  const sessionsTo = projectId
    ? `/projects/${projectId}/sessions`
    : undefined;
  const publishTo = projectId
    ? `/projects/${projectId}/publish`
    : undefined;

  return (
    <>
      <nav className="flex items-center border-b border-zinc-800 px-6">
        <div className="flex">
          <Link
            to="/"
            className={`border-b-2 px-5 py-2.5 text-sm transition-colors ${
              currentPath === "/"
                ? "border-blue-500 text-blue-400"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Overview
          </Link>
          {sessionsTo ? (
            <Link
              to={sessionsTo}
              className={`border-b-2 px-5 py-2.5 text-sm transition-colors ${
                currentPath.includes("/sessions")
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Sessions
            </Link>
          ) : (
            <span className="border-b-2 border-transparent px-5 py-2.5 text-sm text-zinc-600 cursor-default">
              Sessions
            </span>
          )}
          {publishTo ? (
            <Link
              to={publishTo}
              className={`border-b-2 px-5 py-2.5 text-sm transition-colors ${
                currentPath.includes("/publish")
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Publish
            </Link>
          ) : (
            <span className="border-b-2 border-transparent px-5 py-2.5 text-sm text-zinc-600 cursor-default">
              Publish
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="project-select" className="text-xs text-zinc-500">
            Project:
          </label>
          <select
            id="project-select"
            value={projectId ?? ""}
            onChange={handleProjectChange}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-blue-500"
          >
            <option value="">Select project...</option>
            {projects?.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowCreateModal(true)}
            className="rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
            title="Create Project"
          >
            +
          </button>
        </div>
      </nav>

      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreated={handleProjectCreated}
        />
      )}
    </>
  );
}

function CreateProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const handleCreate = useCallback(async () => {
    if (!projectId.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createProject({
        data: { projectId: projectId.trim() },
      });
      setCreatedSecret(result.signingSecret);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [projectId, queryClient]);

  const handleCopy = useCallback(() => {
    if (createdSecret) {
      navigator.clipboard.writeText(createdSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [createdSecret]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-zinc-100">Create Project</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Create a project with an auto-generated signing secret for JWT auth.
        </p>

        {createdSecret ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-sm text-amber-300">
              Save this signing secret now. It will not be shown again.
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Signing Secret
              </label>
              <div className="flex gap-2">
                <code className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 break-all">
                  {createdSecret}
                </code>
                <button
                  onClick={handleCopy}
                  className="shrink-0 rounded-md bg-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-600"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={() => onCreated(projectId.trim())}
                className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
                Project ID
              </label>
              <input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="my-project"
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
                disabled={saving || !projectId.trim()}
                className="rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
