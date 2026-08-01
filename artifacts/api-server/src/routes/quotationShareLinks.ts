/**
 * Quotation share links — management (authenticated) and the public surface.
 *
 * Management, for staff:
 *   GET    /api/quotations/:id/share-link              current link + its state
 *   POST   /api/quotations/:id/share-link              reuse the active link, or mint one
 *   POST   /api/quotations/:id/share-link/regenerate   revoke the current one, mint a fresh one
 *   POST   /api/quotations/:id/share-link/revoke       kill the current one
 *
 * Public, for the customer who was sent the link (no login):
 *   GET    /api/share/quotation/:publicId?token=…       a page offering view / download
 *   GET    /api/share/quotation/:publicId/pdf?token=…   the quotation PDF itself
 *
 * Same construction as invoice share links, and deliberately a SEPARATE table
 * and router: a quotation link can only ever open a quotation, an invoice link
 * only an invoice — even for the same numeric id. Changing the publicId either
 * misses (404) or lands on a row whose token will not match.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireModuleAction } from "../middleware/permissions";
import { getUserDataScope, type DataScope } from "../lib/dataScope";
import { logActivity } from "../lib/audit";
import { assembleQuotationData, renderInvoicePdf } from "../services/invoicePdf";
import {
  newPublicId, newShareToken, shareTokenMatches,
  shareLinkExpiry, effectiveStatus, SHARE_LINK_TTL_DAYS,
  type ShareLinkStatus,
} from "../lib/invoiceShareLink";

const router = Router();

/** Sharing rides the module's own download right, like invoice sharing does. */
const SHARE_PAGES = ["page:/sales/quotations"];

/** Advisory-lock namespace — distinct from invoice links' 918273. */
const SHARE_LOCK_NS = 918274;

const clientIp = (req: Request) => (req.ip ?? "unknown").replace("::ffff:", "");

/** The customer-facing path for a quotation link. */
const quotationShareLinkPath = (publicId: string, token: string): string =>
  `/api/share/quotation/${encodeURIComponent(publicId)}?token=${token}`;

/** The only part of a pooled client these helpers need. */
type LinkClient = { query: typeof pool.query };

interface LinkRow {
  id: number;
  public_id: string;
  quotation_id: number;
  token: string | null;
  status: string;
  created_by: number | null;
  created_at: Date;
  expires_at: Date;
  access_count: number;
  last_access_at: Date | null;
  revoked_by: number | null;
  revoked_at: Date | null;
}

/** What the management endpoints return. Includes the live, openable link. */
function present(row: LinkRow) {
  const status = effectiveStatus({ status: row.status, expiresAt: row.expires_at });
  return {
    publicId: row.public_id,
    status,
    path: status === "active" && row.token ? quotationShareLinkPath(row.public_id, row.token) : null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    accessCount: row.access_count,
    lastAccessAt: row.last_access_at ? row.last_access_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    validForDays: SHARE_LINK_TTL_DAYS,
  };
}

/** Location scope for quotations — both columns are NOT NULL. */
function scopeQuotationsWhere(scope: DataScope, params: unknown[]): string {
  if (scope.isHeadOffice) return "TRUE";
  const conds: string[] = [];
  if (scope.warehouseIds.length > 0) {
    params.push(scope.warehouseIds);
    conds.push(`(q.location_type = 'warehouse' AND q.location_id = ANY($${params.length}::int[]))`);
  }
  if (scope.outletIds.length > 0) {
    params.push(scope.outletIds);
    conds.push(`(q.location_type = 'outlet' AND q.location_id = ANY($${params.length}::int[]))`);
  }
  return conds.length > 0 ? `(${conds.join(" OR ")})` : "FALSE";
}

/** The quotation, but only if this user is allowed to see it (LBAC). */
async function quotationInScope(req: Request, quotationId: number) {
  const scope = await getUserDataScope((req as any).employee);
  const params: unknown[] = [quotationId];
  const { rows: [row] } = await pool.query<{
    id: number; quotation_number: string; total_amount: string;
    customer_name: string | null; customer_phone: string | null;
  }>(
    `SELECT q.id, q.quotation_number, q.total_amount,
            c.name AS customer_name, c.phone AS customer_phone
       FROM quotations q
       LEFT JOIN customers c ON c.id = q.customer_id
      WHERE q.id = $1 AND ${scopeQuotationsWhere(scope, params)}`,
    params,
  );
  return row ?? null;
}

