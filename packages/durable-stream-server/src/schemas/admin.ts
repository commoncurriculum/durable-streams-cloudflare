import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  timestamp: z.number(),
  version: z.string().optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const streamInfoSchema = z.object({
  streamId: z.string(),
  contentType: z.string(),
  closed: z.boolean(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  messageCount: z.number().optional(),
  byteSize: z.number().optional(),
});

export type StreamInfo = z.infer<typeof streamInfoSchema>;

export const listStreamsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  cursor: z.string().optional(),
  prefix: z.string().optional(),
});

export type ListStreamsQuery = z.infer<typeof listStreamsQuerySchema>;

export const listStreamsResponseSchema = z.object({
  streams: z.array(streamInfoSchema),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
});

export type ListStreamsResponse = z.infer<typeof listStreamsResponseSchema>;

export const sessionInfoSchema = z.object({
  sessionId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  subscriptionCount: z.number(),
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  cursor: z.string().optional(),
});

export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionInfoSchema),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
});

export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const streamIdParamSchema = z.object({
  streamId: z.string().min(1),
});

export type StreamIdParam = z.infer<typeof streamIdParamSchema>;
