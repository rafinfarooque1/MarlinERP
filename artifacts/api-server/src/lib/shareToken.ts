/**
 * Stateless HMAC-signed share tokens for public invoice PDF links.
 *
 * Token format:  {saleId}-{expiryMs}-{hmacHex}
 *   e.g.  42-1786500000000-9f3a…c1
 *
 * The signature is HMAC-SHA256 over "{saleId}.{expiryMs}" using
 * SESSION_SECRET, so tokens cannot be forged or tampered with and
 * require no database storage. Expired tokens verify as invalid.
 */
import crypto from "crypto";

function requireSecret(): string {
  const s = process.env.SESSION_SECRET;
  // Fail fast at startup: a guessable fallback would make share links forgeable.
  if (!s) throw new Error("SESSION_SECRET must be set — invoice share tokens are signed with it.");
  return s;
}
const SECRET = requireSecret();

function sign(saleId: number, exp: number): string {
  return crypto.createHmac("sha256", SECRET).update(`${saleId}.${exp}`).digest("hex");
}

/** Create a share token for a sale, valid for `ttlDays` (default 30). */
export function createInvoiceShareToken(saleId: number, ttlDays = 30): { token: string; expiresAt: string } {
  const exp = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  return {
    token: `${saleId}-${exp}-${sign(saleId, exp)}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

// ── Quotation tokens ──────────────────────────────────────────────────────────
// Same construction, DIFFERENT signing context ("q.{id}.{exp}") — an invoice
// token must never verify as a quotation token or vice versa, even for the
// same numeric id.

function signQuotation(quotationId: number, exp: number): string {
  return crypto.createHmac("sha256", SECRET).update(`q.${quotationId}.${exp}`).digest("hex");
}

/** Create a share token for a quotation PDF, valid for `ttlDays` (default 30). */
export function createQuotationShareToken(quotationId: number, ttlDays = 30): { token: string; expiresAt: string } {
  const exp = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  return {
    token: `${quotationId}-${exp}-${signQuotation(quotationId, exp)}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

/** Verify a quotation token; returns the quotationId when valid, else null. */
export function verifyQuotationShareToken(token: string): number | null {
  const m = /^(\d{1,12})-(\d{10,16})-([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const quotationId = Number(m[1]);
  const exp = Number(m[2]);
  if (!Number.isFinite(quotationId) || !Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = signQuotation(quotationId, exp);
  const given = Buffer.from(m[3], "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return quotationId;
}

/** Verify a token; returns the saleId when valid and unexpired, else null. */
export function verifyInvoiceShareToken(token: string): number | null {
  const m = /^(\d{1,12})-(\d{10,16})-([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const saleId = Number(m[1]);
  const exp = Number(m[2]);
  if (!Number.isFinite(saleId) || !Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = sign(saleId, exp);
  const given = Buffer.from(m[3], "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return saleId;
}
