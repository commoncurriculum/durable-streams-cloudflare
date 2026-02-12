/**
 * Drizzle ORM schema for EstuaryDO
 *
 * Tables:
 * - subscriptions: Tracks which source streams this estuary subscribes to (reverse lookup)
 * - estuary_info: Metadata about the estuary (project, ID)
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-arktype";

/**
 * subscriptions: Tracks source streams this estuary subscribes to
 */
export const subscriptions = sqliteTable("subscriptions", {
  stream_id: text("stream_id").primaryKey(),
  subscribed_at: integer("subscribed_at").notNull(),
});

/**
 * estuary_info: Metadata about this estuary
 * Always has exactly one row with id = 1
 */
export const estuaryInfo = sqliteTable("estuary_info", {
  id: integer("id")
    .primaryKey()
    .$default(() => 1),
  project: text("project").notNull(),
  estuary_id: text("estuary_id").notNull(),
});

// ArkType schemas for validation
export const subscriptionSelectSchema = createSelectSchema(subscriptions);
export const subscriptionInsertSchema = createInsertSchema(subscriptions);

export const estuaryInfoSelectSchema = createSelectSchema(estuaryInfo);
export const estuaryInfoInsertSchema = createInsertSchema(estuaryInfo);

// Type exports for use in queries
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionInsert = typeof subscriptions.$inferInsert;

export type EstuaryInfo = typeof estuaryInfo.$inferSelect;
export type EstuaryInfoInsert = typeof estuaryInfo.$inferInsert;