/** Mark any overdue active link as expired, so stored status stays honest. */
async function settleExpired(quotationId: number): Promise<void> {
  await pool.query(
    `UPDATE quotation_share_links
        SET status = 'expired'
      WHERE quotation_id = $1 AND status = 'active' AND expires_at <= NOW()`,
    [quotationId],
  );
}

/** The newest row for a quotation, whatever its state — what the UI shows. */
async function newestLink(quotationId: number): Promise<LinkRow | null> {
  const { rows: [row] } = await pool.query<LinkRow>(
    `SELECT * FROM quotation_share_links WHERE quotation_id = $1 ORDER BY id DESC LIMIT 1`,
    [quotationId],
  );
  return row ?? null;
}

/**
 * Serialise everything that changes a quotation's link — same reasoning as
 * invoice links: two Shares pressed together must resolve to ONE link, not a
 * unique-index 500.
 */
async function withQuotationLock<T>(quotationId: number, fn: (client: LinkClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [SHARE_LOCK_NS, quotationId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** A brand-new active link. Only ever called with the quotation's lock held. */
async function mintLink(client: LinkClient, quotationId: number, employeeId: number | null): Promise<LinkRow> {
  const { rows: [row] } = await client.query<LinkRow>(
    `INSERT INTO quotation_share_links (public_id, quotation_id, token, status, created_by, expires_at)
     VALUES ($1, $2, $3, 'active', $4, $5)
     RETURNING *`,
    [newPublicId(), quotationId, newShareToken(), employeeId, shareLinkExpiry()],
  );
  return row;
}

/** Reuse the quotation's active link, or mint one. */
async function ensureLink(
  quotationId: number, employeeId: number | null,
): Promise<{ row: LinkRow; created: boolean; replacedExpired: boolean }> {
  return withQuotationLock(quotationId, async (client) => {
    // An expired link is retired and replaced, never reused: the old URL stays
    // dead, the new one works.
    await client.query(
      `UPDATE quotation_share_links
          SET status = 'expired'
        WHERE quotation_id = $1 AND status = 'active' AND expires_at <= NOW()`,
      [quotationId],
    );

    const { rows: [active] } = await client.query<LinkRow>(
      `SELECT * FROM quotation_share_links WHERE quotation_id = $1 AND status = 'active' LIMIT 1`,
      [quotationId],
    );
    if (active) return { row: active, created: false, replacedExpired: false };

    const { rows: [previous] } = await client.query<LinkRow>(
      `SELECT * FROM quotation_share_links WHERE quotation_id = $1 ORDER BY id DESC LIMIT 1`,
      [quotationId],
    );
    const replacedExpired = previous
      ? effectiveStatus({ status: previous.status, expiresAt: previous.expires_at }) === "expired"
      : false;

    return { row: await mintLink(client, quotationId, employeeId), created: true, replacedExpired };
  });
}

/** Replace the quotation's link: revoke + mint in ONE locked transaction. */
async function regenerateLink(
  quotationId: number, employeeId: number | null,
): Promise<{ row: LinkRow; replacedPublicId: string | null }> {
  return withQuotationLock(quotationId, async (client) => {
    const { rows: [revoked] } = await client.query<LinkRow>(
      `UPDATE quotation_share_links
          SET status = 'revoked', revoked_by = $2, revoked_at = NOW()
        WHERE quotation_id = $1 AND status = 'active'
        RETURNING *`,
      [quotationId, employeeId],
    );
    return {
      row: await mintLink(client, quotationId, employeeId),
      replacedPublicId: revoked?.public_id ?? null,
    };
  });
}

// ── Management ───────────────────────────────────────────────────────────────

const parseId = (raw: unknown): number => {
  const v = parseInt(String(Array.isArray(raw) ? raw[0] : raw), 10);
  return Number.isFinite(v) ? v : NaN;
};

/** Current state of a quotation's link. Read-only: never mints. */
router.get(
  "/quotations/:id/share-link",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }
    const quotation = await quotationInScope(req, id);
    if (!quotation) { res.status(404).json({ error: "Not found" }); return; }

    await settleExpired(id);
    const row = await newestLink(id);
    res.json({
      quotationId: id,
      customerPhone: quotation.customer_phone ?? null,
      link: row ? present(row) : null,
    });
  },
);

/** Reuse-or-create, and record the share. */
router.post(
  "/quotations/:id/share-link",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }
    const quotation = await quotationInScope(req, id);
    if (!quotation) { res.status(404).json({ error: "Not found" }); return; }

    const intent = String((req.body as any)?.intent ?? "link");
    const employee = (req as any).employee;
    const { row, created, replacedExpired } = await ensureLink(id, employee?.id ?? null);
    const view = present(row);

    const who = employee?.username ?? "system";
    const customer = quotation.customer_name ?? "Walk-in customer";
    const base = {
      module: "quotations" as const,
      entityType: "quotation_share_link" as const,
      entityId: row.id,
      user: who,
    };
    const facts = {
      ip: clientIp(req),
      quotationId: id,
      quotationNumber: quotation.quotation_number,
      customer,
      publicId: row.public_id,
      status: view.status,
      expiresAt: view.expiresAt,
    };

    if (created) {
      await logActivity({
        ...base,
        action: "CREATE",
        description: replacedExpired
          ? `Quotation share link replaced (previous one had expired) — ${quotation.quotation_number} for ${customer}`
          : `Quotation share link generated — ${quotation.quotation_number} for ${customer}`,
        metadata: { ...facts, replacedExpired, generatedBy: who },
      });
    }
    if (intent === "whatsapp") {
      await logActivity({
        ...base,
        action: "UPDATE",
        description: `Quotation shared on WhatsApp — ${quotation.quotation_number} to ${customer}`
          + (quotation.customer_phone ? ` (${quotation.customer_phone})` : ""),
        metadata: { ...facts, sharedBy: who, channel: "whatsapp", phone: quotation.customer_phone ?? null },
      });
    }

    res.status(created ? 201 : 200).json({ quotationId: id, reused: !created, link: view });
  },
);

