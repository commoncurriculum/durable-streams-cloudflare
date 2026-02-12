/**
 * Drizzle ORM schema for StreamSubscribersDO
 *
 * Tables:
 * - subscribers: Tracks which estuaries subscribe to this source stream
 * - fanout_state: Stores the next fanout sequence number for queue ordering
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-arktype";

/**
 * subscribers: Tracks estuaries subscribed to this source stream
 */
export const subscribers = sqliteTable("subscribers", {
  estuaryId: text("estuary_id").primaryKey(),
  subscribedAt: integer("subscribed_at").notNull(),
});

/**
 * fanout_state: Key-value store for fanout sequence tracking
 * Used to maintain ordering when sending messages to the fanout queue
 */
export const fanoutState = sqliteTable("fanout_state", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
});

// ArkType schemas for validation
export const subscriberSelectSchema = createSelectSchema(subscribers);
export const subscriberInsertSchema = createInsertSchema(subscribers);

export const fanoutStateSelectSchema = createSelectSchema(fanoutState);
export const fanoutStateInsertSchema = createInsertSchema(fanoutState);

// Type exports for use in queries
export type Subscriber = typeof subscribers.$inferSelect;
export type SubscriberInsert = typeof subscribers.$inferInsert;

export type FanoutState = typeof fanoutState.$inferSelect;
export type FanoutStateInsert = typeof fanoutState.$inferInsert;
