import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// `pg` is a dependency of this package only, so consumers cannot import its
// types directly under pnpm's strict resolution. Re-export the ones they need.
export type { Pool as PgPool, PoolClient as PgPoolClient } from "pg";

export * from "./schema";
