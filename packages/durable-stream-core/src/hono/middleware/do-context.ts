import { createMiddleware } from "hono/factory";
import type { StreamContext } from "../../http/context";
import type { DoBindings } from "../types";

export function createDoContextMiddleware(ctx: StreamContext, streamId: string) {
  return createMiddleware<DoBindings>(async (c, next) => {
    c.set("ctx", ctx);
    c.set("streamId", streamId);
    return next();
  });
}
