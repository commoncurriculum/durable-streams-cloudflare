import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/inspect")({
  component: InspectIndexPage,
});

function InspectIndexPage() {
  const [sessionInput, setSessionInput] = useState("");
  const [streamInput, setStreamInput] = useState("");
  const navigate = useNavigate();

  const handleSessionInspect = () => {
    const id = sessionInput.trim();
    if (id) {
      navigate({ to: "/inspect/session/$id", params: { id } });
    }
  };

  const handleStreamInspect = () => {
    const id = streamInput.trim();
    if (id) {
      navigate({ to: "/inspect/stream/$id", params: { id } });
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h3 className="mb-4 text-sm font-medium text-zinc-400">
          Session Inspector
        </h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={sessionInput}
            onChange={(e) => setSessionInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSessionInspect()}
            placeholder="Enter session ID..."
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
          <button
            onClick={handleSessionInspect}
            className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            Inspect
          </button>
        </div>
        <div className="mt-4 py-8 text-center text-zinc-500">
          Enter a session ID to inspect
        </div>
      </div>

      <div>
        <h3 className="mb-4 text-sm font-medium text-zinc-400">
          Stream Inspector
        </h3>
        <div className="flex gap-3">
          <input
            type="text"
            value={streamInput}
            onChange={(e) => setStreamInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleStreamInspect()}
            placeholder="Enter stream ID..."
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
          />
          <button
            onClick={handleStreamInspect}
            className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            Inspect
          </button>
        </div>
        <div className="mt-4 py-8 text-center text-zinc-500">
          Enter a stream ID to inspect subscribers
        </div>
      </div>
    </div>
  );
}
