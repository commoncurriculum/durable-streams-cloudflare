import type { Context } from "hono";
import type { AdminSubscriptionEnv } from "../types";
import { queryAnalytics, QUERIES } from "../analytics";

export async function handleStats(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const [stats, fanout] = await Promise.all([
    queryAnalytics(c.env, QUERIES.systemStats),
    queryAnalytics(c.env, QUERIES.fanoutStats),
  ]);
  return c.json({ stats, fanout });
}

export async function handleSessions(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const rows = await queryAnalytics(c.env, QUERIES.activeSessions);
  return c.json(rows);
}

export async function handleStreams(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const rows = await queryAnalytics(c.env, QUERIES.activeStreams);
  return c.json(rows);
}

export async function handleHotStreams(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const rows = await queryAnalytics(c.env, QUERIES.hotStreams(Math.min(limit, 100)));
  return c.json(rows);
}

export async function handleTimeseries(c: Context<{ Bindings: AdminSubscriptionEnv }>) {
  const window = Number.parseInt(c.req.query("window") ?? "60", 10);
  const rows = await queryAnalytics(c.env, QUERIES.timeseries(Math.min(window, 1440)));
  return c.json(rows);
}
