import type { BaseEnv } from "../../../router";
import { touchEstuary } from "./index";
import type { TouchEstuaryResult } from "../types";

/**
 * HTTP wrapper for POST /v1/estuary/:estuaryId
 */
// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function touchEstuaryHttp(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const estuaryId = c.get("estuaryId");

  const data: TouchEstuaryResult = await touchEstuary(c.env as BaseEnv, {
    projectId,
    estuaryId,
  });

  return c.json(data);
}