/** Revoke whatever is active and mint a fresh link. */
router.post(
  "/quotations/:id/share-link/regenerate",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }
    const quotation = await quotationInScope(req, id);
    if (!quotation) { res.status(404).json({ error: "Not found" }); return; }

    const employee = (req as any).employee;
    const { row, replacedPublicId } = await regenerateLink(id, employee?.id ?? null);
    const view = present(row);

    await logActivity({
      module: "quotations",
      entityType: "quotation_share_link",
      entityId: row.id,
      action: "CREATE",
      user: employee?.username ?? "system",
      description: `Quotation share link regenerated — ${quotation.quotation_number} for ${quotation.customer_name ?? "Walk-in customer"} (previous link revoked)`,
      metadata: {
        ip: clientIp(req), quotationId: id, quotationNumber: quotation.quotation_number,
        customer: quotation.customer_name ?? "Walk-in customer", publicId: row.public_id,
        status: view.status, expiresAt: view.expiresAt, generatedBy: employee?.username ?? "system",
        replacedPublicId,
      },
    });

    res.status(201).json({ quotationId: id, reused: false, link: view });
  },
);

/** Kill the active link. The URL stops working immediately. */
router.post(
  "/quotations/:id/share-link/revoke",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid quotation id" }); return; }
    const quotation = await quotationInScope(req, id);
    if (!quotation) { res.status(404).json({ error: "Not found" }); return; }

    const employee = (req as any).employee;
    const row = await withQuotationLock(id, async (client) => {
      const { rows: [r] } = await client.query<LinkRow>(
        `UPDATE quotation_share_links
            SET status = 'revoked', revoked_by = $2, revoked_at = NOW()
          WHERE quotation_id = $1 AND status = 'active'
          RETURNING *`,
        [id, employee?.id ?? null],
      );
      return r ?? null;
    });
    if (!row) {
      res.status(409).json({ error: "There is no active share link for this quotation." });
      return;
    }

    await logActivity({
      module: "quotations",
      entityType: "quotation_share_link",
      entityId: row.id,
      action: "DELETE",
      user: employee?.username ?? "system",
      description: `Quotation share link revoked — ${quotation.quotation_number} for ${quotation.customer_name ?? "Walk-in customer"}`,
      metadata: {
        ip: clientIp(req), quotationId: id, quotationNumber: quotation.quotation_number,
        customer: quotation.customer_name ?? "Walk-in customer", publicId: row.public_id,
        status: "revoked", revokedBy: employee?.username ?? "system",
        accessCount: row.access_count,
      },
    });

    res.json({ quotationId: id, link: present(row) });
  },
);

