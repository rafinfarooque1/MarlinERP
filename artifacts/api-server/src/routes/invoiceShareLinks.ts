/**
 * Invoice share links — management (authenticated) and the public surface.
 *
 * Management, for staff:
 *   GET    /api/sales/:id/share-link              current link + its state
 *   POST   /api/sales/:id/share-link              reuse the active link, or mint one
 *   POST   /api/sales/:id/share-link/regenerate   revoke the current one, mint a fresh one
 *   POST   /api/sales/:id/share-link/revoke       kill the current one
 *
 * Public, for the customer who was sent the link (no login):
 *   GET    /api/share/invoice/:publicId?token=…       a page offering view / download
 *   GET    /api/share/invoice/:publicId/pdf?token=…   the invoice PDF itself
 *
 * The public pair is the ONLY unauthenticated way in, and it can reach exactly
 * one invoice: the sale recorded on the row identified by `publicId`. There is no
 * parameter that names a sale, a customer or a table, so there is nothing to
 * tamper with — changing the publicId either misses (404) or lands on a row whose
 * token will not match.
 */
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireModuleAction } from "../middleware/permissions";
import { getUserDataScope, scopeSalesWhere } from "../lib/dataScope";
import { logActivity } from "../lib/audit";
import { assembleInvoiceData, renderInvoicePdf } from "../services/invoicePdf";
import {
  newPublicId, newShareToken, shareTokenMatches,
  shareLinkExpiry, effectiveStatus, shareLinkPath, SHARE_LINK_TTL_DAYS,
  type ShareLinkStatus,
} from "../lib/invoiceShareLink";

const router = Router();

/**
 * Sharing is granted on the pages that show invoices. Either one is enough —
 * the two pages offer the same button to two different kinds of user.
 */
const SHARE_PAGES = ["page:/sales/pos", "page:/outstanding"];

/** Advisory-lock namespace, so mint-or-reuse serialises per sale. */
const SHARE_LOCK_NS = 918273;

const clientIp = (req: Request) => (req.ip ?? "unknown").replace("::ffff:", "");

/** The only part of a pooled client these helpers need. */
type LinkClient = { query: typeof pool.query };

interface LinkRow {
  id: number;
  public_id: string;
  sale_id: number;
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
    // Only a usable link gets a URL. An expired or revoked row must not hand
    // back something that looks copy-pasteable.
    path: status === "active" && row.token ? shareLinkPath(row.public_id, row.token) : null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    accessCount: row.access_count,
    lastAccessAt: row.last_access_at ? row.last_access_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    validForDays: SHARE_LINK_TTL_DAYS,
  };
}

/** The invoice, but only if this user is allowed to see it (LBAC). */
async function saleInScope(req: Request, saleId: number) {
  const scope = await getUserDataScope((req as any).employee);
  const params: unknown[] = [saleId];
  const { rows: [row] } = await pool.query<{
    id: number; invoice_number: string; sale_date: string; total_amount: string;
    customer_name: string | null; customer_phone: string | null;
  }>(
    `SELECT s.id, s.invoice_number, s.sale_date, s.total_amount,
            c.name AS customer_name, c.phone AS customer_phone
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = $1 AND ${scopeSalesWhere(scope, params)}`,
    params,
  );
  return row ?? null;
}

/** Flip rows that have run past their expiry date, so listings read truthfully. */
async function settleExpired(saleId: number): Promise<void> {
  await pool.query(
    `UPDATE invoice_share_links
        SET status = 'expired'
      WHERE sale_id = $1 AND status = 'active' AND expires_at <= NOW()`,
    [saleId],
  );
}

/** The newest row for a sale, whatever its state — what the UI shows. */
async function newestLink(saleId: number): Promise<LinkRow | null> {
  const { rows: [row] } = await pool.query<LinkRow>(
    `SELECT * FROM invoice_share_links WHERE sale_id = $1 ORDER BY id DESC LIMIT 1`,
    [saleId],
  );
  return row ?? null;
}

