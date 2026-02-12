import {
  Outlet,
  HeadContent,
  Scripts,
  createRootRoute,
  Link,
  useMatches,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
        <QueryClientProvider client={queryClient}>
          <NavBar />
          <main className="mx-auto max-w-7xl px-6 py-6">
            <Outlet />
          </main>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

function NavBar() {
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.pathname ?? "/";
  const projectId = (
    matches.find((m) => (m.params as Record<string, string>)?.projectId)?.params as
      | Record<string, string>
      | undefined
  )?.projectId;

  const tabs = projectId
    ? ([
        { to: "/projects", label: "\u2039 Projects", end: true },
        { to: "/projects/$projectId", label: "Overview", end: true },
        { to: "/projects/$projectId/sessions", label: "Sessions" },
        { to: "/projects/$projectId/publish", label: "Publish", end: true },
      ] as const)
    : ([
        { to: "/", label: "System Overview", end: true },
        { to: "/projects", label: "Projects" },
      ] as const);

  return (
    <header className="flex items-center border-b border-zinc-800 px-6">
      <Link to="/" className="flex items-center gap-3 py-3 pr-5">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-sm font-semibold tracking-tight">Subscription Admin</span>
      </Link>
      <div className="mx-1 h-5 border-l border-zinc-700" />
      <nav className="flex">
        {tabs.map(({ to, label, ...rest }) => {
          const end = "end" in rest && rest.end;
          const resolved = projectId ? to.replace("$projectId", projectId) : to;
          const isActive = end
            ? currentPath === resolved || currentPath === resolved + "/"
            : currentPath.startsWith(resolved);
          return (
            <Link
              key={to}
              to={to}
              params={projectId ? { projectId } : undefined}
              className={`border-b-2 px-4 py-3 text-sm transition-colors ${
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
    </header>
  );
}