// ── Public surface ───────────────────────────────────────────────────────────

type FailureReason = "unknown" | Exclude<ShareLinkStatus, "active">;
type Resolution =
  | { ok: true; row: LinkRow }
  | { ok: false; reason: FailureReason };

/**
 * Look up a link from the public URL. A wrong token is reported as `unknown`,
 * exactly like a publicId that does not exist, so the response cannot be used
 * to confirm that an id is real.
 */
async function resolvePublic(publicId: string, token: string): Promise<Resolution> {
  if (!publicId || !token) return { ok: false, reason: "unknown" };
  const { rows: [row] } = await pool.query<LinkRow>(
    `SELECT * FROM quotation_share_links WHERE public_id = $1 LIMIT 1`,
    [publicId],
  );
  if (!row) return { ok: false, reason: "unknown" };
  if (!shareTokenMatches(token, row.token)) return { ok: false, reason: "unknown" };

  const status = effectiveStatus({ status: row.status, expiresAt: row.expires_at });
  if (status !== "active") {
    if (row.status === "active") await settleExpired(row.quotation_id);
    return { ok: false, reason: status };
  }
  return { ok: true, row };
}

/** Headers for every public response: nothing embeds, indexes or caches this. */
function lockDownResponse(res: Response): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const inr = (n: unknown): string =>
  `₹${Number(n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const asDate = (d: unknown): string => {
  const t = new Date(String(d));
  return Number.isFinite(t.getTime())
    ? t.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : String(d ?? "");
};

/**
 * The page shell — one self-contained document with no scripts and no external
 * requests. The only links on it are the two PDF URLs for this one quotation.
 */
function page(opts: { title: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(opts.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; background: #f1f5f9; color: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .card {
    width: 100%; max-width: 420px; background: #fff; border-radius: 16px;
    box-shadow: 0 10px 30px rgba(15,23,42,.10); overflow: hidden;
  }
  .head { padding: 22px 24px; background: linear-gradient(135deg, #0f766e, #14b8a6); color: #fff; }
  .head h1 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: .01em; }
  .head p { margin: 4px 0 0; font-size: 12.5px; opacity: .9; }
  .body { padding: 22px 24px 24px; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 9px 16px; font-size: 13.5px; }
  dt { color: #64748b; }
  dd { margin: 0; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
  .total { margin-top: 14px; padding-top: 14px; border-top: 1px solid #e2e8f0;
           display: flex; justify-content: space-between; align-items: baseline; }
  .total span { color: #64748b; font-size: 13.5px; }
  .total strong { font-size: 21px; font-variant-numeric: tabular-nums; }
  .actions { margin-top: 20px; display: grid; gap: 10px; }
  a.btn {
    display: block; padding: 13px 16px; border-radius: 10px; text-align: center;
    text-decoration: none; font-size: 14.5px; font-weight: 600;
  }
  a.primary { background: #0f766e; color: #fff; }
  a.secondary { background: #fff; color: #0f766e; border: 1.5px solid #99f6e4; }
  .note { margin: 16px 0 0; font-size: 11.5px; color: #94a3b8; text-align: center; line-height: 1.5; }
  .msg { text-align: center; }
  .msg .icon { font-size: 34px; line-height: 1; }
  .msg h2 { margin: 12px 0 6px; font-size: 17px; }
  .msg p { margin: 0; font-size: 13.5px; color: #64748b; line-height: 1.6; }
</style>
</head>
<body><div class="card">${opts.body}</div></body>
</html>`;
}

/** A dead end, phrased for a customer rather than for a developer. */
function noticePage(kind: "expired" | "revoked" | "unknown", company: string): string {
  const copy = {
    expired: {
      icon: "&#9203;",
      title: "This quotation link has expired",
      text: `Quotation links stay valid for ${SHARE_LINK_TTL_DAYS} days. Please ask ${esc(company)} to send you a fresh link — they can do that in seconds.`,
    },
    revoked: {
      icon: "&#128274;",
      title: "This quotation link is no longer active",
      text: `${esc(company)} has withdrawn this link. Please contact them if you still need a copy of your quotation.`,
    },
    unknown: {
      icon: "&#128269;",
      title: "This quotation link is not valid",
      text: "The link may have been typed or copied incompletely. Please open it directly from the message you were sent, or ask for a new link.",
    },
  }[kind];

  return page({
    title: copy.title,
    body: `
      <div class="head"><h1>${esc(company)}</h1><p>Quotation</p></div>
      <div class="body"><div class="msg">
        <div class="icon">${copy.icon}</div>
        <h2>${copy.title}</h2>
        <p>${copy.text}</p>
      </div></div>`,
  });
}

