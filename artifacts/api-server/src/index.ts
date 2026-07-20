import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

// Run lightweight schema migrations before accepting connections
async function runMigrations() {
  await pool.query(`
    ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_from text;
    ALTER TABLE item_prices ADD COLUMN IF NOT EXISTS valid_to text;
  `);
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

(async () => {
  try {
    await runMigrations();
  } catch (err) {
    logger.warn({ err }, "Migration warning (non-fatal)");
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
})();
