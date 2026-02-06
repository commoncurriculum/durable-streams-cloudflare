import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/inspect")({
  component: InspectIndexPage,
});

function InspectIndexPage() {
  const [input, setInput] = useState("");
  const navigate = useNavigate();

  const handleInspect = () => {
    const id = input.trim();
    if (id) {
      navigate({ to: "/inspect/$streamId", params: { streamId: id } });
    }
  };

  return (
    <div>
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleInspect()}
          placeholder="Enter stream ID..."
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
        />
        <button
          onClick={handleInspect}
          className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Inspect
        </button>
      </div>
      <div className="py-12 text-center text-zinc-500">
        Enter a stream ID to inspect
      </div>
    </div>
  );
}
