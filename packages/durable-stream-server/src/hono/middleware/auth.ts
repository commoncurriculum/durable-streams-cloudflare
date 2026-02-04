import { createMiddleware } from "hono/factory";
import type { EdgeBindings } from "../types";

export const bearerAuthMiddleware = createMiddleware<EdgeBindings>(async (c, next) => {
  const authToken = c.env.AUTH_TOKEN;

  if (!authToken) {
    return await next();
  }

  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${authToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  return await next();
});
