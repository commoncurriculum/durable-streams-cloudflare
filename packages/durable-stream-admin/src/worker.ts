import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamsRoutes } from "./routes/streams";
import { metricsRoutes } from "./routes/metrics";
import { healthRoutes } from "./routes/health";

export interface Env {
  ADMIN_DB: D1Database;
  CORE_URL: string;
  AUTH_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  METRICS_API_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Optional bearer auth middleware
app.use("*", async (c, next) => {
  const expectedToken = c.env.AUTH_TOKEN;
  if (!expectedToken) {
    return next();
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== expectedToken) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

// Mount routes
app.route("/api", streamsRoutes);
app.route("/api", metricsRoutes);
app.route("/", healthRoutes);

// Catch-all
app.all("*", (c) => {
  return c.json({ error: "Not found" }, 404);
});

export default {
  fetch: app.fetch,
};
