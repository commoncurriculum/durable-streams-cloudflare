import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/streams")({
  component: StreamsLayout,
});

function StreamsLayout() {
  return <Outlet />;
}
