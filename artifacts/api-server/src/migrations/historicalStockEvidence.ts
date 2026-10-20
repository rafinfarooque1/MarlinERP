import type { PgPool as Pool } from "@workspace/db";

export async function addHistoricalStockEvidence(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["historical_stock_evidence_v1"]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS historical_stock_evidence (
        id BIGSERIAL PRIMARY KEY,
        effective_date DATE NOT NULL UNIQUE,
        source_document TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        approved_by TEXT,
        approved_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS historical_stock_evidence_lines (
        evidence_id BIGINT NOT NULL REFERENCES historical_stock_evidence(id) ON DELETE RESTRICT,
        material_type TEXT NOT NULL CHECK (material_type IN ('item','material','raw_material')),
        ref_id INTEGER NOT NULL CHECK (ref_id > 0),
        branch_type TEXT NOT NULL CHECK (branch_type IN ('headoffice','warehouse','outlet')),
        branch_id INTEGER NOT NULL CHECK (branch_id >= 0),
        quantity NUMERIC(14,4) NOT NULL CHECK (quantity >= 0),
        unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
        value NUMERIC(18,4) NOT NULL CHECK (value >= 0),
        PRIMARY KEY (evidence_id, material_type, ref_id, branch_type, branch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_historical_stock_evidence_date_status
        ON historical_stock_evidence(effective_date, status);
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
