import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Return DATE columns (type OID 1082) as plain 'YYYY-MM-DD' strings instead of
// JavaScript Date objects. node-postgres default-parses DATE into a Date, which
// JSON.stringify's to an ISO timestamp ("2026-07-29T00:00:00.000Z"). The entire
// codebase treats these columns as 'YYYY-MM-DD' strings (String(x).slice(0,10)),
// so several date columns were migrated from text -> date; this parser preserves
// the historical string contract across every endpoint. Registered here, at the
// single point where the pool is created, so it is active before any query runs.
pg.types.setTypeParser(1082, (v) => v);

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
