/**
 * In-memory SQLite adapter for unit tests using sql.js (WASM).
 *
 * Returns an object matching Cloudflare's SqlStorage.exec() contract:
 * exec(query, ...bindings) returns an iterable of rows with named properties.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — sql.js has no bundled type declarations
import initSqlJs from "sql.js";

export async function createTestSqlStorage() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  return {
    exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
      const stmt = db.prepare(query);
      stmt.bind(bindings.length > 0 ? bindings : undefined);

      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        rows.push(row);
      }
      stmt.free();
      return rows;
    },
  };
}
