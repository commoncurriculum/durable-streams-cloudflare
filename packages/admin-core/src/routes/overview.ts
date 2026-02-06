import type { Context } from "hono";
import type { AdminEnv } from "../types";
import { queryAnalytics, QUERIES } from "../analytics";

export async function handleStats(c: Context<{ Bindings: AdminEnv }>) {
  const rows = await queryAnalytics(c.env, QUERIES.systemStats);
  return c.json(rows);
}

export async function handleStreamList(c: Context<{ Bindings: AdminEnv }>) {
  const rows = await queryAnalytics(c.env, QUERIES.streamList);
  return c.json(rows);
}

export async function handleHotStreams(c: Context<{ Bindings: AdminEnv }>) {
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const rows = await queryAnalytics(c.env, QUERIES.hotStreams(Math.min(limit, 100)));
  return c.json(rows);
}

export async function handleTimeseries(c: Context<{ Bindings: AdminEnv }>) {
  const window = Number.parseInt(c.req.query("window") ?? "60", 10);
  const rows = await queryAnalytics(c.env, QUERIES.timeseries(Math.min(window, 1440)));
  return c.json(rows);
}