/**
 * Serialise everything that changes a sale's link.
 *
 * Every mint, replace and revoke runs in here. Without the lock two operators
 * pressing Share together both read "no active link" and both insert, and the
 * partial unique index then fails one of them with a 500 instead of quietly
 * handing over the link the other one made.
 */
async function withSaleLock<T>(saleId: number, fn: (client: LinkClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [SHARE_LOCK_NS, saleId]);
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

/** A brand-new active link. Only ever called with the sale's lock held. */
async function mintLink(client: LinkClient, saleId: number, employeeId: number | null): Promise<LinkRow> {
  const { rows: [row] } = await client.query<LinkRow>(
    `INSERT INTO invoice_share_links (public_id, sale_id, token, status, created_by, expires_at)
     VALUES ($1, $2, $3, 'active', $4, $5)
     RETURNING *`,
    [newPublicId(), saleId, newShareToken(), employeeId, shareLinkExpiry()],
  );
  return row;
}

/** Reuse the sale's active link, or mint one. */
async function ensureLink(
  saleId: number, employeeId: number | null,
): Promise<{ row: LinkRow; created: boolean; replacedExpired: boolean }> {
  return withSaleLock(saleId, async (client) => {
    // An expired link is not reused — it is retired and replaced, which is what
    // the customer needs: the old URL stays dead, the new one works.
    await client.query(
      `UPDATE invoice_share_links
          SET status = 'expired'
        WHERE sale_id = $1 AND status = 'active' AND expires_at <= NOW()`,
      [saleId],
    );

    const { rows: [active] } = await client.query<LinkRow>(
      `SELECT * FROM invoice_share_links WHERE sale_id = $1 AND status = 'active' LIMIT 1`,
      [saleId],
    );
    if (active) return { row: active, created: false, replacedExpired: false };

    // Whether this is a replacement is read off the row being superseded, not off
    // the sweep above: opening the invoice runs the same sweep a moment earlier,
    // which would leave nothing for this one to count and log a replacement as a
    // plain first-time mint.
    const { rows: [previous] } = await client.query<LinkRow>(
      `SELECT * FROM invoice_share_links WHERE sale_id = $1 ORDER BY id DESC LIMIT 1`,
      [saleId],
    );
    const replacedExpired = previous
      ? effectiveStatus({ status: previous.status, expiresAt: previous.expires_at }) === "expired"
      : false;

    return { row: await mintLink(client, saleId, employeeId), created: true, replacedExpired };
  });
}

/**
 * Replace the sale's link: kill what is active and mint its successor.
 *
 * Both halves are one locked transaction. Revoking first and minting afterwards
 * would leave a gap in which the invoice has no link at all, and a Share landing
 * in that gap would mint a link this call then immediately orphans — leaving two
 * rows the UI cannot both show, one of them live and unreachable.
 */
async function regenerateLink(
  saleId: number, employeeId: number | null,
): Promise<{ row: LinkRow; replacedPublicId: string | null }> {
  return withSaleLock(saleId, async (client) => {
    const { rows: [revoked] } = await client.query<LinkRow>(
      `UPDATE invoice_share_links
          SET status = 'revoked', revoked_by = $2, revoked_at = NOW()
        WHERE sale_id = $1 AND status = 'active'
        RETURNING *`,
      [saleId, employeeId],
    );
    return {
      row: await mintLink(client, saleId, employeeId),
      replacedPublicId: revoked?.public_id ?? null,
    };
  });
}

// ── Management ───────────────────────────────────────────────────────────────

const parseId = (raw: unknown): number => {
  const v = parseInt(String(Array.isArray(raw) ? raw[0] : raw), 10);
  return Number.isFinite(v) ? v : NaN;
};

/** Current state of a sale's link. Read-only: never mints. */
router.get(
  "/sales/:id/share-link",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
    const sale = await saleInScope(req, id);
    if (!sale) { res.status(404).json({ error: "Not found" }); return; }

    await settleExpired(id);
    const row = await newestLink(id);
    res.json({
      saleId: id,
      customerPhone: sale.customer_phone ?? null,
      link: row ? present(row) : null,
    });
  },
);

