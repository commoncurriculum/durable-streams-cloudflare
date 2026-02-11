import { Hono } from "hono";
import { getEstuary, touchEstuary, deleteEstuary } from "../../../estuary";
import { logError } from "../../../log";
import { isValidEstuaryId } from "../../../constants";
import type { BaseEnv } from "../../index";

export const estuaryRoutes = new Hono<{ Bindings: BaseEnv }>();

estuaryRoutes.get("/:projectId/:estuaryId", async (c) => {
  const projectId = c.req.param("projectId");
  const estuaryId = c.req.param("estuaryId");
  if (!isValidEstuaryId(estuaryId)) {
    return c.json({ error: "Invalid estuaryId format" }, 400);
  }
  const estuary = await getEstuary(c.env, projectId, estuaryId);
  if (!estuary) return c.json({ error: "Estuary not found" }, 404);
  return c.json(estuary);
});

estuaryRoutes.post("/:projectId/:estuaryId", async (c) => {
  const projectId = c.req.param("projectId");
  const estuaryId = c.req.param("estuaryId");
  if (!isValidEstuaryId(estuaryId)) {
    return c.json({ error: "Invalid estuaryId format" }, 400);
  }
  try {
    return c.json(await touchEstuary(c.env, projectId, estuaryId));
  } catch (err) {
    logError({ projectId, estuaryId, component: "touch-estuary" }, "touch estuary failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to touch estuary" }, 500);
  }
});

estuaryRoutes.delete("/:projectId/:estuaryId", async (c) => {
  const projectId = c.req.param("projectId");
  const estuaryId = c.req.param("estuaryId");
  if (!isValidEstuaryId(estuaryId)) {
    return c.json({ error: "Invalid estuaryId format" }, 400);
  }
  try {
    return c.json(await deleteEstuary(c.env, projectId, estuaryId));
  } catch (err) {
    logError({ projectId, estuaryId, component: "delete-estuary" }, "delete estuary failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to delete estuary stream" }, 500);
  }
});
