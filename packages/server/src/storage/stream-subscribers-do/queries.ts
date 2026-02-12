/**
 * StreamSubscribersDO storage queries using Drizzle ORM
 *
 * This module provides the StreamSubscribersStorage implementation using Drizzle ORM
 * for type-safe SQLite operations within the StreamSubscribersDO Durable Object.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, inArray } from "drizzle-orm";
import { subscribers, fanoutState } from "./schema";
import type {
  StreamSubscribersStorage,
  SubscriberWithTimestamp,
} from "./types";

type SqlStorage = DurableObjectStorage["sql"];

/**
 * StreamSubscribersDO storage implementation using Drizzle ORM
 */
export class StreamSubscribersDoStorage implements StreamSubscribersStorage {
  private db: ReturnType<typeof drizzle>;

  constructor(private sql: SqlStorage) {
    this.db = drizzle(sql);
  }

  /**
   * Initialize database schema
   * Must be called during DO construction within blockConcurrencyWhile
   */
  initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscribers (
        estuary_id TEXT PRIMARY KEY,
        subscribed_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fanout_state (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  // ============================================================================
  // Subscriber Operations
  // ============================================================================

  async addSubscriber(estuaryId: string, timestamp: number): Promise<void> {
    // Use INSERT ... ON CONFLICT DO NOTHING via raw SQL
    // Drizzle's onConflictDoNothing() would work but raw SQL is clearer here
    this.sql.exec(
      `INSERT INTO subscribers (estuary_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(estuary_id) DO NOTHING`,
      estuaryId,
      timestamp
    );
  }

  async removeSubscriber(estuaryId: string): Promise<void> {
    await this.db
      .delete(subscribers)
      .where(eq(subscribers.estuaryId, estuaryId));
  }

  async removeSubscribers(estuaryIds: string[]): Promise<void> {
    if (estuaryIds.length === 0) return;
    await this.db
      .delete(subscribers)
      .where(inArray(subscribers.estuaryId, estuaryIds));
  }

  async getSubscriberIds(): Promise<string[]> {
    const result = await this.db
      .select({ estuaryId: subscribers.estuaryId })
      .from(subscribers);
    return result.map((row) => row.estuaryId);
  }

  async getSubscribersWithTimestamps(): Promise<SubscriberWithTimestamp[]> {
    const result = await this.db
      .select({
        estuary_id: subscribers.estuaryId,
        subscribed_at: subscribers.subscribedAt,
      })
      .from(subscribers);
    return result;
  }

  // ============================================================================
  // Fanout State Operations
  // ============================================================================

  async loadFanoutSeq(): Promise<number> {
    const result = await this.db
      .select({ value: fanoutState.value })
      .from(fanoutState)
      .where(eq(fanoutState.key, "next_seq"))
      .limit(1);
    return result[0]?.value ?? 0;
  }

  async persistFanoutSeq(seq: number): Promise<void> {
    // Use INSERT ... ON CONFLICT via raw SQL for upsert pattern
    this.sql.exec(
      `INSERT INTO fanout_state (key, value) VALUES ('next_seq', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      seq
    );
  }
}