/**
 * Reuse-or-create, and record the share.
 *
 * `intent` says what the link is for: 'whatsapp' means it is being sent to the
 * customer now, which is a separate audit fact from having generated it.
 */
router.post(
  "/sales/:id/share-link",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
    const sale = await saleInScope(req, id);
    if (!sale) { res.status(404).json({ error: "Not found" }); return; }

    const intent = String((req.body as any)?.intent ?? "link");
    const employee = (req as any).employee;
    const { row, created, replacedExpired } = await ensureLink(id, employee?.id ?? null);
    const view = present(row);

    const who = employee?.username ?? "system";
    const customer = sale.customer_name ?? "Walk-in customer";
    const base = {
      module: "sales" as const,
      entityType: "invoice_share_link" as const,
      entityId: row.id,
      user: who,
    };
    const facts = {
      ip: clientIp(req),
      saleId: id,
      invoiceNumber: sale.invoice_number,
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
          ? `Invoice share link replaced (previous one had expired) — ${sale.invoice_number} for ${customer}`
          : `Invoice share link generated — ${sale.invoice_number} for ${customer}`,
        metadata: { ...facts, replacedExpired, generatedBy: who },
      });
    }
    if (intent === "whatsapp") {
      await logActivity({
        ...base,
        action: "UPDATE",
        description: `Invoice shared on WhatsApp — ${sale.invoice_number} to ${customer}`
          + (sale.customer_phone ? ` (${sale.customer_phone})` : ""),
        metadata: { ...facts, sharedBy: who, channel: "whatsapp", phone: sale.customer_phone ?? null },
      });
    }

    res.status(created ? 201 : 200).json({ saleId: id, reused: !created, link: view });
  },
);

/** Revoke whatever is active and mint a fresh link. */
router.post(
  "/sales/:id/share-link/regenerate",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
    const sale = await saleInScope(req, id);
    if (!sale) { res.status(404).json({ error: "Not found" }); return; }

    const employee = (req as any).employee;
    const { row, replacedPublicId } = await regenerateLink(id, employee?.id ?? null);
    const view = present(row);

    await logActivity({
      module: "sales",
      entityType: "invoice_share_link",
      entityId: row.id,
      action: "CREATE",
      user: employee?.username ?? "system",
      description: `Invoice share link regenerated — ${sale.invoice_number} for ${sale.customer_name ?? "Walk-in customer"} (previous link revoked)`,
      metadata: {
        ip: clientIp(req), saleId: id, invoiceNumber: sale.invoice_number,
        customer: sale.customer_name ?? "Walk-in customer", publicId: row.public_id,
        status: view.status, expiresAt: view.expiresAt, generatedBy: employee?.username ?? "system",
        replacedPublicId,
      },
    });

    res.status(201).json({ saleId: id, reused: false, link: view });
  },
);

/** Kill the active link. The URL stops working immediately. */
router.post(
  "/sales/:id/share-link/revoke",
  requireModuleAction(SHARE_PAGES, "download"),
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid sale id" }); return; }
    const sale = await saleInScope(req, id);
    if (!sale) { res.status(404).json({ error: "Not found" }); return; }

    const employee = (req as any).employee;
    // Under the same lock as mint-or-reuse, so a Share pressed at this instant
    // resolves one way or the other instead of overlapping this revoke.
    const row = await withSaleLock(id, async (client) => {
      const { rows: [r] } = await client.query<LinkRow>(
        `UPDATE invoice_share_links
            SET status = 'revoked', revoked_by = $2, revoked_at = NOW()
          WHERE sale_id = $1 AND status = 'active'
          RETURNING *`,
        [id, employee?.id ?? null],
      );
      return r ?? null;
    });
    if (!row) {
      res.status(409).json({ error: "There is no active share link for this invoice." });
      return;
    }

    await logActivity({
      module: "sales",
      entityType: "invoice_share_link",
      entityId: row.id,
      action: "DELETE",
      user: employee?.username ?? "system",
      description: `Invoice share link revoked — ${sale.invoice_number} for ${sale.customer_name ?? "Walk-in customer"}`,
      metadata: {
        ip: clientIp(req), saleId: id, invoiceNumber: sale.invoice_number,
        customer: sale.customer_name ?? "Walk-in customer", publicId: row.public_id,
        status: "revoked", revokedBy: employee?.username ?? "system",
        accessCount: row.access_count,
      },
    });

    res.json({ saleId: id, link: present(row) });
  },
);

