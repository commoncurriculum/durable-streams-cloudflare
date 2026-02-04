import { z } from "zod";

export const subscribeBodySchema = z.object({
  sessionId: z.string().min(1, "sessionId is required"),
  streamId: z.string().min(1, "streamId is required"),
});

export type SubscribeBody = z.infer<typeof subscribeBodySchema>;

export const sessionIdParamSchema = z.object({
  sessionId: z.string().min(1),
});

export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string(),
});

export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const listSubscriptionsResponseSchema = z.array(z.string());

export type ListSubscriptionsResponse = z.infer<typeof listSubscriptionsResponseSchema>;
