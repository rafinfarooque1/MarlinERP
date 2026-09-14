import crypto from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * Creates a disposable level-1 development test user when the caller has not
 * supplied an explicit TEST_USERNAME/TEST_PASSWORD pair. This keeps test
 * suites independent of seeded admin passwords and never weakens application
 * authentication.
 */
export async function createTestAdmin(pool, tag = "ZZTEST") {
  if (process.env.TEST_USERNAME && process.env.TEST_PASSWORD) {
    return {
      username: process.env.TEST_USERNAME,
      password: process.env.TEST_PASSWORD,
      cleanup: async () => {},
    };
  }

  const suffix = `${process.pid}_${crypto.randomBytes(6).toString("hex")}`;
  const username = `${tag.toLowerCase()}_${suffix}`;
  const password = `fixture-${crypto.randomBytes(18).toString("base64url")}`;
  const cleanup = async () => {
    await pool.query(`DELETE FROM login_lockouts WHERE username = $1`, [username]).catch(() => {});
    await pool.query(`DELETE FROM login_attempts WHERE username = $1`, [username]).catch(() => {});
    await pool.query(`DELETE FROM employees WHERE username = $1`, [username]).catch(() => {});
  };

  await cleanup();
  const { rows: [root] } = await pool.query(
    `SELECT id FROM hierarchies WHERE level = 1 ORDER BY id LIMIT 1`,
  );
  if (!root) throw new Error("No level-1 hierarchy is available for the test fixture user");

  await pool.query(
    `INSERT INTO employees
       (name, username, password_hash, hierarchy_id, branch_type, branch_id,
        salary, join_date, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, 'headoffice', 0, 0, CURRENT_DATE, true, false)`,
    [`${tag} Admin Fixture`, username, bcrypt.hashSync(password, 10), Number(root.id)],
  );

  return { username, password, cleanup };
}