// ── Public surface ───────────────────────────────────────────────────────────

/** Everything the public routes are allowed to learn from a URL. */
type FailureReason = "unknown" | Exclude<ShareLinkStatus, "active">;
type Resolution =
  | { ok: true; row: LinkRow }
  | { ok: false; reason: FailureReason };

/**
 * Look up a link from the public URL.
 *
 * A wrong token is reported as `unknown`, exactly like a publicId that does not
 * exist, so the response cannot be used to confirm that an id is real.
 */
async function resolvePublic(publicId: string, token: string): Promise<Resolution> {
  if (!publicId || !token) return { ok: false, reason: "unknown" };
  const { rows: [row] } = await pool.query<LinkRow>(
    `SELECT * FROM invoice_share_links WHERE public_id = $1 LIMIT 1`,
    [publicId],
  );
  if (!row) return { ok: false, reason: "unknown" };
  if (!shareTokenMatches(token, row.token)) return { ok: false, reason: "unknown" };

  const status = effectiveStatus({ status: row.status, expiresAt: row.expires_at });
  if (status !== "active") {
    // Keep the stored status honest now that we know it has lapsed.
    if (row.status === "active") await settleExpired(row.sale_id);
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
 * The page shell.
 *
 * Deliberately one self-contained document with no scripts and no external
 * requests — it cannot reach the ERP, because it does not know how to. The only
 * links on it are the two PDF URLs for this one invoice.
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
      title: "This invoice link has expired",
      text: `Invoice links stay valid for ${SHARE_LINK_TTL_DAYS} days. Please ask ${esc(company)} to send you a fresh link — they can do that in seconds.`,
    },
    revoked: {
      icon: "&#128274;",
      title: "This invoice link is no longer active",
      text: `${esc(company)} has withdrawn this link. Please contact them if you still need a copy of your invoice.`,
    },
    unknown: {
      icon: "&#128269;",
      title: "This invoice link is not valid",
      text: "The link may have been typed or copied incompletely. Please open it directly from the message you were sent, or ask for a new link.",
    },
  }[kind];

  return page({
    title: copy.title,
    body: `
      <div class="head"><h1>${esc(company)}</h1><p>Invoice</p></div>
      <div class="body"><div class="msg">
        <div class="icon">${copy.icon}</div>
        <h2>${copy.title}</h2>
        <p>${copy.text}</p>
      </div></div>`,
  });
}

/**
 * The customer's page: what they bought, what it cost, and two ways to get the
 * PDF. There is nothing else on it and nothing else reachable from it.
 */
