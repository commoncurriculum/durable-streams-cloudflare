import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/estuaries")({
  component: EstuariesLayout,
});

function EstuariesLayout() {
  return <Outlet />;
}
