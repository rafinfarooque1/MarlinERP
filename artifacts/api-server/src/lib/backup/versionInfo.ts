/**
 * Identity of the running installation: ERP version, schema fingerprint and the
 * source commit.
 *
 * This is what makes a restore an informed decision rather than a leap. An
 * archive carries the same three values, so before replacing anything the
 * administrator is told whether the backup came from the code now running, from
 * an older build, or from a different schema entirely.
 *
 * The git commit matters most in the disaster-recovery path. The brief's recovery
 * procedure starts with "clone the source code" — and the only way to know WHICH
 * revision pairs with a given database is for the archive to record it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const run = promisify(execFile);

export interface VersionInfo {
  erpVersion: string;
  databaseVersion: string;
  schemaVersion: string;
  gitCommit: string;
}

/** Cached: the commit and package version cannot change without a restart. */
let cachedErpVersion: string | null = null;
let cachedGitCommit: string | null = null;

/**
 * Walk up from the compiled server looking for the workspace package.json.
 *
 * The build output sits a variable number of directories below the repo root
 * depending on how it was compiled, so a fixed relative path would read the
 * version correctly in development and silently return "unknown" in production.
 */
export async function erpVersion(): Promise<string> {
  if (cachedErpVersion !== null) return cachedErpVersion;

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const raw = await readFile(join(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { version?: string; name?: string };
      if (parsed.version) {
        cachedErpVersion = parsed.version;
        return cachedErpVersion;
      }
    } catch {
      /* keep walking */
    }
    dir = join(dir, "..");
  }
  cachedErpVersion = "0.0.0";
  return cachedErpVersion;
}

/**
 * Short commit hash, or "" when the source is not a git checkout.
 *
 * An empty string is a legitimate answer — a deployment need not carry git
 * history — so callers must treat "unknown commit" as information, never as a
 * reason to refuse a backup.
 */
export async function gitCommit(): Promise<string> {
  if (cachedGitCommit !== null) return cachedGitCommit;
  try {
    const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      timeout: 5000,
    });
    cachedGitCommit = stdout.trim();
  } catch {
    cachedGitCommit = "";
  }
  return cachedGitCommit;
}

/** True when the working tree has uncommitted changes — the archive says so. */
export async function gitDirty(): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
