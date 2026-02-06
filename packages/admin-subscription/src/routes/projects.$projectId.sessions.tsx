import {
  createFileRoute,
  Outlet,
  useNavigate,
  useMatch,
} from "@tanstack/react-router";
import { useState } from "react";

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
        <div className="py-12 text-center text-zinc-500">
          Enter a session ID to inspect
        </div>
      )}
    </div>
  );
}

function SearchBar({ projectId }: { projectId: string }) {
  const [input, setInput] = useState("");
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

  return (
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
    </div>
  );
}
