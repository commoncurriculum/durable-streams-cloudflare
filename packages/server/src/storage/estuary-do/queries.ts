/**
 * EstuaryDO storage queries using Drizzle ORM
 *
 * This module provides the EstuaryStorage implementation using Drizzle ORM
 * for type-safe SQLite operations within the EstuaryDO Durable Object.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq } from "drizzle-orm";
import { subscriptions, estuaryInfo } from "./schema";
import type { EstuaryStorage } from "./types";

type SqlStorage = DurableObjectStorage["sql"];

/**
 * EstuaryDO storage implementation using Drizzle ORM
 */
export class EstuaryDoStorage implements EstuaryStorage {
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
      CREATE TABLE IF NOT EXISTS subscriptions (
        stream_id TEXT PRIMARY KEY,
        subscribed_at INTEGER NOT NULL
      );
    `);
    this.sql.exec("DROP TABLE IF EXISTS session_info");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS estuary_info (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project TEXT NOT NULL,
        estuary_id TEXT NOT NULL
      );
    `);
  }

  // ============================================================================
  // Estuary Info Operations
  // ============================================================================

  async setEstuaryInfo(project: string, estuaryId: string): Promise<void> {
    // Use INSERT ... ON CONFLICT via raw SQL since Drizzle's onConflictDoUpdate
    // requires explicit conflict target, which is verbose for CHECK constraint
    this.sql.exec(
      `INSERT INTO estuary_info (id, project, estuary_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, estuary_id = excluded.estuary_id`,
      project,
      estuaryId
    );
  }

  async getEstuaryInfo(): Promise<{
    project: string;
    estuary_id: string;
  } | null> {
    const result = await this.db
      .select()
      .from(estuaryInfo)
      .where(eq(estuaryInfo.id, 1))
      .limit(1);

    if (result.length === 0) return null;

    return {
      project: result[0].project,
      estuary_id: result[0].estuaryId,
    };
  }

  // ============================================================================
  // Subscription Operations
  // ============================================================================

  async addSubscription(streamId: string, timestamp: number): Promise<void> {
    // Use INSERT ... ON CONFLICT DO NOTHING via raw SQL
    // Drizzle's onConflictDoNothing() doesn't support conditional logic easily
    this.sql.exec(
      `INSERT INTO subscriptions (stream_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      streamId,
      timestamp
    );
  }

  async removeSubscription(streamId: string): Promise<void> {
    await this.db
      .delete(subscriptions)
      .where(eq(subscriptions.streamId, streamId));
  }

  async getSubscriptions(): Promise<string[]> {
    const result = await this.db
      .select({ streamId: subscriptions.streamId })
      .from(subscriptions)
      .orderBy(subscriptions.subscribedAt);

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
