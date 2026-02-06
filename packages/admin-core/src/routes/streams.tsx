import {
  createFileRoute,
  Outlet,
  useNavigate,
  useMatch,
} from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/streams")({
  component: StreamsLayout,
});

function StreamsLayout() {
  const childMatch = useMatch({ from: "/streams/$streamId", shouldThrow: false });

  return (
    <div>
      <SearchBar />
      {childMatch ? <Outlet /> : (
        <div className="py-12 text-center text-zinc-500">
          Enter a stream ID to open or create a stream
        </div>
      )}
    </div>
  );
}

function SearchBar() {
  const [input, setInput] = useState("");
  const navigate = useNavigate();

  const handleOpen = () => {
    const id = input.trim();
    if (id) {
      navigate({ to: "/streams/$streamId", params: { streamId: id } });
    }
  };

  return (
    <div className="flex gap-3 mb-6">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleOpen()}
        placeholder="Enter stream ID..."
        className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
      />
      <button
        onClick={handleOpen}
        className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
      >
        Open Stream
      </button>
    </div>
  );
}
