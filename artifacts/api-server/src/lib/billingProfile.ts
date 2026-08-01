/**
 * The billing profile a sales invoice is issued under.
 *
 * A tax invoice states who sold the goods. In this ERP that is the *warehouse*
 * recorded on the sale, not the company profile and not whoever happens to be
 * reprinting the document later. Each warehouse can be its own GST
 * registration with its own trade name, address, FSSAI licence, bank account
 * and UPI handle, so all of that lives on the warehouse row and is resolved
 * from the location the sale stored.
 *
 * Two rules shape everything below.
 *
 * 1. **Never borrow another location's identity.** If a warehouse has no
 *    GSTIN, the invoice prints no GSTIN — it does not quietly substitute the
 *    company's or a sibling warehouse's. A wrong GSTIN on a tax invoice is a
 *    filing problem for whoever it names; a missing one is a visible gap the
 *    user can fix. Only the bank block and the UPI handle fall back to the
 *    company, because those name the same legal entity's own account and that
 *    is the behaviour every existing invoice already relies on.
 *
 * 2. **Absent is not empty.** A field with no value is omitted from the
 *    layout entirely. Nothing ever prints "N/A", "-", "null" or "undefined"
 *    where a real business detail belongs.
 */
import { pool as _pool } from "@workspace/db";

/** The shared pg pool, typed structurally so these helpers stay injectable. */
type Pool = typeof _pool;

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface IssuerBank {
  holder: string;
  name: string;
  branch: string;
  accountNumber: string;
  ifsc: string;
  accountType: string;
  /** Where these details came from, so the caller can explain the choice. */
  source: "warehouse" | "company";
}

