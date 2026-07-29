/**
 * Secure invoice share links.
 *
 * A link is a row in `invoice_share_links`. The public URL carries two things:
 *
 *   /api/share/invoice/<publicId>?token=<token>
 *
 *   publicId — a random UUID. It is the database lookup key, and it replaces the
 *              sale id that the previous scheme put in the URL: nothing about the
 *              invoice, the customer or the sequence can be read off it, and
 *              editing it cannot walk to another invoice.
 *   token    — 256 bits from the OS random source, minted once per link and held
 *              on that row. Unguessable, unrelated to the invoice, and shared
 *              with no other link.
 *
 * Why the token is stored rather than hashed: a share link has to be *re-shown*.
 * Copy Link and Share on WhatsApp both hand out the invoice's existing active
 * link, days after it was minted, so the server must be able to reproduce it.
 * Both hash-only variants are worse here:
 *
 *   Keep the hash and re-derive the token from the publicId with a server secret.
 *   Rotating that secret then detaches every stored hash from its derivation,
 *   which kills every link already in a customer's hands *and* makes the link the
 *   UI offers next unopenable — without anyone touching the sharing feature.
 *   SESSION_SECRET is rotated for reasons that have nothing to do with invoices.
 *
 *   Keep the hash and show the token once, at mint time. That gives up re-sending
 *   an invoice link for protection that does not apply: the token opens one
 *   invoice PDF, and whoever can read this table can already read that invoice
 *   out of `sales` next to it.
 *
 * So the row is the single authority. Verification is a constant-time comparison
 * against the token on the row, which makes revocation and expiry absolute, and
 * nothing outside the database can produce a working URL.
 */
import crypto from "crypto";

/** The brief's expiry period. A link stops working 15 days after it was made. */
export const SHARE_LINK_TTL_DAYS = 15;

export type ShareLinkStatus = "active" | "expired" | "revoked";

/** A fresh, random public identifier for a new link. */
export function newPublicId(): string {
  return crypto.randomUUID();
}

/** The secret half of one link. Used for that link and nothing else. */
export function newShareToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Constant-time comparison of a presented token against the row's token.
 *
 * Length is compared first and is not itself a secret — every token is 64 hex
 * characters, so a mismatch there only means the URL was mangled.
 */
export function shareTokenMatches(presented: string, stored: string | null): boolean {
  if (!presented || !stored) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** When a link minted now should stop working. */
export function shareLinkExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The effective status of a row.
 *
 * Expiry is derived from the date rather than trusted from the column, so a link
 * is dead the moment it is due to be — with no dependence on a sweep having run.
 * Revocation is permanent and outranks everything.
 */
export function effectiveStatus(row: { status: string; expiresAt: Date | string }): ShareLinkStatus {
  if (row.status === "revoked") return "revoked";
  const exp = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  if (!Number.isFinite(exp.getTime()) || exp.getTime() <= Date.now()) return "expired";
  return row.status === "active" ? "active" : (row.status as ShareLinkStatus);
}

/** The customer-facing path for a link. Callers prepend their own origin. */
export function shareLinkPath(publicId: string, token: string): string {
  return `/api/share/invoice/${encodeURIComponent(publicId)}?token=${token}`;
}
