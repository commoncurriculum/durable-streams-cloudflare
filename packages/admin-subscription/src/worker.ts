import { Hono } from "hono";
import type { AdminSubscriptionEnv } from "./types";
import { handleStats, handleSessions, handleStreams, handleHotStreams, handleTimeseries } from "./routes/overview";
import { handleSessionInspect, handleStreamInspect } from "./routes/inspect";
import { handleTest } from "./routes/test";
import { renderAdminPage } from "./ui/page";

const app = new Hono<{ Bindings: AdminSubscriptionEnv }>();

app.get("/", (c) => {
  const corePublicUrl = c.env.CORE_PUBLIC_URL ?? "";
  const subscriptionPublicUrl = c.env.SUBSCRIPTION_PUBLIC_URL ?? "";
  return c.html(renderAdminPage({ corePublicUrl, subscriptionPublicUrl }));
});

app.get("/api/stats", handleStats);
app.get("/api/sessions", handleSessions);
app.get("/api/streams", handleStreams);
app.get("/api/hot", handleHotStreams);
app.get("/api/timeseries", handleTimeseries);

app.get("/api/session/:id", handleSessionInspect);
app.get("/api/stream/:id", handleStreamInspect);

app.post("/api/test", handleTest);

export default app;
