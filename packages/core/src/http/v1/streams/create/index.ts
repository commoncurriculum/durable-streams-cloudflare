import { validateContentLength, validateBodySize } from "../shared/body";
import { extractPutInput, parsePutInput } from "./parse";
import { validatePutInput } from "./validate";
import { executePut } from "./execute";
import type { StreamContext } from "../types";

export { extractPutInput, parsePutInput } from "./parse";
export { validatePutInput } from "./validate";
export { executePut } from "./execute";

// #region docs-handle-put
export async function handlePut(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const now = Date.now();

    // 1. Extract raw input and validate content-length against original body
    const raw = await extractPutInput(streamId, request);
    const contentLengthResult = validateContentLength(
      request.headers.get("Content-Length"),
      raw.bodyBytes.length,
    );
    if (contentLengthResult.kind === "error") return contentLengthResult.response;
    const bodySizeResult = validateBodySize(raw.bodyBytes.length);
    if (bodySizeResult.kind === "error") return bodySizeResult.response;

    // 2. Parse (normalizes body, e.g. empty JSON arrays become empty bytes)
    const parsed = parsePutInput(raw, now);
    if (parsed.kind === "error") return parsed.response;

    // 3. Validate against existing stream
    const doneGetStream = ctx.timing?.start("do.getStream");
    const existing = await ctx.getStream(streamId);
    doneGetStream?.();
    const validated = validatePutInput(parsed.value, existing);
    if (validated.kind === "error") return validated.response;

    // 4. Execute
    const result = await executePut(ctx, validated.value);
    if (result.kind === "error") return result.response;

    // 5. Side effects (segment rotation)
    if (result.value.rotateSegment) {
      ctx.state.waitUntil(ctx.rotateSegment(streamId, { force: result.value.forceRotation }));
    }

    // Record metrics for stream creation
    if (ctx.env.METRICS && result.value.status === 201) {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, "create", parsed.value.producer?.id ?? "anonymous"],
        doubles: [1, parsed.value.bodyBytes.length],
      });
    }

    return new Response(null, { status: result.value.status, headers: result.value.headers });
  });
}
// #endregion docs-handle-put
