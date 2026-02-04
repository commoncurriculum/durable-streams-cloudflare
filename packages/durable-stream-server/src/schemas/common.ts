import { z } from "zod";

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
  });

export const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
