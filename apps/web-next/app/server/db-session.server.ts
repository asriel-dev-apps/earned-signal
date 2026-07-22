import {
  openNeonPersistenceConnection,
  type NeonPersistenceConnection,
  type PersistenceDatabase,
} from "@vecta/persistence";

/**
 * A per-request, lazily-opened, memoised database session (ADR 0012 §4-pre).
 *
 * `openNeonPersistenceConnection` is the WebSocket-Pool driver: each open is a
 * WS handshake. Web-next previously opened+closed a Pool *per call*, so an SSR
 * request that reads the principal, then the project row, then the workspace
 * would pay three sequential handshakes. This session opens at most ONE
 * connection per request — lazily, on the first `database()` call — memoises it
 * for every subsequent read, and closes it deterministically after the response
 * (the root middleware owns the lifecycle via `close()` in a `finally`).
 *
 * A request that never touches the DB (e.g. `/login`) never calls `database()`,
 * so it opens nothing and `close()` is a no-op.
 */
export interface DbSession {
  /** Open (on first call) and return the shared connection's database handle. */
  database(): PersistenceDatabase;
  /** Close the underlying connection if it was opened; otherwise a no-op. */
  close(): Promise<void>;
}

/**
 * Build a {@link DbSession} for the current request. Validates `DATABASE_URL`
 * eagerly (as the former env-based readers did) so a misconfigured environment
 * fails with a clear error rather than deep inside a query; the actual
 * connection is still opened lazily on first use. `open` is injectable so tests
 * can spy the opener without a real Neon connection.
 */
export function createDbSession(
  env: Env,
  open: (connectionString: string) => NeonPersistenceConnection =
    openNeonPersistenceConnection,
): DbSession {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not configured for the database session");
  }
  let connection: NeonPersistenceConnection | undefined;
  return {
    database() {
      connection ??= open(databaseUrl);
      return connection.database;
    },
    async close() {
      if (connection === undefined) {
        return;
      }
      // Never let a close failure mask the original request error.
      await connection.close().catch(() => undefined);
    },
  };
}
