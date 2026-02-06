import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/subscriptions")({
  component: SubscriptionsLayout,
});

function SubscriptionsLayout() {
  return <Outlet />;
}