/**
 * The customer's page: what was offered, what it would cost, how long the
 * offer stands, and two ways to get the PDF.
 */
router.get("/share/quotation/:publicId", async (req, res): Promise<void> => {
  lockDownResponse(res);
  const publicId = String(Array.isArray(req.params.publicId) ? req.params.publicId[0] : req.params.publicId);
  const token = String(req.query.token ?? "");

  const resolved = await resolvePublic(publicId, token);
  if (!resolved.ok) {
    const { rows: [cs] } = await pool.query<{ company_name: string }>(
      `SELECT company_name FROM company_settings LIMIT 1`,
    );
    const company = cs?.company_name ?? "the seller";
    res.status(resolved.reason === "unknown" ? 404 : 410)
      .type("html")
      .send(noticePage(resolved.reason, company));
    return;
  }

  const data = await assembleQuotationData(resolved.row.quotation_id);
  if (!data) { res.status(404).type("html").send(noticePage("unknown", "the seller")); return; }

  const company = String((data.cs as any)?.companyName ?? "Quotation");
  const seller = data.outletName || company;
  const base = `/api/share/quotation/${encodeURIComponent(publicId)}/pdf?token=${encodeURIComponent(token)}`;
  const expires = asDate(resolved.row.expires_at);
  const validTill = data.quotation?.validTill ? asDate(data.quotation.validTill) : null;

  res.status(200).type("html").send(page({
    title: `Quotation ${data.sale.invoiceNumber ?? ""} — ${company}`,
    body: `
      <div class="head">
        <h1>${esc(company)}</h1>
        <p>${esc(seller)}</p>
      </div>
      <div class="body">
        <dl>
          <dt>Quotation number</dt><dd>${esc(data.sale.invoiceNumber ?? "—")}</dd>
          <dt>Quotation date</dt><dd>${esc(asDate(data.sale.saleDate))}</dd>
          ${validTill ? `<dt>Valid until</dt><dd>${esc(validTill)}</dd>` : ""}
          ${data.customer?.name ? `<dt>Prepared for</dt><dd>${esc(data.customer.name)}</dd>` : ""}
        </dl>
        <div class="total"><span>Quoted amount</span><strong>${esc(inr(data.sale.totalAmount))}</strong></div>
        <div class="actions">
          <a class="btn primary" href="${esc(base)}" target="_blank" rel="noopener noreferrer">View quotation PDF</a>
          <a class="btn secondary" href="${esc(`${base}&download=1`)}">Download quotation PDF</a>
        </div>
        <p class="note">This link is private to you and stops working on ${esc(expires)}.${validTill ? ` The quotation itself is valid until ${esc(validTill)}.` : ""}</p>
      </div>`,
  }));
});

/**
 * The document itself. Rendered fresh, so the customer always sees the
 * quotation as it stands now, and counted, so the office can see it was used.
 */
router.get("/share/quotation/:publicId/pdf", async (req, res): Promise<void> => {
  lockDownResponse(res);
  const publicId = String(Array.isArray(req.params.publicId) ? req.params.publicId[0] : req.params.publicId);
  const token = String(req.query.token ?? "");

  const resolved = await resolvePublic(publicId, token);
  if (!resolved.ok) {
    const status = resolved.reason === "unknown" ? 404 : 410;
    res.status(status).type("html").send(noticePage(resolved.reason, "the seller"));
    return;
  }

  const data = await assembleQuotationData(resolved.row.quotation_id);
  if (!data) { res.status(404).type("html").send(noticePage("unknown", "the seller")); return; }

  // Count the access before sending. Fire-and-forget: a counter failure must
  // not deny the customer their quotation.
  pool.query(
    `UPDATE quotation_share_links SET access_count = access_count + 1, last_access_at = NOW() WHERE id = $1`,
    [resolved.row.id],
  ).catch(() => {});

  const { buffer, fileName } = await renderInvoicePdf(data);
  const disposition = req.query.download ? "attachment" : "inline";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${disposition}; filename="${fileName}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.end(buffer);
});

export default router;
