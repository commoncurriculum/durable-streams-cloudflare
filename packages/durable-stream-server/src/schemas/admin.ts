import { z } from "zod";

export const serviceStatusSchema = z.object({
  available: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  timestamp: z.number(),
  version: z.string().optional(),
  services: z
    .object({
      registry: serviceStatusSchema.optional(),
      d1: serviceStatusSchema.optional(),
      r2: serviceStatusSchema.optional(),
    })
    .optional(),
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

export const streamDetailSchema = streamInfoSchema.extend({
  segmentCount: z.number().optional(),
  totalBytes: z.number().optional(),
  subscriberCount: z.number().optional(),
});

export type StreamDetail = z.infer<typeof streamDetailSchema>;

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

export const segmentInfoSchema = z.object({
  streamId: z.string(),
  readSeq: z.number(),
  startOffset: z.number(),
  endOffset: z.number(),
  r2Key: z.string(),
  contentType: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  sizeBytes: z.number(),
  messageCount: z.number(),
});

export type SegmentInfo = z.infer<typeof segmentInfoSchema>;

export const listSegmentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  after: z.coerce.number().int().optional(),
});

export type ListSegmentsQuery = z.infer<typeof listSegmentsQuerySchema>;

export const listSegmentsResponseSchema = z.object({
  segments: z.array(segmentInfoSchema),
  nextCursor: z.number().optional(),
  hasMore: z.boolean(),
});

export type ListSegmentsResponse = z.infer<typeof listSegmentsResponseSchema>;

export const sessionInfoSchema = z.object({
  sessionId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  subscriptionCount: z.number(),
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const sessionDetailSchema = sessionInfoSchema.extend({
  subscribedStreams: z.array(z.string()).optional(),
});

export type SessionDetail = z.infer<typeof sessionDetailSchema>;

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
