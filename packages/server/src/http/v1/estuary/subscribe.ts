import { type } from "arktype";
import { isValidEstuaryId, DEFAULT_ESTUARY_TTL_SECONDS } from "../../../constants";
import { logError } from "../../../log";
import { createMetrics } from "../../../metrics";
import { putStreamMetadata } from "../../../storage/registry";
import { handlePut } from "../streams/create";
import { handleDelete } from "../streams/delete";

// ============================================================================
// Validation schemas
// ============================================================================

export const subscribeBodySchema = type({
  estuaryId: type("string > 0").pipe((s, ctx) => {
    if (!isValidEstuaryId(s)) return ctx.error("Invalid estuaryId format");
    return s;
  }),
  "contentType?": "string",
});

export const unsubscribeBodySchema = type({
  estuaryId: type("string > 0").pipe((s, ctx) => {
    if (!isValidEstuaryId(s)) return ctx.error("Invalid estuaryId format");
    return s;
  }),
});

// ============================================================================
// Handlers
// ============================================================================

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function subscribe(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const streamId = c.get("streamId");
  const { estuaryId } = c.req.valid("json");
  
  const start = Date.now();
  const metrics = createMetrics(c.env.METRICS);
  
  try {
    // Parse TTL
    const parsed = c.env.ESTUARY_TTL_SECONDS
      ? Number.parseInt(c.env.ESTUARY_TTL_SECONDS, 10)
      : undefined;
    const ttlSeconds = parsed !== undefined && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ESTUARY_TTL_SECONDS;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    // 1. Check source stream exists and get content type
    const sourceDoKey = `${projectId}/${streamId}`;
    const sourceStub = c.env.STREAMS.get(c.env.STREAMS.idFromName(sourceDoKey));
    const sourceMeta = await sourceStub.getStream(streamId);
    if (!sourceMeta) {
      return c.json({ error: `Source stream not found: ${sourceDoKey}` }, 404);
    }
    const contentType = sourceMeta.content_type;

    // 2. Create/touch estuary stream with same content type
    const estuaryDoKey = `${projectId}/${estuaryId}`;
    const estuaryStub = c.env.STREAMS.get(c.env.STREAMS.idFromName(estuaryDoKey));
    
    // Call handlePut directly via the stub's fetch (HTTP interface)
    const putRequest = new Request(`https://do/v1/stream/${estuaryDoKey}`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: JSON.stringify({ expiresAt }),
    });
    const putResponse = await estuaryStub.routeStreamRequest(estuaryDoKey, false, putRequest);
    
    const isNewEstuary = putResponse.status === 201;
    
    // Write stream metadata to REGISTRY on creation
    if (isNewEstuary && c.env.REGISTRY) {
      await putStreamMetadata(c.env.REGISTRY, estuaryDoKey, {
        public: false,
        content_type: contentType,
      });
    }

    // If estuary already exists, verify content type matches
    if (!isNewEstuary) {
      const estuaryMeta = await estuaryStub.getStream(estuaryId);
      if (estuaryMeta && estuaryMeta.content_type !== contentType) {
        return c.json({
          error: `Content type mismatch: estuary stream is ${estuaryMeta.content_type} but source stream ${streamId} is ${contentType}. An estuary can only subscribe to streams of the same content type.`,
        }, 409);
      }
    }

    // 3. Add subscription to SubscriptionDO
    const subStub = c.env.SUBSCRIPTION_DO.get(c.env.SUBSCRIPTION_DO.idFromName(sourceDoKey));
    try {
      await subStub.addSubscriber(estuaryId);
    } catch (err) {
      // Rollback estuary if we just created it
      if (isNewEstuary) {
        try {
          const deleteRequest = new Request(`https://do/v1/stream/${estuaryDoKey}`, { method: "DELETE" });
          await estuaryStub.routeStreamRequest(estuaryDoKey, false, deleteRequest);
        } catch (rollbackErr) {
          logError({ projectId, streamId, estuaryId, component: "subscribe-rollback" }, "failed to rollback estuary stream", rollbackErr);
        }
      }
      throw err;
    }

    // 4. Track subscription on EstuaryDO and set expiry
    const estuaryDOStub = c.env.ESTUARY_DO.get(c.env.ESTUARY_DO.idFromName(`${projectId}/${estuaryId}`));
    await estuaryDOStub.addSubscription(streamId);
    await estuaryDOStub.setExpiry(projectId, estuaryId, ttlSeconds);

    // 5. Metrics
    const latencyMs = Date.now() - start;
    metrics.subscribe(streamId, estuaryId, isNewEstuary, latencyMs);
    if (isNewEstuary) {
      metrics.estuaryCreate(estuaryId, projectId, ttlSeconds, latencyMs);
    }

    return c.json({
      estuaryId,
      streamId,
      estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
      expiresAt,
      isNewEstuary,
    });
  } catch (err) {
    logError({ projectId, streamId, estuaryId, component: "subscribe" }, "subscribe failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to subscribe" }, 500);
  }
}

// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function unsubscribe(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const streamId = c.get("streamId");
  const { estuaryId } = c.req.valid("json");
  
  const metrics = createMetrics(c.env.METRICS);
  
  try {
    // 1. Remove subscription from SubscriptionDO
    const sourceDoKey = `${projectId}/${streamId}`;
    const subStub = c.env.SUBSCRIPTION_DO.get(c.env.SUBSCRIPTION_DO.idFromName(sourceDoKey));
    await subStub.removeSubscriber(estuaryId);

    // 2. Remove subscription tracking from EstuaryDO
    const estuaryDOStub = c.env.ESTUARY_DO.get(c.env.ESTUARY_DO.idFromName(`${projectId}/${estuaryId}`));
    await estuaryDOStub.removeSubscription(streamId);

    // 3. Metrics
    metrics.unsubscribe(streamId, estuaryId);

    return c.json({ success: true });
  } catch (err) {
    logError({ projectId, streamId, estuaryId, component: "unsubscribe" }, "unsubscribe failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Failed to remove subscription" }, 500);
  }
}
