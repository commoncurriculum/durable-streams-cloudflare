import { DurableObject } from "cloudflare:workers";

// biome-ignore lint: SessionDO doesn't use env bindings
export class SessionDO extends DurableObject<Record<string, unknown>> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        stream_id TEXT PRIMARY KEY,
        subscribed_at INTEGER NOT NULL
      );
    `);
  }

  async addSubscription(streamId: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO subscriptions (stream_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      streamId,
      Date.now(),
    );
  }

  async removeSubscription(streamId: string): Promise<void> {
    this.sql.exec("DELETE FROM subscriptions WHERE stream_id = ?", streamId);
  }

  async getSubscriptions(): Promise<string[]> {
    const cursor = this.sql.exec("SELECT stream_id FROM subscriptions ORDER BY subscribed_at DESC");
    const results: string[] = [];
    for (const row of cursor) {
      results.push(row.stream_id as string);
    }
    return results;
  }
}
