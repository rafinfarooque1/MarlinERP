import { pool } from "@workspace/db";
import { backfillHistoricalElectronicClearing } from "./historicalElectronicClearing";

async function main(): Promise<void> {
  if (process.env.ELECTRONIC_CLEARING_MIGRATION_TARGET !== "development") {
    throw new Error(
      "Refusing to run: set ELECTRONIC_CLEARING_MIGRATION_TARGET=development explicitly.",
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run with NODE_ENV=production.");
  }

  const { rows: [database] } = await pool.query(
    `SELECT current_database() AS database_name`,
  );
  console.log(
    `[migration] target=development database=${String(database?.database_name ?? "unknown")}`,
  );
  await backfillHistoricalElectronicClearing(pool);
}

main()
  .catch((error) => {
    console.error("[migration] historical electronic clearing failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());