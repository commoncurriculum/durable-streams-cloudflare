import { isValidEstuaryId, DEFAULT_ESTUARY_TTL_SECONDS } from "../../../constants";
import { logError } from "../../../log";
import { createMetrics } from "../../../metrics";
import { putStreamMetadata } from "../../../storage/registry";

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
  
  try {
    // 1. Get stream metadata
    const doKey = `${projectId}/${estuaryId}`;
    const streamStub = c.env.STREAMS.get(c.env.STREAMS.idFromName(doKey));
    const meta = await streamStub.getStream(estuaryId);
    
    if (!meta) {
      return c.json({ error: "Estuary not found" }, 404);
    }

    // 2. Get subscriptions from EstuaryDO
    const estuaryStub = c.env.ESTUARY_DO.get(c.env.ESTUARY_DO.idFromName(doKey));
    const streamIds = await estuaryStub.getSubscriptions();
    const subscriptions = streamIds.map((streamId: string) => ({ streamId }));

    return c.json({
      estuaryId,
      estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
      subscriptions,
      contentType: meta.content_type,
    });
  } catch (err) {
    logError({ projectId, estuaryId, component: "get-estuary" }, "get estuary failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to get estuary" }, 500);
  }
}

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function touchEstuary(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const estuaryId = c.get("estuaryId");
  
  if (!estuaryId || !isValidEstuaryId(estuaryId)) {
    return c.json({ error: "Invalid estuaryId format" }, 400);
  }
  
  try {
    const start = Date.now();
    const parsed = c.env.ESTUARY_TTL_SECONDS
      ? Number.parseInt(c.env.ESTUARY_TTL_SECONDS, 10)
      : undefined;
    const ttlSeconds = parsed !== undefined && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ESTUARY_TTL_SECONDS;
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const contentType = "application/json"; // Default for estuary streams

    // 1. Create/touch estuary stream
    const doKey = `${projectId}/${estuaryId}`;
    const streamStub = c.env.STREAMS.get(c.env.STREAMS.idFromName(doKey));
    
    const putRequest = new Request(`https://do/v1/stream/${doKey}`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: JSON.stringify({ expiresAt }),
    });
    const putResponse = await streamStub.routeStreamRequest(doKey, false, putRequest);
    
    // Write stream metadata to REGISTRY on creation
    if (putResponse.status === 201 && c.env.REGISTRY) {
      await putStreamMetadata(c.env.REGISTRY, doKey, {
        public: false,
        content_type: contentType,
      });
    }

    // 2. Reset expiry alarm on EstuaryDO
    const estuaryStub = c.env.ESTUARY_DO.get(c.env.ESTUARY_DO.idFromName(doKey));
    await estuaryStub.setExpiry(projectId, estuaryId, ttlSeconds);

    // 3. Metrics
    createMetrics(c.env.METRICS).estuaryTouch(estuaryId, Date.now() - start);

    return c.json({ estuaryId, expiresAt });
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
    const start = Date.now();
    const doKey = `${projectId}/${estuaryId}`;
    
    // Delete the estuary stream
    const streamStub = c.env.STREAMS.get(c.env.STREAMS.idFromName(doKey));
    const deleteRequest = new Request(`https://do/v1/stream/${doKey}`, { method: "DELETE" });
    await streamStub.routeStreamRequest(doKey, false, deleteRequest);

    // Metrics
    createMetrics(c.env.METRICS).estuaryDelete(estuaryId, Date.now() - start);

    return c.json({ estuaryId, deleted: true });
  } catch (err) {
    logError({ projectId, estuaryId, component: "delete-estuary" }, "delete estuary failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to delete estuary stream" }, 500);
  }
}