export interface InvoiceIssuer {
  /** Which record supplied the legal identity. */
  source: "warehouse" | "outlet" | "company";
  locationId: number | null;
  /** The location's own name, e.g. "Mysore Cold Store". */
  locationName: string;
  /** The name printed as the seller. */
  tradeName: string;
  /** Street/area lines, already split and trimmed. Never contains blanks. */
  addressLines: string[];
  phone: string;
  email: string;
  gstin: string;
  fssai: string;
  state: string;
  stateCode: string;
  /** Kept out of the address block so completeness can be judged on its own. */
  pincode: string;
  /** Null when neither the warehouse nor the company has an account on file. */
  bank: IssuerBank | null;
  upiId: string;
  invoiceFooter: string;
  signatory: string;
  /**
   * Human-readable gaps in this profile, e.g. a missing GSTIN. Surfaced in the
   * UI so an incomplete invoice is caught before it is sent, rather than after
   * a customer queries it.
   */
  incomplete: string[];
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** Trim to a string; null, undefined and non-strings collapse to "". */
function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/** Drop blanks and join — the workhorse behind "omit, never print a dash". */
function joinParts(parts: unknown[], sep: string): string {
  return parts.map(s).filter(Boolean).join(sep);
}

/**
 * Build the printable address block for a location.
 *
 * The free-text address field is user-entered and often already contains line
 * breaks; those are honoured rather than flattened into one long line. City,
 * district, state and pincode are assembled underneath in the order an Indian
 * postal address expects.
 */
function addressBlock(a: {
  address?: unknown; city?: unknown; district?: unknown; state?: unknown; pincode?: unknown;
}): string[] {
  const lines: string[] = [];
  for (const raw of s(a.address).split(/\r?\n/)) {
    const line = raw.trim();
    if (line) lines.push(line);
  }
  const locality = joinParts([a.city, a.district], ", ");
  if (locality) lines.push(locality);
  const region = s(a.pincode)
    ? joinParts([a.state], "") ? `${s(a.state)} - ${s(a.pincode)}` : s(a.pincode)
    : s(a.state);
  if (region) lines.push(region);
  return lines;
}

/**
 * The GST state code is the first two digits of the GSTIN.
 *
 * Warehouses created before the billing profile existed have a GSTIN but no
 * state code, and the intra/inter-state split on every invoice depends on it.
 * Deriving it costs nothing and matches how transfers already classify supply.
 */
export function stateCodeFromGstin(gstin: unknown): string {
  const m = /^(\d{2})/.exec(s(gstin));
  return m ? m[1] : "";
}

// ── Validation ───────────────────────────────────────────────────────────────

// 15 characters: 2-digit state code, 10-character PAN, 1 entity code, a
// literal Z, then the checksum character.
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PIN_RE = /^\d{6}$/;
const FSSAI_RE = /^\d{14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATE_CODE_RE = /^\d{2}$/;
const ACCOUNT_RE = /^[A-Za-z0-9]{5,25}$/;

/** Fields that are plain free text: trimmed, length-capped, never pattern-checked. */
const FREE_TEXT: Record<string, number> = {
  billingName: 120,
  city: 80,
  district: 80,
  bankAccountHolder: 120,
  bankName: 80,
  bankBranch: 80,
  invoiceFooter: 500,
  authorizedSignatory: 120,
};

/** Fields that must match a shape when present, with the message users see. */
const PATTERNED: Record<string, { re: RegExp; upper?: boolean; message: string }> = {
  gstNumber: { re: GSTIN_RE, upper: true, message: "GSTIN must be 15 characters in the standard GST format, e.g. 29ABCDE1234F1Z5." },
  stateCode: { re: STATE_CODE_RE, message: "State code must be the two-digit GST code, e.g. 29 for Karnataka." },
  pincode: { re: PIN_RE, message: "PIN code must be exactly 6 digits." },
  fssaiNumber: { re: FSSAI_RE, message: "FSSAI licence number must be exactly 14 digits." },
  ifscCode: { re: IFSC_RE, upper: true, message: "IFSC must be 11 characters, e.g. HDFC0001234." },
  bankAccountNumber: { re: ACCOUNT_RE, message: "Bank account number must be 5-25 letters or digits, with no spaces." },
  email: { re: EMAIL_RE, message: "Enter a valid email address." },
};

export type BillingNormalizeResult =
  | { ok: true; value: Record<string, string | null> }
  | { ok: false; field: string; error: string };

/**
 * Clean and check the billing fields of a warehouse create/update body.
 *
 * Only keys actually present are touched, so a PATCH that changes one field
 * cannot wipe the rest. An empty string means "clear this", and reaches the
 * column as NULL so every reader downstream has one absent value to test for
 * instead of two.
 *
 * Validation runs on the value *after* trimming and upper-casing, which is the
 * value that will be stored — checking the raw input would let " hdfc0001234 "
 * through and then store something that never matches the pattern again.
 */
export function normalizeWarehouseBilling(body: Record<string, unknown>): BillingNormalizeResult {
  const out: Record<string, string | null> = {};

  for (const [key, max] of Object.entries(FREE_TEXT)) {
    if (!(key in body)) continue;
    const v = s(body[key]);
    if (v.length > max) return { ok: false, field: key, error: `This field is limited to ${max} characters.` };
    out[key] = v || null;
  }

  for (const [key, rule] of Object.entries(PATTERNED)) {
    if (!(key in body)) continue;
    let v = s(body[key]);
    if (rule.upper) v = v.toUpperCase();
    if (v && !rule.re.test(v)) return { ok: false, field: key, error: rule.message };
    out[key] = v || null;
  }

  return { ok: true, value: out };
}

/**
 * GSTIN is the one billing field the table already requires, so it is checked
 * on its own path: create and update both send it, and a blank one would make
 * every invoice from that warehouse legally incomplete.
 */
export function validateGstin(value: unknown): string | null {
  const v = s(value).toUpperCase();
  if (!v) return "GSTIN is required — it identifies the registration this warehouse invoices under.";
  if (!GSTIN_RE.test(v)) return PATTERNED['gstNumber']!.message;
  return null;
}

// ── Resolution ───────────────────────────────────────────────────────────────

interface WarehouseRow {
  id: number; name: string; state: string | null; state_code: string | null; gst_number: string | null;
  address: string | null; phone: string | null; upi_id: string | null;
  billing_name: string | null; email: string | null; city: string | null; district: string | null;
  pincode: string | null; fssai_number: string | null;
  bank_account_holder: string | null; bank_name: string | null; bank_branch: string | null;
  bank_account_number: string | null; ifsc_code: string | null;
  invoice_footer: string | null; authorized_signatory: string | null;
}

const WAREHOUSE_COLS = `
  id, name, state, state_code, gst_number, address, phone, upi_id,
  billing_name, email, city, district, pincode, fssai_number,
  bank_account_holder, bank_name, bank_branch, bank_account_number, ifsc_code,
  invoice_footer, authorized_signatory`;

interface CompanyRow {
  company_name: string | null; address: string | null; city: string | null; state: string | null;
  pincode: string | null; phone: string | null; email: string | null; gst_number: string | null;
  bank_name: string | null; bank_account: string | null; ifsc_code: string | null;
  bank_branch: string | null; account_type: string | null; bank_account_holder: string | null;
  invoice_footer: string | null; upi_id: string | null;
}

async function loadCompany(pool: Pool): Promise<CompanyRow | null> {
  const { rows: [row] } = await pool.query<CompanyRow>(
    `SELECT company_name, address, city, state, pincode, phone, email, gst_number,
            bank_name, bank_account, ifsc_code, bank_branch, account_type, bank_account_holder,
            invoice_footer, upi_id
       FROM company_settings ORDER BY id LIMIT 1`,
  );
  return row ?? null;
}

/** A bank block is worth printing only if it names both an account and a bank. */
function warehouseBank(w: WarehouseRow): IssuerBank | null {
  const accountNumber = s(w.bank_account_number);
  const name = s(w.bank_name);
  if (!accountNumber && !name) return null;
  return {
    holder: s(w.bank_account_holder) || s(w.billing_name) || s(w.name),
    name,
    branch: s(w.bank_branch),
    accountNumber,
    ifsc: s(w.ifsc_code),
    accountType: "",
    source: "warehouse",
  };
}

function companyBank(c: CompanyRow | null): IssuerBank | null {
  if (!c) return null;
  const accountNumber = s(c.bank_account);
  const name = s(c.bank_name);
  if (!accountNumber && !name) return null;
  return {
    holder: s(c.bank_account_holder) || s(c.company_name),
    name,
    branch: s(c.bank_branch),
    accountNumber,
    ifsc: s(c.ifsc_code),
    accountType: s(c.account_type),
    source: "company",
  };
}

/**
 * Gaps worth telling the user about, in the order they matter for a tax
 * invoice — judged against the identity that will actually print.
 *
 * This must never run against a source row. What reaches the page is a mixture:
 * a warehouse with no bank of its own still prints the company's, and a trade
 * name left blank still prints the location's own name. Checking the row would
 * warn about fields the reader can plainly see on the document, and — worse —
 * an outlet inheriting a gap from its parent would be reported as complete.
 */
function gapsForIssuer(i: Omit<InvoiceIssuer, "incomplete">): string[] {
  const gaps: string[] = [];
  if (!i.gstin) gaps.push("GSTIN");
  if (!i.tradeName) gaps.push("Billing name");
  if (i.addressLines.length === 0) gaps.push("Address");
  if (!i.pincode) gaps.push("PIN code");
  if (!i.phone) gaps.push("Phone");
  if (!i.bank) gaps.push("Bank details");
  return gaps;
}

/** Attach the gap list to a freshly-built identity. The only way to make one. */
function sealed(i: Omit<InvoiceIssuer, "incomplete">): InvoiceIssuer {
  return { ...i, incomplete: gapsForIssuer(i) };
}

function fromWarehouse(w: WarehouseRow, company: CompanyRow | null): InvoiceIssuer {
  return sealed({
    source: "warehouse",
    locationId: w.id,
    locationName: s(w.name),
    tradeName: s(w.billing_name) || s(w.name),
    addressLines: addressBlock(w),
    phone: s(w.phone),
    email: s(w.email),
    gstin: s(w.gst_number),
    fssai: s(w.fssai_number),
    state: s(w.state),
    stateCode: s(w.state_code) || stateCodeFromGstin(w.gst_number),
    pincode: s(w.pincode),
    bank: warehouseBank(w) ?? companyBank(company),
    upiId: s(w.upi_id) || s(company?.upi_id),
    invoiceFooter: s(w.invoice_footer) || s(company?.invoice_footer),
    signatory: s(w.authorized_signatory),
  });
}

function fromCompany(company: CompanyRow | null): InvoiceIssuer {
  const c = company;
  return sealed({
    source: "company",
    locationId: null,
    locationName: "",
    tradeName: s(c?.company_name),
    addressLines: addressBlock({
      address: c?.address, city: c?.city, state: c?.state, pincode: c?.pincode,
    }),
    phone: s(c?.phone),
    email: s(c?.email),
    gstin: s(c?.gst_number),
    fssai: "",
    state: s(c?.state),
    stateCode: stateCodeFromGstin(c?.gst_number),
    pincode: s(c?.pincode),
    bank: companyBank(c ?? null),
    upiId: s(c?.upi_id),
    invoiceFooter: s(c?.invoice_footer),
    signatory: "",
  });
}

/**
 * The seller for a sale whose warehouse row has been deleted.
 *
 * Deliberately blank rather than the company profile. Substituting the company
 * would print a real but *wrong* GSTIN on a tax invoice — a filing problem for
 * whoever it names, and undetectable from the document. A visibly empty seller
 * block is recoverable: the gap list says exactly what happened, and the delete
 * guard on the warehouse route means this should never be reachable in the
 * first place.
 */
function missingLocationIssuer(source: "warehouse" | "outlet", id: number): InvoiceIssuer {
  return sealed({
    source,
    locationId: id,
    locationName: "",
    tradeName: "",
    addressLines: [],
    phone: "", email: "", gstin: "", fssai: "", state: "", stateCode: "", pincode: "",
    bank: null, upiId: "", invoiceFooter: "", signatory: "",
  });
}

/** Load one warehouse's billing profile by id. Null when it no longer exists. */
export async function loadWarehouseIssuer(pool: Pool, warehouseId: number): Promise<InvoiceIssuer | null> {
  const { rows: [w] } = await pool.query<WarehouseRow>(
    `SELECT ${WAREHOUSE_COLS} FROM warehouses WHERE id = $1`, [warehouseId],
  );
  if (!w) return null;
  return fromWarehouse(w, await loadCompany(pool));
}

/**
 * Every warehouse's resolved profile, keyed by id, in two queries.
 *
 * The admin list needs the gap list for each row, and the gaps only mean
 * anything once the company fallback has been applied — so the list cannot
 * re-derive them from the warehouse columns it already holds. Resolving here
 * keeps one definition of "incomplete" instead of a server copy and a drifting
 * client copy.
 */
export async function loadWarehouseIssuers(pool: Pool): Promise<Map<number, InvoiceIssuer>> {
  const [{ rows }, company] = await Promise.all([
    pool.query<WarehouseRow>(`SELECT ${WAREHOUSE_COLS} FROM warehouses ORDER BY id`),
    loadCompany(pool),
  ]);
  return new Map(rows.map(w => [w.id, fromWarehouse(w, company)]));
}

interface OutletRow {
  id: number; name: string; warehouse_id: number | null; address: string | null;
  phone: string | null; upi_id: string | null; gstin: string | null;
  state: string | null; state_code: string | null;
}

/**
 * Resolve the seller identity for a sale.
 *
 * `location_type`/`location_id` are the authoritative columns; `outlet_id` is
 * the legacy path and is null on every warehouse sale, so it is only consulted
 * when the newer columns say nothing.
 *
 * An outlet is a selling point of its parent warehouse rather than a
 * registration in its own right: it inherits the warehouse's legal identity and
 * bank account, but keeps whatever it does hold itself — its own name, address,
 * phone, GSTIN and UPI handle all override the parent's. That preserves the
 * long-standing behaviour where an outlet collects into its own UPI ID.
 */
export async function resolveInvoiceIssuer(pool: Pool, saleId: number): Promise<InvoiceIssuer> {
  const { rows: [loc] } = await pool.query<{
    location_type: string | null; location_id: number | null; outlet_id: number | null;
  }>(`SELECT location_type, location_id, outlet_id FROM sales WHERE id = $1`, [saleId]);

  if (loc?.location_type === "warehouse" && loc.location_id) {
    return resolveLocationIssuer(pool, "warehouse", loc.location_id);
  }
  const outletId = (loc?.location_type === "outlet" && loc.location_id) ? loc.location_id : loc?.outlet_id;
  return resolveLocationIssuer(pool, "outlet", outletId ?? null);
}

/**
 * Issuer for a document that identifies its location directly rather than via
 * a sales row — quotations, most notably. Same resolution rules as invoices:
 * the ISSUING LOCATION is the seller, with company settings only as fallback.
 */
export async function resolveLocationIssuer(
  pool: Pool,
  locationType: "warehouse" | "outlet" | null,
  locationId: number | null,
): Promise<InvoiceIssuer> {
  if (locationType === "warehouse" && locationId) {
    const issuer = await loadWarehouseIssuer(pool, locationId);
    return issuer ?? missingLocationIssuer("warehouse", locationId);
  }

  const outletId = locationType === "outlet" && locationId ? locationId : null;
  const company = await loadCompany(pool);
  if (!outletId) return fromCompany(company);

  const { rows: [o] } = await pool.query<OutletRow>(
    `SELECT id, name, warehouse_id, address, phone, upi_id, gstin, state, state_code
       FROM outlets WHERE id = $1`, [outletId],
  );
  if (!o) return missingLocationIssuer("outlet", outletId);

  const parent = o.warehouse_id
    ? (await pool.query<WarehouseRow>(`SELECT ${WAREHOUSE_COLS} FROM warehouses WHERE id = $1`, [o.warehouse_id])).rows[0]
    : undefined;
  const base = parent ? fromWarehouse(parent, company) : fromCompany(company);

  const ownAddress = addressBlock({ address: o.address, state: o.state });
  const resolved = {
    ...base,
    source: "outlet" as const,
    locationId: o.id,
    locationName: s(o.name),
    tradeName: s(o.name) || base.tradeName,
    addressLines: ownAddress.length > 0 ? ownAddress : base.addressLines,
    phone: s(o.phone) || base.phone,
    gstin: s(o.gstin) || base.gstin,
    state: s(o.state) || base.state,
    stateCode: s(o.state_code) || stateCodeFromGstin(o.gstin) || base.stateCode,
    upiId: s(o.upi_id) || base.upiId,
  };
  return sealed(resolved);
}
