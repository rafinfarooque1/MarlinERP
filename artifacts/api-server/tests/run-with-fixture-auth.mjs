import { spawn } from "node:child_process";
import process from "node:process";
import pg from "pg";
import { createTestAdmin } from "./support/testAuth.mjs";

const [testFile, ...args] = process.argv.slice(2);
if (!testFile) {
  console.error("Usage: node tests/run-with-fixture-auth.mjs tests/<suite>.test.mjs");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fixture;
try {
  fixture = await createTestAdmin(pool, "ZZAUTH");
  const child = spawn(
    process.execPath,
    [testFile, ...args],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_USERNAME: fixture.username,
        TEST_PASSWORD: fixture.password,
      },
    },
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  await fixture.cleanup();
  await pool.end();
  process.exit(exitCode);
} catch (error) {
  console.error(error);
  if (fixture) await fixture.cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
}