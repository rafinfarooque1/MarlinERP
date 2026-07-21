import bcryptjs from 'bcryptjs';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.PRODUCTION_DATABASE_URL });

async function run() {
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;`);
  console.log('✓ must_change_password column ensured');

  const adminHash = await bcryptjs.hash('marlin1458', 12);
  const r = await pool.query(
    `UPDATE employees SET password_hash = $1, must_change_password = true
     WHERE username = 'admin' AND password_hash NOT LIKE '$2%' RETURNING id`,
    [adminHash],
  );
  console.log(`✓ Admin: ${r.rowCount} row(s) updated`);

  const { rows: plain } = await pool.query(`SELECT id, username FROM employees WHERE password_hash NOT LIKE '$2%'`);
  for (const row of plain) {
    const h = await bcryptjs.hash('marlin1458', 12);
    await pool.query(`UPDATE employees SET password_hash = $1, must_change_password = true WHERE id = $2`, [h, row.id]);
    console.log(`  ✓ Migrated ${row.username}`);
  }

  const { rows: rem } = await pool.query(`SELECT username FROM employees WHERE password_hash NOT LIKE '$2%'`);
  console.log(rem.length === 0 ? '✓ No plaintext passwords remain in Neon' : '✗ Still plaintext:', rem);

  const { rows: admin } = await pool.query(
    `SELECT id, username, LEFT(password_hash,7) AS hash_prefix, must_change_password FROM employees WHERE username='admin'`
  );
  console.log('Admin record:', admin[0]);
  await pool.end();
}
run().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
