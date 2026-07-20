import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { schema } from "./schema.js";

/**
 * The Drizzle database the Repository adapters run against. Both persistence
 * drivers resolve to this type: the Hyperdrive/pg path builds it from a `pg`
 * client, and the Neon serverless path drives a WebSocket Pool through the same
 * node-postgres driver (see `neon-database.ts`), so callers can select a driver
 * at runtime without changing the adapters.
 */
export type PersistenceDatabase = NodePgDatabase<typeof schema>;
