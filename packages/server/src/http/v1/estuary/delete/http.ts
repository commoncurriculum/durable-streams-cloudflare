import type { BaseEnv } from "../../../router";
import { deleteEstuary } from "./index";

/**
 * HTTP wrapper for DELETE /v1/estuary/:estuaryId
 */
// biome-ignore lint: Hono context typing is complex; handlers are wired through the router
export async function deleteEstuaryHttp(c: any): Promise<Response> {
  const projectId = c.get("projectId");
  const estuaryId = c.get("estuaryId");

  const result = await deleteEstuary(c.env as BaseEnv, {
    projectId,
    estuaryId,
  });

  return c.json(result);
}
