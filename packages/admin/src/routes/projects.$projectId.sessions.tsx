import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/sessions")({
  component: SessionsLayout,
});

function SessionsLayout() {
  return <Outlet />;
}
