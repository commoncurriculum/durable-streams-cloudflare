/**
 * StreamSubscribersDO storage queries using Drizzle ORM
 *
 * This module provides the StreamSubscribersStorage implementation using Drizzle ORM
 * for type-safe SQLite operations within the StreamSubscribersDO Durable Object.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../../drizzle/migrations";
import { subscribers, fanoutState } from "./schema";
import type {
  StreamSubscribersStorage,
  SubscriberWithTimestamp,
} from "./types";

/**
 * StreamSubscribersDO storage implementation using Drizzle ORM
 */
export class StreamSubscribersDoStorage implements StreamSubscribersStorage {
  private db: ReturnType<typeof drizzle>;
  private sql: DurableObjectStorage["sql"];

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
    this.sql = storage.sql;
  }

  /**
   * Initialize database schema using Drizzle migrations
   * Must be called during DO construction within blockConcurrencyWhile
   */
  initSchema(): void {
    migrate(this.db, migrations);
  }

  // ============================================================================
  // Subscriber Operations
  // ============================================================================

  async addSubscriber(estuaryId: string, timestamp: number): Promise<void> {
    await this.db
      .insert(subscribers)
      .values({
        estuary_id: estuaryId,
        subscribed_at: timestamp,
      })
      .onConflictDoNothing();
  }

  async removeSubscriber(estuaryId: string): Promise<void> {
    await this.db
      .delete(subscribers)
      .where(eq(subscribers.estuary_id, estuaryId));
  }

  async removeSubscribers(estuaryIds: string[]): Promise<void> {
    if (estuaryIds.length === 0) return;
    await this.db
      .delete(subscribers)
      .where(inArray(subscribers.estuary_id, estuaryIds));
  }

  async getSubscriberIds(): Promise<string[]> {
    const result = await this.db
      .select({ estuaryId: subscribers.estuary_id })
      .from(subscribers);
    return result.map((row) => row.estuaryId);
  }

  async getSubscribersWithTimestamps(): Promise<SubscriberWithTimestamp[]> {
    const result = await this.db
      .select({
        estuary_id: subscribers.estuary_id,
        subscribed_at: subscribers.subscribed_at,
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
    await this.db
      .insert(fanoutState)
      .values({
        key: "next_seq",
        value: seq,
      })
      .onConflictDoUpdate({
        target: fanoutState.key,
        set: { value: sql`excluded.value` },
      });
  }
}
