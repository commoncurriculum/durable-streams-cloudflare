import {
  createFileRoute,
  Outlet,
  useNavigate,
  useMatch,
} from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/console")({
  component: ConsoleLayout,
});

function ConsoleLayout() {
  const sessionMatch = useMatch({
    from: "/console/$project/session/$id",
    shouldThrow: false,
  });
  const streamMatch = useMatch({
    from: "/console/$project/stream/$id",
    shouldThrow: false,
  });
  const hasChild = sessionMatch || streamMatch;

  return (
    <div className="space-y-8">
      <SearchBars />
      {hasChild ? <Outlet /> : (
        <div className="mt-4 py-8 text-center text-zinc-500">
          Enter a project ID and session or stream ID to open
        </div>
      )}
    </div>
  );
}

function SearchBars() {
  const [projectInput, setProjectInput] = useState("");
  const [sessionInput, setSessionInput] = useState("");
  const [streamInput, setStreamInput] = useState("");
  const navigate = useNavigate();

  const handleSessionOpen = () => {
    const project = projectInput.trim();
    const id = sessionInput.trim();
    if (project && id) {
      navigate({ to: "/console/$project/session/$id", params: { project, id } });
    }
  };

  const handleStreamOpen = () => {
    const project = projectInput.trim();
    const id = streamInput.trim();
    if (project && id) {
      navigate({ to: "/console/$project/stream/$id", params: { project, id } });
    }
  };

  return (
    <>
      <div>
        <h3 className="mb-4 text-sm font-medium text-zinc-400">
          Project
        </h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={projectInput}
            onChange={(e) => setProjectInput(e.target.value)}
            placeholder="Enter project ID..."
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div>
        <h3 className="mb-4 text-sm font-medium text-zinc-400">
          Session
        </h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSessionOpen()}
            placeholder="Enter session ID..."
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
          <button
            onClick={handleSessionOpen}
            className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            Open Session
          </button>
        </div>
      </div>

      <div>
        <h3 className="mb-4 text-sm font-medium text-zinc-400">
          Stream
        </h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={streamInput}
            onChange={(e) => setStreamInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleStreamOpen()}
            placeholder="Enter stream ID..."
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
          <button
            onClick={handleStreamOpen}
            className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            Open Stream
          </button>
        </div>
      </div>
    </>
  );
}
