/**
 * In-process zip implementation — unit tests (regression for "spawn zip ENOENT":
 * production has no zip/unzip binaries, so archiving must never shell out).
 * Run: node artifacts/api-server/tests/backup-archive.test.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip, extractZip, listZipEntries } from "../src/lib/backup/archive.ts";
import { ZipArchive } from "archiver";

let passed = 0, failed = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label} — ${detail}`); failed++; }
};

const work = await mkdtemp(join(tmpdir(), "ziptest-"));
const stage = join(work, "stage");
await mkdir(join(stage, "uploads", "logos"), { recursive: true });
await mkdir(join(stage, "emptydir"), { recursive: true });
await writeFile(join(stage, "database.sql"), "-- sql dump\nSELECT 1;\n");
await writeFile(join(stage, "manifest.json"), JSON.stringify({ hello: "world" }));
await writeFile(join(stage, "uploads", "logos", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

// 1. create
const zipPath = join(work, "out.zip");
await createZip(stage, zipPath);
const zipBytes = (await readFile(zipPath)).length;
ok("createZip writes a non-empty archive", zipBytes > 0, `${zipBytes} bytes`);

// 2. list
const entries = await listZipEntries(zipPath);
ok("nested member present", entries.includes("uploads/logos/logo.png"), entries.join(","));
ok("top-level members present", entries.includes("database.sql") && entries.includes("manifest.json"), entries.join(","));

// 3. round-trip extraction
const out = join(work, "out");
await extractZip(zipPath, out);
const sql = await readFile(join(out, "database.sql"), "utf8");
const png = await readFile(join(out, "uploads", "logos", "logo.png"));
ok("extracted text content matches", sql.includes("SELECT 1"), sql.slice(0, 40));
ok("extracted binary content matches", png[0] === 0x89 && png.length === 7, `len=${png.length}`);

// 4. corrupt file → friendly error, no throw of raw ENOENT-style noise
const corrupt = join(work, "corrupt.zip");
await writeFile(corrupt, "this is not a zip at all");
let corruptErr = "";
try { await listZipEntries(corrupt); } catch (e) { corruptErr = String(e.message); }
ok("corrupt archive is refused with a plain message", /could not be opened as a ZIP/i.test(corruptErr), corruptErr.slice(0, 120));

// 5. zip-slip: an entry trying to escape the destination must be refused.
// archiver itself normalises "../" away, so a genuinely hostile archive is
// forged by writing a valid one and byte-patching the entry name (same length,
// so every offset and checksum but the name stays intact — exactly what an
// attacker's hand-built zip looks like).
const evil = join(work, "evil.zip");
await new Promise((resolve, reject) => {
  const o = createWriteStream(evil);
  const a = new ZipArchive();
  o.on("close", resolve); a.on("error", reject);
  a.pipe(o);
  a.append("owned", { name: "AA/evil.txt" });
  a.finalize();
});
{
  const buf = await readFile(evil);
  const patched = Buffer.from(buf.toString("latin1").replaceAll("AA/evil.txt", "../evil.txt"), "latin1");
  await writeFile(evil, patched);
}
let slipErr = "";
try { await extractZip(evil, join(work, "evil-out")); } catch (e) { slipErr = String(e.message); }
ok("path-traversal entry is refused", /unsafe path/i.test(slipErr), slipErr.slice(0, 120));
let escaped = true;
try { await readFile(join(work, "evil.txt")); } catch { escaped = false; }
ok("no file escaped the extraction root", !escaped);

// 6. failure path: unwritable target rejects (create.ts then marks the backup failed)
let createErr = "";
try { await createZip(stage, join(work, "no-such-dir", "x.zip")); } catch (e) { createErr = String(e.message); }
ok("createZip rejects cleanly when the archive cannot be written", /could not be written/i.test(createErr), createErr.slice(0, 120));

await rm(work, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
