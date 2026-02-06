// #region docs-error-response
import { baseHeaders } from "./headers";

export function errorResponse(status: number, message: string): Response {
  const headers = baseHeaders({ "Cache-Control": "no-store" });
  return new Response(message, { status, headers });
}
// #endregion docs-error-response
