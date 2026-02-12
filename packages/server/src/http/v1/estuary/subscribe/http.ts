import { type } from "arktype";
import type { BaseEnv } from "../../../router";
import { subscribeToStream } from "./index";
import { isValidEstuaryId } from "../../../../constants";
import type { SubscribeResult } from "../types";

// ============================================================================
// Validation Schema
// ============================================================================

export const subscribeRequestSchema = type({
  estuaryId: type("string > 0").pipe((s, ctx) => {
    if (!isValidEstuaryId(s)) return ctx.error("Invalid estuaryId format");
    return s;
  }),
});

// ============================================================================
// HTTP Handler
// ============================================================================

/**
 * HTTP wrapper for POST /v1/estuary/subscribe/:streamId
 */
// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function subscribeHttp(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const streamId = c.get("streamId");
  const { estuaryId } = c.req.valid("json");

  const data: SubscribeResult = await subscribeToStream(c.env as BaseEnv, {
    projectId,
    streamId,
    estuaryId,
  });

  return c.json(data);
}
