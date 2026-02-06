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
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100 font-sans antialiased">
        <Header />
        <Nav />
        <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
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

function Nav() {
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.pathname ?? "/";

  const links = [
    { to: "/", label: "Overview" },
    { to: "/console", label: "Console" },
  ] as const;

  return (
    <nav className="flex border-b border-zinc-800 px-6">
      {links.map(({ to, label }) => {
        const isActive =
          to === "/"
            ? currentPath === "/"
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
  );
}