router.get("/share/invoice/:publicId", async (req, res): Promise<void> => {
  lockDownResponse(res);
  const publicId = String(Array.isArray(req.params.publicId) ? req.params.publicId[0] : req.params.publicId);
  const token = String(req.query.token ?? "");

  const resolved = await resolvePublic(publicId, token);
  if (!resolved.ok) {
    // The company name is safe to show on a dead link and tells the customer who
    // to ask; it is read from settings, never from the URL.
    const { rows: [cs] } = await pool.query<{ company_name: string }>(
      `SELECT company_name FROM company_settings LIMIT 1`,
    );
    const company = cs?.company_name ?? "the seller";
    res.status(resolved.reason === "unknown" ? 404 : 410)
      .type("html")
      .send(noticePage(resolved.reason, company));
    return;
  }

  const data = await assembleInvoiceData(resolved.row.sale_id);
  if (!data) { res.status(404).type("html").send(noticePage("unknown", "the seller")); return; }

  const company = String((data.cs as any)?.companyName ?? "Invoice");
  const seller = data.outletName || company;
  const base = `/api/share/invoice/${encodeURIComponent(publicId)}/pdf?token=${encodeURIComponent(token)}`;
  const expires = asDate(resolved.row.expires_at);

  res.status(200).type("html").send(page({
    title: `Invoice ${data.sale.invoiceNumber ?? ""} — ${company}`,
    body: `
      <div class="head">
        <h1>${esc(company)}</h1>
        <p>${esc(seller)}</p>
      </div>
      <div class="body">
        <dl>
          <dt>Invoice number</dt><dd>${esc(data.sale.invoiceNumber ?? "—")}</dd>
          <dt>Invoice date</dt><dd>${esc(asDate(data.sale.saleDate))}</dd>
          ${data.customer?.name ? `<dt>Billed to</dt><dd>${esc(data.customer.name)}</dd>` : ""}
        </dl>
        <div class="total"><span>Total amount</span><strong>${esc(inr(data.sale.totalAmount))}</strong></div>
        <div class="actions">
          <a class="btn primary" href="${esc(base)}" target="_blank" rel="noopener noreferrer">View invoice PDF</a>
          <a class="btn secondary" href="${esc(`${base}&download=1`)}">Download invoice PDF</a>
        </div>
        <p class="note">This link is private to you and stops working on ${esc(expires)}.</p>
      </div>`,
  }));
});

/**
 * The document itself. Rendered fresh, so the customer always sees the invoice as
 * it stands now, and counted, so the office can see the link was used.
 */
router.get("/share/invoice/:publicId/pdf", async (req, res): Promise<void> => {
  lockDownResponse(res);
  const publicId = String(Array.isArray(req.params.publicId) ? req.params.publicId[0] : req.params.publicId);
  const token = String(req.query.token ?? "");

  const resolved = await resolvePublic(publicId, token);
  if (!resolved.ok) {
    const status = resolved.reason === "unknown" ? 404 : 410;
    // A direct PDF fetch that fails still answers in HTML: the customer may well
    // have opened this URL itself from an older message.
    res.status(status).type("html").send(noticePage(resolved.reason, "the seller"));
    return;
  }

  const data = await assembleInvoiceData(resolved.row.sale_id);
  if (!data) { res.status(404).type("html").send(noticePage("unknown", "the seller")); return; }

  const { buffer, fileName } = await renderInvoicePdf(data);
  const download = Boolean(req.query.download);

  // Count the access before sending. Fire-and-forget: a counter failure must not
  // deny the customer their invoice.
  pool.query(
    `UPDATE invoice_share_links SET access_count = access_count + 1, last_access_at = NOW() WHERE id = $1`,
    [resolved.row.id],
  ).catch(() => {});

  logActivity({
    module: "sales",
    entityType: "invoice_share_link",
    entityId: resolved.row.id,
    action: "UPDATE",
    user: "customer (public link)",
    description: `Invoice ${download ? "downloaded" : "viewed"} through a share link — ${data.sale.invoiceNumber ?? `#${resolved.row.sale_id}`}`,
    metadata: {
      ip: clientIp(req),
      saleId: resolved.row.sale_id,
      invoiceNumber: data.sale.invoiceNumber,
      customer: data.customer?.name ?? null,
      publicId: resolved.row.public_id,
      status: "active",
      action: download ? "download" : "view",
      accessCount: resolved.row.access_count + 1,
    },
  }).catch(() => {});

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${fileName}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.end(buffer);
});

export default router;
