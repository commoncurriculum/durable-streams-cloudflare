/**
 * EstuaryDO storage queries using Drizzle ORM
 *
 * This module provides the EstuaryStorage implementation using Drizzle ORM
 * for type-safe SQLite operations within the EstuaryDO Durable Object.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../../drizzle/migrations";
import { subscriptions, estuaryInfo } from "./schema";
import type { EstuaryStorage } from "./types";

/**
 * EstuaryDO storage implementation using Drizzle ORM
 */
export class EstuaryDoStorage implements EstuaryStorage {
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
    // Clean up legacy table if it exists
    this.sql.exec("DROP TABLE IF EXISTS session_info");
  }

  // ============================================================================
  // Estuary Info Operations
  // ============================================================================

  async setEstuaryInfo(project: string, estuaryId: string): Promise<void> {
    await this.db
      .insert(estuaryInfo)
      .values({
        id: 1,
        project,
        estuary_id: estuaryId,
      })
      .onConflictDoUpdate({
        target: estuaryInfo.id,
        set: {
          project: sql`excluded.project`,
          estuary_id: sql`excluded.estuary_id`,
        },
      });
  }

  async getEstuaryInfo(): Promise<{
    project: string;
    estuary_id: string;
  } | null> {
    const result = await this.db.select().from(estuaryInfo).where(eq(estuaryInfo.id, 1)).limit(1);

    if (result.length === 0) return null;

    return {
      project: result[0].project,
      estuary_id: result[0].estuary_id,
    };
  }

  // ============================================================================
  // Subscription Operations
  // ============================================================================

  async addSubscription(streamId: string, timestamp: number): Promise<void> {
    await this.db
      .insert(subscriptions)
      .values({
        stream_id: streamId,
        subscribed_at: timestamp,
      })
      .onConflictDoNothing();
  }

  async removeSubscription(streamId: string): Promise<void> {
    await this.db.delete(subscriptions).where(eq(subscriptions.stream_id, streamId));
  }

  async getSubscriptions(): Promise<string[]> {
    const result = await this.db
      .select({ streamId: subscriptions.stream_id })
      .from(subscriptions)
      .orderBy(subscriptions.subscribed_at);

    return result.map((row) => row.streamId);
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async clearData(): Promise<void> {
    await this.db.delete(subscriptions);
    await this.db.delete(estuaryInfo);
  }
}
