import { getEstuary as getEstuaryInfo, touchEstuary as touchEstuaryInfo, deleteEstuary as deleteEstuaryInfo } from "../../../estuary";
import { isValidEstuaryId } from "../../../constants";
import { logError } from "../../../log";

// ============================================================================
// Handlers
// ============================================================================

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function getEstuary(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const estuaryId = c.get("estuaryId");
  if (!estuaryId || !isValidEstuaryId(estuaryId)) {
    return c.json({ error: "Invalid estuaryId format" }, 400);
  }
  const estuary = await getEstuaryInfo(c.env, projectId, estuaryId);
  if (!estuary) return c.json({ error: "Estuary not found" }, 404);
  return c.json(estuary);
}

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function touchEstuary(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const estuaryId = c.get("estuaryId");
  if (!estuaryId || !isValidEstuaryId(estuaryId)) {
    return c.json({ error: "Invalid estuaryId format" }, 400);
  }
  try {
    return c.json(await touchEstuaryInfo(c.env, projectId, estuaryId));
  } catch (err) {
    logError({ projectId, estuaryId, component: "touch-estuary" }, "touch estuary failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to touch estuary" }, 500);
  }
}

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function deleteEstuary(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const estuaryId = c.get("estuaryId");
  if (!estuaryId || !isValidEstuaryId(estuaryId)) {
    return c.json({ error: "Invalid estuaryId format" }, 400);
  }
  try {
    return c.json(await deleteEstuaryInfo(c.env, projectId, estuaryId));
  } catch (err) {
    logError({ projectId, estuaryId, component: "delete-estuary" }, "delete estuary failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to delete estuary stream" }, 500);
  }
}
