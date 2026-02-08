import {
  createFileRoute,
  Link,
  Outlet,
  useNavigate,
  useMatch,
} from "@tanstack/react-router";
import { useState } from "react";
import { createSession } from "../lib/analytics";
import { addRecentSession, getRecentSessions } from "../lib/recent-sessions";

export const Route = createFileRoute("/projects/$projectId/sessions")({
  component: SessionsLayout,
});

function SessionsLayout() {
  const { projectId } = Route.useParams();
  const childMatch = useMatch({
    from: "/projects/$projectId/sessions/$id",
    shouldThrow: false,
  });

  return (
    <div>
      <SearchBar projectId={projectId} />
      {childMatch ? (
        <Outlet />
      ) : (
        <RecentSessionsList projectId={projectId} />
      )}
    </div>
  );
}

function SearchBar({ projectId }: { projectId: string }) {
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const handleOpen = () => {
    const id = input.trim();
    if (id) {
      navigate({
        to: "/projects/$projectId/sessions/$id",
        params: { projectId, id },
      });
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError("");
    const sessionId = crypto.randomUUID();
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await createSession({ data: { projectId, sessionId } });
        addRecentSession(projectId, sessionId);
        navigate({
          to: "/projects/$projectId/sessions/$id",
          params: { projectId, id: sessionId },
        });
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_RETRIES && msg.includes("restarted")) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        setError(msg);
        setCreating(false);
        return;
      }
    }
  };

  return (
    <div>
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleOpen()}
          placeholder="Enter session ID..."
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
        />
        <button
          onClick={handleOpen}
          className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Open Session
        </button>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="rounded-md bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create Session"}
        </button>
      </div>
      {error && (
        <div className="mb-4 rounded-md border border-red-800 bg-red-900/30 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}

function RecentSessionsList({ projectId }: { projectId: string }) {
  const sessions = getRecentSessions(projectId);

  if (sessions.length === 0) {
    return (
      <div className="py-12 text-center text-zinc-500">
        No recent sessions. Create one or enter an ID above.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
      <h3 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-400">
        Recent Sessions
      </h3>
      <ul>
        {sessions.map((s) => (
          <li
            key={s.sessionId}
            className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/50"
          >
            <Link
              to="/projects/$projectId/sessions/$id"
              params={{ projectId, id: s.sessionId }}
              className="block px-4 py-2.5 font-mono text-sm text-zinc-300 hover:text-zinc-100"
            >
              {s.sessionId}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
