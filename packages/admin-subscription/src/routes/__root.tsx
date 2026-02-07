import {
  Outlet,
  HeadContent,
  Scripts,
  createRootRoute,
  Link,
  useMatches,
  useNavigate,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProjects } from "../lib/queries";
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

  const handleProjectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newProjectId = e.target.value;
    if (!newProjectId) return;
    const target = subRoute ?? "sessions";
    navigate({
      to: `/projects/$projectId/${target}`,
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
      </div>
    </nav>
  );
}
