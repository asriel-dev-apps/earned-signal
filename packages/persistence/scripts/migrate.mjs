import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
const environment = process.env.DEPLOY_ENV;
const expectedHost = process.env.EXPECTED_DATABASE_HOST;
const expectedDatabase = process.env.EXPECTED_DATABASE_NAME;
const VECTA_MIGRATION_LOCK = [1_169_796_931, 1_761_609_076];

if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required");
}
if (environment !== "staging" && environment !== "production") {
  throw new Error("DEPLOY_ENV must be staging or production");
}
if (expectedHost === undefined || expectedHost.length === 0) {
  throw new Error("EXPECTED_DATABASE_HOST is required");
}
if (expectedDatabase === undefined || expectedDatabase.length === 0) {
  throw new Error("EXPECTED_DATABASE_NAME is required");
}

const target = new URL(connectionString);
const databaseName = decodeURIComponent(target.pathname.replace(/^\//u, ""));
if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
  throw new Error("DATABASE_URL must use PostgreSQL");
}
if (target.hostname !== expectedHost || databaseName !== expectedDatabase) {
  throw new Error("DATABASE_URL does not match the confirmed database target");
}

const client = new pg.Client({ connectionString });
let locked = false;

try {
  await client.connect();
  const lock = await client.query({
    text: "select pg_try_advisory_lock($1, $2) as acquired",
    values: VECTA_MIGRATION_LOCK,
  });
  locked = lock.rows[0]?.acquired === true;
  if (!locked) throw new Error("Another VECTA migration is already running");
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  console.log(JSON.stringify({ event: "database_migrations_complete", environment }));
} finally {
  try {
    if (locked) {
      await client.query({
        text: "select pg_advisory_unlock($1, $2)",
        values: VECTA_MIGRATION_LOCK,
      });
    }
  } finally {
    await client.end();
  }
}
