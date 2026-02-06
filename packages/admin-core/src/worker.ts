import { Hono } from "hono";
import type { AdminEnv } from "./types";
import { handleStats, handleStreamList, handleHotStreams, handleTimeseries } from "./routes/overview";
import { handleStreamInspect } from "./routes/inspect";
import { handleTest } from "./routes/test";
import { renderAdminPage } from "./ui/page";

const app = new Hono<{ Bindings: AdminEnv }>();

app.get("/", (c) => {
  const corePublicUrl = c.env.CORE_PUBLIC_URL ?? "";
  return c.html(renderAdminPage({ corePublicUrl }));
});

app.get("/api/stats", handleStats);
app.get("/api/streams", handleStreamList);
app.get("/api/hot", handleHotStreams);
app.get("/api/timeseries", handleTimeseries);
app.get("/api/stream/:id", handleStreamInspect);
app.post("/api/test", handleTest);

export default app;
