import { disabledWarehouseError, WAREHOUSE_DISABLED_CODE } from "../lib/warehouseLifecycle";
/**
 * ERP Migration Wizard — staged replacement of an old ERP's books.
 *
 * MASTER modules (customers / vendors / ledgers / items) keep the direct flow:
 *   1. GET  /imports/templates/:module      → pre-filled sample .xlsx
 *   2. POST /imports/parse                  → upload + validate → batch preview
 *   3. POST /imports/batches/:id/commit     → create records (same code paths
 *                                             as manual creation), row by row
 *
 * TRANSACTION modules (sales / purchases / receipts / payments / daybook /
 * opening_stock) run the wizard:
 *   1. parse (analyse — NO writes)
 *   2. manual mapping — every file name (customer/vendor/product/ledger) must
 *      be mapped to an existing master or created, via import_mappings; the
 *      mapping memory is permanent and managed on the Manage Mappings screen.
 *      NO silent auto-matching: unmapped names hold the batch at needs_mapping.
 *   3. POST /imports/batches/:id/demo       → the ENTIRE batch runs through the
 *      SAME commit code path inside ONE never-committed transaction; the full
 *      report pack (TB, P&L, BS, receivables, vendor dues, cash/bank books,
 *      stock valuation) is computed on that client BEFORE the ROLLBACK and
 *      stored in demo_report for side-by-side comparison with the old ERP.
 *   4. POST /imports/batches/:id/approve    → same shared routine + COMMIT,
 *      all-or-nothing; or POST .../discard  → nothing was ever written.
 *
 * Every imported document draws a REAL ERP voucher/invoice number from the
 * allocators; the old ERP's number is stored as the searchable legacy
 * reference (legacy_invoice_number / legacy_voucher_number). Purchases keep
 * the vendor's bill number verbatim — that IS the legacy number.
 *
 * Rollback (committed batches) eligibility is decided from ACTUAL state at
 * rollback time, never from the history flag.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import express from "express";
import ExcelJS from "exceljs";
import { pool } from "@workspace/db";
import { requireModuleView, requireModuleAction } from "../middleware/permissions";
import { logActivity } from "../lib/audit";
import {
  createCustomerWithLedger, createVendorWithLedger,
  ensureCustomerLedger, ensureVendorLedger,
} from "../lib/partyCreate";
import { insertChartAccount, loadLedgerUsage } from "../lib/chartGroups";
import { upsertOpeningBalance, currentFinancialYear } from "../lib/openingBalances";
import { resolveActingLocation } from "../lib/productionCosting";
import { outletWritesBlocked, OUTLETS_DISABLED_MESSAGE } from "../lib/featureFlags";
import { isValidGstSlab } from "../lib/gst";
import { buildSaleLines } from "./sales";
import { buildDerivedPostings } from "./journal";
import { priceBill, buildNameMaps, resolveSupplyTaxType, type NameMaps } from "./purchases";
import {
  importSaleDoc, importPurchaseDoc,
  rollbackImportedSale, rollbackImportedPurchase,
} from "../lib/importTransactions";
import {
  importAccountOptions, importAccountContext, resolveAccountValue,
  importReceiptVoucher, importPaymentVoucher,
  rollbackImportedReceiptVoucher, rollbackImportedPaymentVoucher,
  type ForeignBankAccount,
} from "../lib/importVouchers";
import { itemCreateError, createItemCore } from "../lib/itemCreate";
import { convertLegacyReport, type LegacyConversionMeta } from "../lib/legacyReports";
import { createJournalVoucherCore } from "../lib/journalCreate";
import { importOpeningStockDoc, rollbackImportedOpeningStock } from "../lib/openingStockImport";
import { computeTrialBalance, computeCashBankBook } from "./journal";
import { buildBooks } from "../lib/books";
import { stockValuation, stockValuationRows } from "../lib/valuation";
import { buildLedgerBalanceIndex } from "../lib/ledgerBalances";
import { type ProdLocation } from "../lib/productionCosting";
import { outstandingExpr } from "../lib/salePaymentPosition";
import { purchaseSettlementIndex } from "../lib/vendorBillSettlement";
import { type PgPoolClient as PoolClient } from "@workspace/db";

const router: IRouter = Router();

const PERM = "page:/company/import";

type ImportModule =
  | "customers" | "vendors" | "ledgers" | "items"
  | "sales" | "purchases" | "receipts" | "payments"
  | "daybook" | "opening_stock";
const MODULES: ImportModule[] = [
  "customers", "vendors", "ledgers", "items",
  "sales", "purchases", "receipts", "payments",
  "daybook", "opening_stock",
];

/** Master modules commit records directly (they CREATE the masters the
 *  transaction modules map onto) — no demo stage, no mapping resolution. */
type MasterModule = "customers" | "vendors" | "ledgers" | "items";
const isMasterModule = (m: ImportModule): m is MasterModule =>
  m === "customers" || m === "vendors" || m === "ledgers" || m === "items";

/** Sales & purchases import whole DOCUMENTS (with stock + books effects), not
 *  master records — they get their own validation, commit and rollback paths. */
type TxnModule = "sales" | "purchases";
const isTxnModule = (m: ImportModule): m is TxnModule => m === "sales" || m === "purchases";

/** Receipt & payment VOUCHERS: one row = one voucher, allocated against the
 *  party's outstanding invoices with any excess parked as an advance. */
type VoucherModule = "receipts" | "payments";
const isVoucherModule = (m: ImportModule): m is VoucherModule => m === "receipts" || m === "payments";

/** Wizard (demo-capable) modules: everything that is NOT a master module.
 *  These run Analyse → Mapping → Demo → Approve/Discard. */
type DemoModule = TxnModule | VoucherModule | "daybook" | "opening_stock";
const isDemoModule = (m: ImportModule): m is DemoModule => !isMasterModule(m);

function asModule(v: unknown): ImportModule | null {
  const s = String(v ?? "").toLowerCase();
  return (MODULES as string[]).includes(s) ? (s as ImportModule) : null;
}

// ── Mapping memory ───────────────────────────────────────────────────────────
// import_mappings is the ONLY way a transaction-module file name resolves to a
// master record. kind ∈ customer | vendor | ledger | product; product rows
// carry target_kind (item | material | raw_material) because those id spaces
// overlap (polymorphic-stock-entries). The table is permanent memory: once
// "M/S Fresh Mart & Co" is mapped, every future file resolves it silently.

type MappingKind = "customer" | "vendor" | "ledger" | "product";
const MAPPING_KINDS: MappingKind[] = ["customer", "vendor", "ledger", "product"];
const MAPPING_LABEL: Record<MappingKind, string> = {
  customer: "Customer", vendor: "Vendor", ledger: "Ledger", product: "Item",
};

/** Normalised match key: lower-case, trimmed, internal whitespace squeezed. */
const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

interface MappingTarget { targetId: number; targetKind: string | null }

/** Record an unmapped name on a row's norm (deduped per row). Rows carrying
 *  any missing mapping validate as needs_mapping; the batch's mapping step
 *  aggregates these into the distinct name list the user works through. */
function addMissingMapping(norm: Record<string, any>, kind: MappingKind, name: string, routable = false) {
  const list: Array<{ kind: MappingKind; name: string; routable?: boolean }> = norm.missingMappings ?? (norm.missingMappings = []);
  if (!list.some((m) => m.kind === kind && normName(m.name) === normName(name))) {
    list.push(routable ? { kind, name, routable: true } : { kind, name });
  }
}

/** Queryable seam for the wizard's validation stack: every read defaults to
 *  the shared pool, but a caller that holds a transaction (the approve
 *  endpoint's revalidation) passes its client so validation sees the SAME
 *  transactional view as the writes it gates. */
type WizQ = { query: (sql: string, params?: unknown[]) => Promise<any> };

async function loadMappings(kind: MappingKind, q: WizQ = pool): Promise<Map<string, MappingTarget>> {
  const { rows } = await q.query(
    `SELECT source_norm, target_id, target_kind FROM import_mappings WHERE kind = $1`,
    [kind],
  );
  const map = new Map<string, MappingTarget>();
  for (const r of rows) map.set(String(r.source_norm), { targetId: Number(r.target_id), targetKind: r.target_kind ?? null });
  return map;
}

// ── Column specs ─────────────────────────────────────────────────────────────

interface ColSpec {
  key: string;
  header: string;
  required?: boolean;
  example: string | number;
  hint: string;
  /** normalized header aliases that map onto this column */
  aliases: string[];
  /** Not in the downloadable template, but still mapped when a file carries
   *  the column (old-ERP exports) — used for cross-check-only columns like
   *  GST amounts, which are computed from the masters, never recorded. */
  hidden?: boolean;
}

/** lower-case and strip everything that is not a letter or digit. */
const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const PARTY_COMMON: ColSpec[] = [
  { key: "phone", header: "Phone", example: "9876543210", hint: "10-digit mobile (91/0 prefix accepted)", aliases: ["phone", "mobile", "phoneno", "mobileno", "phonenumber", "mobilenumber", "contact", "contactno"] },
  { key: "email", header: "Email", example: "accounts@example.com", hint: "Email address", aliases: ["email", "emailid", "emailaddress", "mail"] },
  { key: "gstNumber", header: "GSTIN", example: "33AAACM1234F1Z5", hint: "15-character GSTIN, blank if unregistered", aliases: ["gstin", "gstno", "gstnumber", "gst", "gstinno"] },
  { key: "pan", header: "PAN", example: "AAACM1234F", hint: "10-character PAN, blank if unknown", aliases: ["pan", "panno", "pannumber"] },
  { key: "state", header: "State", example: "Tamil Nadu", hint: "State name", aliases: ["state", "statename"] },
  { key: "address", header: "Address", example: "12 Market Road, Chennai", hint: "Full address", aliases: ["address", "billingaddress", "addr"] },
];

const OPENING_COLS: ColSpec[] = [
  { key: "openingBalance", header: "Opening Balance", example: 25000, hint: "Amount as on migration date; blank or 0 for none", aliases: ["openingbalance", "opening", "openingbal", "obalance", "openingamount", "balance"] },
  { key: "openingType", header: "Opening Type (Dr/Cr)", example: "Dr", hint: "Dr or Cr", aliases: ["openingtype", "openingtypedrcr", "drcr", "balancetype", "type", "openingdrcr"] },
];

const NOTES_COL: ColSpec = { key: "notes", header: "Notes", example: "Migrated from old ERP", hint: "Free text", aliases: ["notes", "remarks", "note", "comment", "comments"] };

const PARTY_LOCATION_COL: ColSpec = {
  key: "location", header: "Location", required: true, example: "Head Office",
  hint: "Required — determines which branch/warehouse owns the imported record. Head Office, or the exact name of a warehouse/outlet",
  aliases: ["location", "locationname", "branch", "branchname", "assignedlocation", "site", "warehouse", "outlet"],
};

// Transaction/voucher files are imported INTO one location picked at upload;
// this column is an optional cross-check so a file exported for one branch
// cannot be silently committed into another.
const TXN_LOCATION_COL: ColSpec = {
  key: "location", header: "Location", example: "Head Office",
  hint: "Optional cross-check — must match the location you pick at upload; a different location is an error",
  aliases: ["location", "locationname", "branch", "branchname", "site"],
};

const TEMPLATES: Record<ImportModule, { title: string; columns: ColSpec[] }> = {
  customers: {
    title: "Customers",
    columns: [
      { key: "name", header: "Name", required: true, example: "Fresh Mart Traders", hint: "Customer name (required, must be unique)", aliases: ["name", "customername", "customer", "partyname", "party"] },
      ...PARTY_COMMON,
      PARTY_LOCATION_COL,
      { key: "creditLimit", header: "Credit Limit", example: 50000, hint: "₹ credit limit; blank or 0 for none", aliases: ["creditlimit", "creditlimitrs", "creditamount"] },
      ...OPENING_COLS,
      NOTES_COL,
    ],
  },
  vendors: {
    title: "Vendors",
    columns: [
      { key: "name", header: "Name", required: true, example: "Global Fruits Supply Co", hint: "Vendor name (required, must be unique)", aliases: ["name", "vendorname", "vendor", "suppliername", "supplier", "partyname", "party"] },
      ...PARTY_COMMON,
      PARTY_LOCATION_COL,
      ...OPENING_COLS,
      NOTES_COL,
    ],
  },
  ledgers: {
    title: "Ledgers",
    columns: [
      { key: "name", header: "Ledger Name", required: true, example: "Office Electricity", hint: "Ledger name (required, must be unique)", aliases: ["ledgername", "name", "accountname", "account", "ledger"] },
      { key: "group", header: "Ledger Group", required: true, example: "Indirect Expense", hint: "Must match an existing group — see the 'Valid Groups' sheet", aliases: ["ledgergroup", "group", "under", "parentgroup", "parent", "groupname", "accountgroup"] },
      PARTY_LOCATION_COL,
      ...OPENING_COLS,
      { key: "gstApplicable", header: "GST Applicable", example: "No", hint: "Yes or No", aliases: ["gstapplicable", "gst", "gstyn"] },
      NOTES_COL,
    ],
  },
  sales: {
    title: "Sales Invoices",
    columns: [
      { key: "invoiceNo", header: "Invoice No", example: "INV/25-26/0412", hint: "Old ERP invoice number — kept as the searchable old reference; the bill itself gets the next SB2B/SB2C number. Repeat it on every row of a multi-item invoice; blank rows get a placeholder", aliases: ["invoiceno", "invoicenumber", "invno", "invoice", "billno", "billnumber", "vchno", "voucherno", "vouchernumber"] },
      { key: "date", header: "Date", required: true, example: "2025-04-12", hint: "Invoice date — YYYY-MM-DD or DD/MM/YYYY", aliases: ["date", "invoicedate", "billdate", "saledate", "vchdate", "voucherdate"] },
      { key: "party", header: "Customer", required: true, example: "Fresh Mart Traders", hint: "Customer name — unknown names can be created in the resolve step before commit", aliases: ["customer", "customername", "party", "partyname", "buyer", "buyername", "client", "clientname"] },
      { key: "gstNumber", header: "GSTIN", example: "33AAACM1234F1Z5", hint: "Customer GSTIN — used to pre-fill missing customers and cross-checked against the master", aliases: ["gstin", "gstno", "gstnumber", "gstinno", "customergstin"] },
      { key: "item", header: "Item", required: true, example: "Frozen Mango Chunks 1kg", hint: "Must already exist in the Item Master — this import never creates items", aliases: ["item", "itemname", "product", "productname", "description", "particulars", "goods"] },
      { key: "quantity", header: "Qty", required: true, example: 10, hint: "Quantity sold (decimals allowed)", aliases: ["qty", "quantity", "nos", "pcs", "qtysold"] },
      { key: "unit", header: "Unit", example: "pcs", hint: "Optional — blank uses the Item Master unit; a different unit is warned on", aliases: ["unit", "uom", "units"] },
      { key: "price", header: "Price", required: true, example: 250, hint: "Per-unit selling price INCLUDING GST (the MRP / selling price), exactly like manual sale entry — GST is worked out from the Item Master rate. May be left blank when a Line Total is given", aliases: ["price", "rate", "unitprice", "saleprice", "priceperunit", "sellingprice", "mrp"] },
      { key: "lineTotal", header: "Line Total", example: "", hint: "Optional — the line's total ₹ (Qty × Price). When Price is blank the unit price is worked out as Line Total ÷ Qty; when both are given they are cross-checked", aliases: ["linetotal", "lineamount", "amount", "total", "totalamount", "netamount", "grossamount", "value", "linevalue", "rowtotal", "itemtotal", "amountrs"] },
      { key: "discount", header: "Discount", example: 0, hint: "₹ discount PER UNIT (blank = 0), like manual sale entry", aliases: ["discount", "discountamount", "less", "itemdiscount", "linediscount", "unitdiscount", "discountperunit"] },
      { key: "gstRate", header: "GST %", hidden: true, example: 5, hint: "Cross-check only — the recorded GST always comes from the Item Master rate", aliases: ["gst", "gstrate", "gstpercent", "gstpercentage", "taxrate", "tax"] },
      { key: "cgst", header: "CGST", hidden: true, example: 125, hint: "Cross-check only", aliases: ["cgst", "cgstamount"] },
      { key: "sgst", header: "SGST", hidden: true, example: 125, hint: "Cross-check only", aliases: ["sgst", "sgstamount"] },
      { key: "igst", header: "IGST", hidden: true, example: 0, hint: "Cross-check only", aliases: ["igst", "igstamount"] },
      { key: "billDiscount", header: "Bill Discount", example: 0, hint: "Pre-tax ₹ discount on the whole invoice (blank = 0) — put it on the invoice's FIRST row", aliases: ["billdiscount", "invoicediscount", "totaldiscount", "overalldiscount"] },
      { key: "paymentStatus", header: "Payment Status", example: "Paid", hint: "Paid / Unpaid / Partial. Paid with a blank Paid Amount = fully paid; Partial REQUIRES a Paid Amount; blank = Unpaid (or partly paid when a Paid Amount is given)", aliases: ["paymentstatus", "paystatus", "status"] },
      { key: "paidAmount", header: "Paid Amount", example: 2750, hint: "Amount received. Cash/UPI/Bank sales are always recorded fully paid; use Customer Credit + Paid Amount for partly-paid invoices", aliases: ["paidamount", "amountpaid", "paid", "received", "amountreceived", "receivedamount"] },
      { key: "paymentMode", header: "Payment Account", example: "Cash", hint: "Cash / Bank / UPI / Customer Credit (card, NEFT, RTGS, cheque count as Bank; blank = Customer Credit)", aliases: ["paymentaccount", "account", "paymentmode", "mode", "paymenttype", "method", "paymentmethod", "modeofpayment"] },
      { key: "reference", header: "Reference", example: "", hint: "Cheque / UTR / reference number", aliases: ["reference", "referenceno", "refno", "ref", "chequeno", "utr", "utrno", "txnid"] },
      { key: "narration", header: "Narration", example: "Migrated from old ERP", hint: "Free text (informational)", aliases: ["narration", "notes", "remarks", "note", "comment", "comments"] },
      TXN_LOCATION_COL,
    ],
  },
  purchases: {
    title: "Purchase Bills",
    columns: [
      { key: "invoiceNo", header: "Vendor Invoice No", example: "GF/2025/118", hint: "Vendor's bill number — kept exactly as supplied (unique per vendor); blank is allowed. Repeat it on every row of a multi-item bill", aliases: ["vendorinvoiceno", "invoiceno", "invoicenumber", "invno", "invoice", "billno", "billnumber", "purchasebillno", "vendorbillno", "vchno", "voucherno", "vouchernumber"] },
      { key: "date", header: "Date", required: true, example: "2025-04-10", hint: "Bill date — YYYY-MM-DD or DD/MM/YYYY", aliases: ["date", "billdate", "invoicedate", "purchasedate", "vchdate", "voucherdate"] },
      { key: "party", header: "Vendor", required: true, example: "Global Fruits Supply Co", hint: "Vendor name — unknown names can be created in the resolve step before commit", aliases: ["vendor", "vendorname", "supplier", "suppliername", "party", "partyname"] },
      { key: "gstNumber", header: "GSTIN", example: "29AAACG5678K1Z3", hint: "Vendor GSTIN — used to pre-fill missing vendors and cross-checked against the master", aliases: ["gstin", "gstno", "gstnumber", "gstinno", "vendorgstin"] },
      { key: "item", header: "Item", required: true, example: "Raw Mango", hint: "Finished product, raw material or packing material — must already exist in the masters", aliases: ["item", "itemname", "material", "materialname", "product", "productname", "particulars", "description", "goods"] },
      { key: "quantity", header: "Qty", required: true, example: 100, hint: "Quantity purchased (decimals allowed)", aliases: ["qty", "quantity", "nos", "pcs", "kgs"] },
      { key: "unit", header: "Unit", example: "kg", hint: "Optional — blank uses the product master unit; a different unit is warned on", aliases: ["unit", "uom", "units"] },
      { key: "rate", header: "Purchase Rate", required: true, example: 45, hint: "Per-unit cost EXCLUDING GST, like manual purchase entry — GST is added from the product master rate. May be left blank when a Line Total is given", aliases: ["purchaserate", "rate", "price", "unitcost", "cost", "purchaseprice", "unitprice", "costperunit"] },
      { key: "lineTotal", header: "Line Total", example: "", hint: "Optional — the line's total ₹ (Qty × Rate, before GST). When Rate is blank the unit rate is worked out as Line Total ÷ Qty; when both are given they are cross-checked", aliases: ["linetotal", "lineamount", "amount", "total", "totalamount", "netamount", "grossamount", "value", "linevalue", "rowtotal", "itemtotal", "amountrs"] },
      { key: "gstRate", header: "GST %", hidden: true, example: 5, hint: "Cross-check only — the recorded GST always comes from the product master rate", aliases: ["gst", "gstrate", "gstpercent", "gstpercentage", "taxrate", "tax"] },
      { key: "discount", header: "Discount %", example: 0, hint: "PERCENT discount on this line (0–100, blank = 0) — the purchase module's convention", aliases: ["discount", "discountpercent", "disc", "discountpct"] },
      { key: "billDiscount", header: "Bill Discount", hidden: true, example: 0, hint: "Not supported for purchases — spread it into the line Discount % instead", aliases: ["billdiscount", "invoicediscount", "totaldiscount", "overalldiscount"] },
      { key: "paymentStatus", header: "Payment Status", example: "Unpaid", hint: "Paid / Unpaid / Partial. Paid with a blank Paid Amount = fully paid; Partial REQUIRES a Paid Amount; blank = Unpaid (or partly paid when a Paid Amount is given)", aliases: ["paymentstatus", "paystatus", "status"] },
      { key: "paidAmount", header: "Paid Amount", example: 0, hint: "Amount already paid — recorded as a settlement from the Payment Account (blank account = the location's cash)", aliases: ["paidamount", "amountpaid", "paid", "advancepaid"] },
      { key: "otherChargeLedger", header: "Other Charge Ledger", example: "", hint: "Optional — an EXPENSE ledger from the Chart of Accounts for an incidental charge on the bill (freight, hamali, courier…). Each filled row adds one charge; posted to P&L and owed to the vendor, never into stock cost. Unknown names are errors — create the ledger first", aliases: ["otherchargeledger", "chargeledger", "expenseledger", "otherexpenseledger", "freightledger", "chargeaccount"] },
      { key: "otherChargeAmount", header: "Other Charge Amount", example: "", hint: "₹ amount for the Other Charge Ledger on this row — required when a ledger is named, and vice versa", aliases: ["otherchargeamount", "chargeamount", "otherchargeamt", "freightamount", "freightcharges", "othercharges"] },
      { key: "account", header: "Payment Account", example: "Cash", hint: "Where the Paid Amount was paid from: Cash, Bank, or the exact bank ledger name (blank = the location's cash)", aliases: ["paymentaccount", "account", "accountname", "paidfrom", "paidfromaccount", "paymentmode", "mode", "modeofpayment", "cashbank"] },
      { key: "reference", header: "Reference", example: "", hint: "Cheque / UTR / reference number", aliases: ["reference", "referenceno", "refno", "ref", "chequeno", "utr", "utrno", "txnid"] },
      { key: "narration", header: "Narration", example: "Migrated from old ERP", hint: "Stored on the bill", aliases: ["narration", "notes", "remarks", "note", "comment", "comments"] },
      TXN_LOCATION_COL,
    ],
  },
  receipts: {
    title: "Receipt Vouchers",
    columns: [
      { key: "voucherNo", header: "Voucher No", example: "RV/25-26/0087", hint: "Old ERP voucher number — stored as a searchable legacy reference; the ERP allocates its own receipt voucher number", aliases: ["voucherno", "vouchernumber", "vchno", "vchnumber", "receiptno", "receiptnumber", "rcptno", "no", "number"] },
      { key: "date", header: "Date", required: true, example: "2025-04-15", hint: "Receipt date — YYYY-MM-DD or DD/MM/YYYY", aliases: ["date", "receiptdate", "voucherdate", "vchdate", "txndate", "transactiondate"] },
      { key: "party", header: "Customer", required: true, example: "Fresh Mart Traders", hint: "Customer the money came from — unknown names can be created in the resolve step before commit", aliases: ["customer", "customername", "party", "partyname", "receivedfrom", "client", "clientname", "buyer"] },
      { key: "partyType", header: "Party Type", example: "Customer", hint: "Customer (receipts always settle customer invoices — cross-checked)", aliases: ["partytype", "type", "partykind"] },
      { key: "amount", header: "Amount", required: true, example: 5000, hint: "₹ amount received (must be greater than 0)", aliases: ["amount", "amountreceived", "received", "receivedamount", "total", "value", "amountrs"] },
      { key: "account", header: "Received In", example: "Cash", hint: "Cash, Bank, or the exact bank ledger name — decides whether the money lands in the cash book or bank book", aliases: ["receivedin", "receivedinaccount", "account", "accountname", "cashbank", "cashorbank", "depositto", "mode", "paymentmode", "modeofreceipt"] },
      { key: "againstInvoice", header: "Against Invoice", example: "", hint: "Optional invoice number — the amount settles ONLY that invoice; blank auto-allocates against the customer's oldest unpaid invoices", aliases: ["againstinvoice", "against", "againstbill", "invoiceno", "invoicenumber", "invoice", "billno", "billnumber", "againstinvoiceno"] },
      { key: "reference", header: "Reference", example: "", hint: "Cheque / UTR / reference number", aliases: ["reference", "referenceno", "refno", "ref", "chequeno", "utr", "utrno", "txnid"] },
      { key: "narration", header: "Narration", example: "Migrated from old ERP", hint: "Stored on the voucher", aliases: ["narration", "notes", "remarks", "note", "comment", "comments", "description"] },
      TXN_LOCATION_COL,
    ],
  },
  payments: {
    title: "Payment Vouchers",
    columns: [
      { key: "voucherNo", header: "Voucher No", example: "PV/25-26/0042", hint: "Old ERP voucher number — stored as a searchable legacy reference; the ERP allocates its own payment voucher number", aliases: ["voucherno", "vouchernumber", "vchno", "vchnumber", "paymentno", "paymentnumber", "no", "number"] },
      { key: "date", header: "Date", required: true, example: "2025-04-15", hint: "Payment date — YYYY-MM-DD or DD/MM/YYYY", aliases: ["date", "paymentdate", "voucherdate", "vchdate", "txndate", "transactiondate"] },
      { key: "party", header: "Vendor", required: true, example: "Global Fruits Supply Co", hint: "Vendor the money went to — unknown names can be created in the resolve step before commit", aliases: ["vendor", "vendorname", "supplier", "suppliername", "party", "partyname", "paidto"] },
      { key: "partyType", header: "Party Type", example: "Vendor", hint: "Vendor (payments always settle vendor bills — cross-checked)", aliases: ["partytype", "type", "partykind"] },
      { key: "amount", header: "Amount", required: true, example: 12000, hint: "₹ amount paid (must be greater than 0)", aliases: ["amount", "amountpaid", "paid", "paidamount", "total", "value", "amountrs"] },
      { key: "account", header: "Paid From", example: "Cash", hint: "Cash, Bank, or the exact bank ledger name — decides whether the money leaves the cash book or bank book", aliases: ["paidfrom", "paidfromaccount", "account", "accountname", "cashbank", "cashorbank", "paidoutof", "mode", "paymentmode", "modeofpayment"] },
      { key: "againstInvoice", header: "Against Bill", example: "", hint: "Optional bill number — the amount settles ONLY that bill; blank auto-allocates against the vendor's oldest unpaid bills", aliases: ["againstbill", "against", "againstinvoice", "billno", "billnumber", "invoiceno", "invoicenumber", "invoice", "againstbillno"] },
      { key: "reference", header: "Reference", example: "", hint: "Cheque / UTR / reference number", aliases: ["reference", "referenceno", "refno", "ref", "chequeno", "utr", "utrno", "txnid"] },
      { key: "narration", header: "Narration", example: "Migrated from old ERP", hint: "Stored on the voucher", aliases: ["narration", "notes", "remarks", "note", "comment", "comments", "description"] },
      TXN_LOCATION_COL,
    ],
  },
  items: {
    title: "Item Master",
    columns: [
      { key: "name", header: "Name", required: true, example: "Frozen Mango Dices 1kg", hint: "Finished-item name (required, must be unique)", aliases: ["name", "itemname", "item", "productname", "product", "description1"] },
      { key: "unit", header: "Unit", required: true, example: "kg", hint: "Selling unit — kg, pcs, box…", aliases: ["unit", "uom", "units", "unitofmeasure", "sellingunit"] },
      { key: "hsnCode", header: "HSN Code", example: "08119010", hint: "HSN/SAC code, blank if unknown", aliases: ["hsncode", "hsn", "hsnsac", "sac", "saccode"] },
      { key: "taxRate", header: "GST %", example: 5, hint: "GST slab: 0, 5, 12, 18 or 28", aliases: ["gst", "gstrate", "gstpercent", "taxrate", "tax", "taxpercent", "igstrate", "gstslabs"] },
      { key: "mrp", header: "MRP", example: 250, hint: "Maximum retail price per unit (sales are floored at MRP)", aliases: ["mrp", "maximumretailprice", "mrpperunit", "retailprice"] },
      { key: "cost", header: "Cost", example: 180, hint: "Purchase/production cost per unit (used until real purchases set the average cost)", aliases: ["cost", "costprice", "purchasecost", "purchaseprice", "costperunit", "rate"] },
      { key: "reorderLevel", header: "Reorder Level", example: 10, hint: "Low-stock alert threshold; blank = 10", aliases: ["reorderlevel", "reorder", "reorderqty", "minstock", "minimumstock"] },
      { key: "itemCode", header: "Item Code", example: "", hint: "Old ERP item code — blank rows draw the next code from the ERP's own series", aliases: ["itemcode", "code", "productcode", "skucode", "sku"] },
      { key: "barcode", header: "Barcode", example: "", hint: "EAN/UPC barcode; blank rows get an ERP-generated barcode", aliases: ["barcode", "ean", "eancode", "upc", "barcodeno"] },
      { key: "description", header: "Description", example: "", hint: "Free text", aliases: ["description", "desc", "itemdescription", "remarks", "notes"] },
    ],
  },
  daybook: {
    title: "Day Book (Journal / Contra)",
    columns: [
      { key: "voucherNo", header: "Voucher No", required: true, example: "JV/25-26/0012", hint: "Old ERP voucher number — rows sharing a number form ONE voucher; stored as a searchable legacy reference while the ERP allocates its own number", aliases: ["voucherno", "vouchernumber", "vchno", "vchnumber", "journalno", "journalnumber", "no", "number"] },
      { key: "date", header: "Date", required: true, example: "2025-04-15", hint: "Voucher date — YYYY-MM-DD or DD/MM/YYYY (one date per voucher)", aliases: ["date", "voucherdate", "vchdate", "journaldate", "txndate", "transactiondate"] },
      { key: "voucherType", header: "Voucher Type", example: "Journal", hint: "Journal or Contra; blank = Journal", aliases: ["vouchertype", "type", "vchtype", "journaltype"] },
      { key: "ledger", header: "Ledger", required: true, example: "Rent Expense", hint: "Account ledger for this leg — mapped to this ERP's chart of accounts in the mapping step", aliases: ["ledger", "ledgername", "account", "accountname", "accounthead", "particulars", "head"] },
      { key: "debit", header: "Debit", example: 5000, hint: "₹ debit amount (each row carries a debit OR a credit, never both)", aliases: ["debit", "debitamount", "dramount", "dr"] },
      { key: "credit", header: "Credit", example: "", hint: "₹ credit amount (each row carries a debit OR a credit, never both)", aliases: ["credit", "creditamount", "cramount", "cr"] },
      { key: "narration", header: "Narration", example: "April shop rent", hint: "Stored on the voucher (first non-blank row wins)", aliases: ["narration", "notes", "remarks", "note", "comment", "comments", "description"] },
      TXN_LOCATION_COL,
    ],
  },
  opening_stock: {
    title: "Opening Stock",
    columns: [
      { key: "date", header: "As-on Date", required: true, example: "2025-04-01", hint: "The date the opening quantities are as of — every row must carry the SAME date", aliases: ["asondate", "date", "openingdate", "asofdate", "stockdate"] },
      { key: "item", header: "Item", required: true, example: "Frozen Mango Dices 1kg", hint: "Finished item — mapped to this ERP's Item Master in the mapping step", aliases: ["item", "itemname", "product", "productname", "name", "particulars"] },
      { key: "quantity", header: "Quantity", required: true, example: 120, hint: "Opening quantity on hand (must be greater than 0)", aliases: ["quantity", "qty", "openingqty", "openingquantity", "stockqty", "closingqty", "balanceqty"] },
      { key: "unitCost", header: "Unit Cost", example: 180, hint: "GST-exclusive cost per unit; blank uses the item's current cost", aliases: ["unitcost", "cost", "costperunit", "rate", "costprice", "purchaserate", "avgcost", "averagecost"] },
      NOTES_COL,
      TXN_LOCATION_COL,
    ],
  },
};

// ── Cell / value normalisation ───────────────────────────────────────────────

/** exceljs cell values can be rich objects — flatten to a trimmed string. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as any;
    if (typeof o.text === "string") return o.text.trim();
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text ?? "").join("").trim();
    if (o.result !== undefined) return cellText(o.result);
    if (o.hyperlink && typeof o.hyperlink === "string") return String(o.text ?? o.hyperlink).trim();
  }
  return String(v).trim();
}

/** '' → null; strips ₹, commas and spaces; NaN/negative rejected by caller. */
function parseMoney(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[₹,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN as unknown as number;
}

function parseOpeningType(s: string): "debit" | "credit" | null | "invalid" {
  const t = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (["dr", "debit", "d"].includes(t)) return "debit";
  if (["cr", "credit", "c"].includes(t)) return "credit";
  return "invalid";
}

function parseYesNo(s: string): boolean | null | "invalid" {
  const t = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (["yes", "y", "true", "applicable"].includes(t)) return true;
  if (["no", "n", "false", "notapplicable", "na"].includes(t)) return false;
  return "invalid";
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Accepts bare 10-digit, or with 0 / 91 / +91 prefixes. Returns digits or null. */
function parsePhone(s: string): string | null | "invalid" {
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return "invalid";
}

/** YYYY-MM-DD (what cellText produces for real Date cells) or DD/MM/YYYY —
 *  also with - or . separators. Returns the ISO string or null. Rejects
 *  impossible calendar dates (31/02/2025). */
function parseDateFlexible(s: string): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else {
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
    if (!dmy) return null;
    d = +dmy[1]; m = +dmy[2]; y = +dmy[3];
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Old-ERP mode spellings → this system's four modes (card/NEFT/cheque → bank). */
function parsePaymentMode(s: string): "cash" | "bank" | "upi" | "credit" | null | "invalid" {
  const t = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (t === "cash") return "cash";
  if (["bank", "card", "creditcard", "debitcard", "neft", "rtgs", "imps", "cheque", "chq", "check", "dd", "banktransfer", "transfer", "online", "netbanking"].includes(t)) return "bank";
  if (["upi", "gpay", "googlepay", "phonepe", "paytm", "bhim", "qr"].includes(t)) return "upi";
  if (["credit", "customercredit", "udhaar", "udhar", "onaccount", "account", "due", "later"].includes(t)) return "credit";
  return "invalid";
}

function parsePaymentStatus(s: string): "paid" | "unpaid" | "partial" | null | "invalid" {
  const t = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (["paid", "settled", "full", "fullypaid", "fullpaid", "done", "yes", "closed", "cleared"].includes(t)) return "paid";
  if (["unpaid", "credit", "due", "pending", "no", "open", "outstanding", "notpaid"].includes(t)) return "unpaid";
  if (["partial", "partlypaid", "partiallypaid", "part", "partpaid", "partly"].includes(t)) return "partial";
  return "invalid";
}

/** Plain positive number with comma/space slack (quantities). */
function parseQty(s: string): number | null {
  const t = (s ?? "").replace(/[,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : (NaN as unknown as number);
}

// ── Ledger group resolution ──────────────────────────────────────────────────

interface ParentCandidate {
  id: number;
  name: string;
  type: string;
  section: string | null;
  isGroup: boolean;
}

/**
 * Valid parents for an imported ledger: every active group in the chart, plus
 * the Sundry Debtors / Sundry Creditors heads (leaf ledgers that already parent
 * the auto-provisioned party ledgers — the manual route allows leaf parents as
 * sub-ledger holders, so the import does too).
 */
async function loadParentCandidates(): Promise<ParentCandidate[]> {
  const { rows } = await pool.query<any>(`
    SELECT id, name, type, section, is_group FROM account_ledgers
    WHERE is_active IS NOT FALSE
      AND (is_group = true OR is_system_group = true OR code IN ('SYS-DEBTORS', 'SYS-CREDITORS'))
  `);
  return rows.map((r: any) => ({
    id: Number(r.id), name: String(r.name), type: String(r.type),
    section: r.section ?? null, isGroup: Boolean(r.is_group),
  }));
}

/** Common old-ERP spellings → this chart's group names. */
const GROUP_ALIASES: Record<string, string> = {
  asset: "Current Asset", assets: "Current Asset", currentassets: "Current Asset",
  fixedassets: "Fixed Asset", fixedasset: "Fixed Asset",
  liability: "Current Liabilities", liabilities: "Current Liabilities", currentliability: "Current Liabilities",
  loans: "Loans (Liability)", loan: "Loans (Liability)", loansliability: "Loans (Liability)",
  capital: "Capital Accounts", capitalaccount: "Capital Accounts", capitalaccounts: "Capital Accounts",
  purchases: "Purchase", purchaseaccounts: "Purchase",
  salesaccounts: "Sales", sale: "Sales",
  directexpenses: "Direct Expense", indirectexpenses: "Indirect Expense",
  expense: "Indirect Expense", expenses: "Indirect Expense",
  directincomes: "Direct Income", indirectincomes: "Indirect Income",
  income: "Indirect Income", incomes: "Indirect Income",
};

function resolveGroup(raw: string, candidates: ParentCandidate[]): ParentCandidate | null {
  const n = normHeader(raw);
  if (!n) return null;
  const byNorm = new Map(candidates.map((c) => [normHeader(c.name), c]));
  const direct = byNorm.get(n);
  if (direct) return direct;
  // singular/plural slack: "Fixed Assets" → "Fixed Asset"
  const singular = n.endsWith("s") ? n.slice(0, -1) : `${n}s`;
  const loose = byNorm.get(singular);
  if (loose) return loose;
  const alias = GROUP_ALIASES[n];
  if (alias) return byNorm.get(normHeader(alias)) ?? null;
  return null;
}

const groupSuggestion = (candidates: ParentCandidate[]) =>
  `Valid groups: ${candidates.map((c) => c.name).sort((a, b) => a.localeCompare(b)).join(", ")}`;

// ── Validation ───────────────────────────────────────────────────────────────

interface RowVerdict {
  /** needs_mapping: valid row whose customer/vendor/product/ledger name has no
   *  saved mapping yet — the user maps or creates the master on the batch's
   *  mapping step (POST /imports/batches/:id/mappings), then re-validation
   *  promotes the row. ("needs_party" is the retired pre-wizard spelling; old
   *  batches may still carry it in the DB.) */
  status: "valid" | "warning" | "error" | "needs_mapping";
  reason: string | null;
  suggestion: string | null;
  duplicateOfId: number | null;
  /** normalized values the commit will use */
  norm: Record<string, unknown>;
}

interface ValidateContext {
  existingByName: Map<string, number>;
  /** existing ledger flags for duplicate messaging (ledgers module only) */
  existingLedgerMeta?: Map<string, { id: number; system: boolean }>;
  seenNames: Map<string, number>; // lower name → first row number in this file
  parentCandidates?: ParentCandidate[];
  /** party modules: normalized location name → resolved location */
  partyLocations?: Map<string, { type: string; id: number; name: string }>;
  /** party modules: `${type}:${id}` keys the uploader may assign; null = all (Head Office) */
  allowedLocationKeys?: Set<string> | null;
  /** items module: lower item_code / barcode → item id (uniqueness pre-check) */
  existingItemCodes?: Map<string, number>;
  existingBarcodes?: Map<string, number>;
}

function validateRow(
  module: ImportModule,
  rowNumber: number,
  values: Record<string, string>,
  ctx: ValidateContext,
): RowVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const norm: Record<string, unknown> = {};
  let duplicateOfId: number | null = null;

  const name = (values.name ?? "").trim();
  if (!name) {
    errors.push(module === "ledgers" ? "Ledger Name is required" : "Name is required");
  } else if (name.length < 2) {
    errors.push("Name must be at least 2 characters");
  } else if (name.length > 120) {
    errors.push("Name is limited to 120 characters");
  }
  norm.name = name;

  // in-file duplicate: the SECOND occurrence is the error
  if (name) {
    const key = name.toLowerCase();
    const first = ctx.seenNames.get(key);
    if (first !== undefined) {
      errors.push(`Duplicate of row ${first} in this file`);
      suggestions.push("Keep one row per name — remove or rename the duplicate");
    } else {
      ctx.seenNames.set(key, rowNumber);
      const existing = ctx.existingByName.get(key);
      if (existing !== undefined) {
        duplicateOfId = existing;
        if (module === "ledgers" && ctx.existingLedgerMeta?.get(key)?.system) {
          errors.push(`"${name}" already exists as a system account and cannot be imported over`);
          suggestions.push("Rename this ledger, or record its opening balance on the existing account");
        } else {
          warnings.push(`"${name}" already exists — will be skipped or updated per your choice at commit`);
        }
      }
    }
  }

  if (module === "customers" || module === "vendors") {
    const gst = (values.gstNumber ?? "").trim().toUpperCase();
    if (gst) {
      if (!GSTIN_RE.test(gst)) {
        errors.push(`GSTIN "${gst}" is not a valid 15-character GSTIN`);
        suggestions.push("Format: 2-digit state code + PAN + entity digit + Z + check digit, e.g. 33AAACM1234F1Z5");
      }
      norm.gstNumber = gst;
    }
    const pan = (values.pan ?? "").trim().toUpperCase();
    if (pan) {
      if (!PAN_RE.test(pan)) {
        errors.push(`PAN "${pan}" is not a valid 10-character PAN`);
        suggestions.push("Format: 5 letters + 4 digits + 1 letter, e.g. AAACM1234F");
      }
      norm.pan = pan;
    }
    if (gst && pan && GSTIN_RE.test(gst) && PAN_RE.test(pan) && gst.slice(2, 12) !== pan) {
      warnings.push("PAN does not match the PAN embedded in the GSTIN");
    }
    const phone = parsePhone((values.phone ?? "").trim());
    if (phone === "invalid") {
      errors.push(`Phone "${values.phone}" is not a 10-digit number`);
      suggestions.push("Use a 10-digit mobile number (91/0 prefix accepted)");
    } else if (phone) {
      norm.phone = phone;
    }
    const email = (values.email ?? "").trim();
    if (email) {
      if (!EMAIL_RE.test(email)) {
        errors.push(`Email "${email}" does not look like an email address`);
        suggestions.push("Use name@domain.tld, or leave blank");
      }
      norm.email = email.toLowerCase();
    }
    if ((values.state ?? "").trim()) norm.state = values.state.trim();
    if ((values.address ?? "").trim()) norm.address = values.address.trim();
    if ((values.notes ?? "").trim()) norm.notes = values.notes.trim();

    if (module === "customers") {
      const cl = parseMoney((values.creditLimit ?? "").trim());
      if (cl !== null) {
        if (!Number.isFinite(cl) || cl < 0) errors.push(`Credit Limit "${values.creditLimit}" must be a number ≥ 0`);
        else norm.creditLimit = cl;
      }
    }
  }

  if (module === "ledgers") {
    const groupRaw = (values.group ?? "").trim();
    const candidates = ctx.parentCandidates ?? [];
    if (!groupRaw) {
      errors.push("Ledger Group is required");
      suggestions.push(groupSuggestion(candidates));
    } else {
      const parent = resolveGroup(groupRaw, candidates);
      if (!parent) {
        errors.push(`"${groupRaw}" is not a valid ledger group`);
        suggestions.push(groupSuggestion(candidates));
      } else {
        norm.groupName = parent.name;
        norm.groupId = parent.id;
        norm.groupType = parent.type;
        if (normHeader(parent.name) !== normHeader(groupRaw)) {
          warnings.push(`Group "${groupRaw}" matched "${parent.name}"`);
        }
      }
    }
    const gstApp = parseYesNo((values.gstApplicable ?? "").trim());
    if (gstApp === "invalid") warnings.push(`GST Applicable "${values.gstApplicable}" not understood — leaving unset (use Yes or No)`);
    else if (gstApp !== null) norm.gstApplicable = gstApp;
    if ((values.notes ?? "").trim()) norm.notes = values.notes.trim();
  }

  if (module === "items") {
    const unit = (values.unit ?? "").trim();
    if (!unit) errors.push("Unit is required (kg, pcs, box…)");
    else norm.unit = unit;

    const hsn = (values.hsnCode ?? "").trim();
    if (hsn) {
      if (hsn.length > 16) errors.push("HSN Code cannot exceed 16 characters");
      else norm.hsnCode = hsn;
    }

    const taxRaw = (values.taxRate ?? "").trim();
    const tax = parseMoney(taxRaw);
    if (tax !== null) {
      if (!Number.isFinite(tax) || !isValidGstSlab(tax)) {
        errors.push(`GST % "${taxRaw}" is not a GST slab`);
        suggestions.push("Use 0, 5, 12, 18 or 28");
      } else norm.taxRate = tax;
    }
    for (const [key, label] of [["mrp", "MRP"], ["cost", "Cost"], ["reorderLevel", "Reorder Level"]] as const) {
      const v = parseMoney((values[key] ?? "").trim());
      if (v !== null) {
        if (!Number.isFinite(v) || v < 0) errors.push(`${label} "${values[key]}" must be a number ≥ 0`);
        else norm[key] = v;
      }
    }
    const code = (values.itemCode ?? "").trim();
    if (code) {
      if (/\s/.test(code) || code.length > 32) errors.push("Item Code cannot contain spaces or exceed 32 characters");
      else {
        norm.itemCode = code;
        const clash = ctx.existingItemCodes?.get(code.toLowerCase());
        if (clash !== undefined) errors.push(`Item Code "${code}" is already used by another item`);
      }
    }
    const barcode = (values.barcode ?? "").trim();
    if (barcode) {
      if (/\s/.test(barcode) || barcode.length > 64) errors.push("Barcode cannot contain spaces or exceed 64 characters");
      else {
        norm.barcode = barcode;
        const clash = ctx.existingBarcodes?.get(barcode.toLowerCase());
        if (clash !== undefined) errors.push(`Barcode "${barcode}" is already used by another item`);
      }
    }
    if ((values.description ?? "").trim()) norm.description = values.description.trim();
  }

  // Assigned location — REQUIRED for all three master modules: every imported
  // customer, vendor and ledger is owned by exactly one branch/warehouse
  // (spec: "Location determines which branch/warehouse owns the imported
  // record"). A named location must exist AND be inside the uploader's scope:
  // a branch user must not be able to home a record outside (or hide one
  // from) their own branch.
  if (ctx.partyLocations) {
    const locRaw = (values.location ?? "").trim();
    if (!locRaw) {
      errors.push("Location is required — it decides which branch/warehouse owns this record");
      suggestions.push(`Use "Head Office" or an exact warehouse/outlet name`);
    } else {
      const lkey = normHeader(locRaw);
      const resolved = (lkey === "headoffice" || lkey === "ho" || lkey === "hq")
        ? { type: "headoffice", id: 0, name: "Head Office" }
        : ctx.partyLocations.get(lkey);
      if (!resolved) {
        errors.push(`Location "${locRaw}" does not match Head Office or any warehouse/outlet`);
        suggestions.push(`Use "Head Office" or an exact warehouse/outlet name`);
      } else if (ctx.allowedLocationKeys && resolved.type === "headoffice" && !ctx.allowedLocationKeys.has("headoffice:0")) {
        errors.push(`You do not have access to assign records to Head Office`);
        suggestions.push("Use your own location's name in the Location column");
      } else if (ctx.allowedLocationKeys && resolved.type !== "headoffice" && !ctx.allowedLocationKeys.has(`${resolved.type}:${resolved.id}`)) {
        errors.push(`You do not have access to assign records to "${resolved.name}"`);
        suggestions.push("Use your own location's name in the Location column");
      } else {
        norm.locationType = resolved.type;
        norm.locationId = resolved.id;
        norm.locationName = resolved.name;
      }
    }
  }

  // Opening balance + Dr/Cr — all three modules
  const ob = parseMoney((values.openingBalance ?? "").trim());
  if (ob !== null) {
    if (!Number.isFinite(ob) || ob < 0) {
      errors.push(`Opening Balance "${values.openingBalance}" must be a number ≥ 0`);
    } else if (ob > 0) {
      norm.openingBalance = ob;
      const t = parseOpeningType((values.openingType ?? "").trim());
      if (t === "invalid") {
        errors.push(`Opening Type "${values.openingType}" must be Dr or Cr`);
      } else if (t === null) {
        const fallback =
          module === "customers" ? "debit"
          : module === "vendors" ? "credit"
          : ["asset", "expense"].includes(String(norm.groupType ?? "")) ? "debit" : "credit";
        norm.openingType = fallback;
        warnings.push(`Opening Type blank — defaulting to ${fallback === "debit" ? "Dr" : "Cr"}`);
      } else {
        norm.openingType = t;
      }
    }
  }

  if (errors.length > 0) {
    return { status: "error", reason: errors.join("; "), suggestion: suggestions[0] ?? null, duplicateOfId, norm };
  }
  if (warnings.length > 0) {
    return { status: "warning", reason: warnings.join("; "), suggestion: suggestions[0] ?? null, duplicateOfId, norm };
  }
  return { status: "valid", reason: null, suggestion: null, duplicateOfId, norm };
}

// ── Transaction validation (sales & purchases) ──────────────────────────────

interface TxnProduct {
  kind: "item" | "material" | "raw_material";
  id: number;
  name: string;
  taxRate: number;
  unit: string;
  mrp: number;
}

const KIND_LABEL: Record<TxnProduct["kind"], string> = {
  item: "a finished product", material: "a packing material", raw_material: "a raw material",
};

interface TxnParty { id: number; name: string; gst: string; state: string }

interface TxnContext {
  products: Map<string, TxnProduct[]>; // lower(name) → candidates (>1 = ambiguous)
  nameMaps: NameMaps;                  // priceBill's id-keyed master maps (purchases)
  parties: Map<string, TxnParty>;      // lower(name) → customer/vendor
  existingInvoices: Set<string>;       // sales: lower(inv); purchases: `${vendorId}|${lower(inv)}`
  companyState: string;
  stockAvail: Map<number, number>;     // sales: item id → qty at the target location
  /** Purchases: the location's valid money accounts (cash till + bank leaves)
   *  for resolving the Payment Account cell — same options as voucher imports. */
  accounts: Awaited<ReturnType<typeof importAccountOptions>>;
  /** Purchases: bank ledgers owned by OTHER locations — never resolvable here,
   *  but named in errors so "no bank exists" is never claimed when one does. */
  foreignBanks: ForeignBankAccount[];
  /** Purchases: postable expense ledgers an "Other Charge Ledger" cell may
   *  name (lower(name) → ledger) — the same set the manual bill form offers,
   *  and the same rules importPurchaseDoc re-validates at commit. */
  expenseLedgers: Map<string, { id: number; name: string }>;
  /** Product names the user mapped to a bill-charge expense ledger
   *  (import_mappings kind='product', target_kind='charge') — old-software
   *  purchase reports list charges like "PACKING AND TRANSPORT" as item
   *  lines. norm(name) → ledger. Purchases only; on a sales file it errors. */
  chargeMappings: Map<string, { id: number; name: string }>;
  settings: ImportSettings;
}

/** Expense ledgers valid for Other Purchase Charges: postable, active,
 *  expense-type, not internal, and not inside the Purchase (SYS-PUR) subtree —
 *  mirrors lib/otherCharges.ts. Unknown names are ERRORS, not a resolve step:
 *  auto-creating a ledger from a typo would scatter the chart of accounts. */
async function importExpenseLedgerOptions(q: WizQ = pool): Promise<Map<string, { id: number; name: string }>> {
  const { rows } = await q.query(`
    WITH RECURSIVE pur AS (
      SELECT id FROM account_ledgers WHERE code = 'SYS-PUR'
      UNION ALL
      SELECT c.id FROM account_ledgers c JOIN pur p ON c.parent_id = p.id
    )
    SELECT id, name FROM account_ledgers
     WHERE type = 'expense'
       AND NOT COALESCE(is_group, false) AND NOT COALESCE(is_system_group, false)
       AND COALESCE(is_active, true)
       AND id NOT IN (SELECT id FROM pur)
       AND (code IS NULL OR code !~ '^(SYS-|SAL-EMP-|SAL-PAY-|ADV-EMP-|GST-|STD-BRANCH-)')
     ORDER BY id`);
  const map = new Map<string, { id: number; name: string }>();
  for (const r of rows) {
    const key = String(r.name ?? "").trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, { id: Number(r.id), name: String(r.name) });
  }
  return map;
}

/**
 * Product masters, resolved through import_mappings kind='product'. Each
 * mapping row targets ONE master (target_kind disambiguates the overlapping
 * item/material/raw_material id spaces — polymorphic-stock-entries). All
 * three tables are loaded so a sales file whose name maps to a packing
 * material can say so precisely instead of "not found".
 */
async function loadMappedProducts(q: WizQ = pool): Promise<Map<string, TxnProduct[]>> {
  const metaByKind = new Map<TxnProduct["kind"], Map<number, TxnProduct>>();
  const load = async (kind: TxnProduct["kind"], sql: string) => {
    const { rows } = await q.query(sql);
    const m = new Map<number, TxnProduct>();
    for (const r of rows) m.set(Number(r.id), { kind, id: Number(r.id), name: String(r.name), taxRate: Number(r.tax_rate ?? 0), unit: String(r.unit ?? ""), mrp: Number(r.mrp ?? 0) });
    metaByKind.set(kind, m);
  };
  await load("item", `SELECT id, name, COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(unit, '') AS unit, COALESCE(mrp, 0)::float8 AS mrp FROM items`);
  await load("material", `SELECT id, name, COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(unit, '') AS unit, 0 AS mrp FROM materials`);
  await load("raw_material", `SELECT id, name, COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(unit, '') AS unit, 0 AS mrp FROM raw_materials`);

  const products = new Map<string, TxnProduct[]>();
  const mappings = await loadMappings("product", q);
  for (const [norm, t] of mappings) {
    if (t.targetKind === "charge") continue; // routed to a bill-charge ledger, not a product
    const kind = (t.targetKind === "material" || t.targetKind === "raw_material") ? t.targetKind : "item";
    const meta = metaByKind.get(kind)?.get(t.targetId);
    if (meta) products.set(norm, [meta]); // stale target → unmapped → needs_mapping
  }
  return products;
}

/** Product names routed to a bill-charge expense ledger (target_kind
 *  'charge'). Only ledgers still eligible as purchase charges resolve —
 *  a stale/retired target sends the name back to the mapping step. */
async function loadChargeMappings(q: WizQ = pool): Promise<Map<string, { id: number; name: string }>> {
  const eligible = await importExpenseLedgerOptions(q);
  const byId = new Map<number, { id: number; name: string }>();
  for (const v of eligible.values()) byId.set(v.id, v);
  const out = new Map<string, { id: number; name: string }>();
  for (const [norm, t] of await loadMappings("product", q)) {
    if (t.targetKind !== "charge") continue;
    const led = byId.get(t.targetId);
    if (led) out.set(norm, led);
  }
  return out;
}

/** Customers/vendors, resolved through import_mappings. */
async function loadMappedParties(kind: "customer" | "vendor", q: WizQ = pool): Promise<Map<string, TxnParty>> {
  const table = kind === "customer" ? "customers" : "vendors";
  const { rows } = await q.query(
    `SELECT id, name, COALESCE(gst_number, '') AS gst, COALESCE(state, '') AS state FROM ${table}`,
  );
  const byId = new Map<number, TxnParty>();
  for (const r of rows) byId.set(Number(r.id), { id: Number(r.id), name: String(r.name), gst: String(r.gst), state: String(r.state) });

  const parties = new Map<string, TxnParty>();
  for (const [norm, t] of await loadMappings(kind, q)) {
    // target_kind 'ledger'/'skip' rows are voucher-import routing decisions
    // (non-party accounts in old-software receipt/payment reports) — they
    // never resolve to a customer/vendor.
    if (t.targetKind != null) continue;
    const meta = byId.get(t.targetId);
    if (meta) parties.set(norm, meta); // stale target → unmapped → needs_mapping
  }
  return parties;
}

/** Legacy-migration behaviour toggles (Company Settings → Data Import).
 *  Everything defaults ON — a fresh company gets the forgiving behaviour;
 *  each can be switched off to force strict review instead. */
interface ImportSettings {
  /** Sales: a blank Customer on a cash/bank/UPI sale = walk-in counter sale (no customer). */
  autoWalkInCustomer: boolean;
  /** Sales: a price below the Item Master MRP is folded into a per-unit discount (POS rule). */
  mrpToDiscount: boolean;
  /** A "Line Total" column can stand in for a blank Price/Rate (unit = total ÷ qty). */
  detectLineTotal: boolean;
}

async function loadImportSettings(q: WizQ = pool): Promise<ImportSettings> {
  const { rows: [r] } = await q.query(`SELECT general_settings FROM company_settings LIMIT 1`);
  const gs = (r?.general_settings ?? {}) as Record<string, any>;
  return {
    autoWalkInCustomer: gs.importAutoWalkInCustomer !== false,
    mrpToDiscount: gs.importMrpToDiscount !== false,
    detectLineTotal: gs.importDetectLineTotal !== false,
  };
}

async function loadTxnContext(module: TxnModule, loc: { type: string; id: number }, q: WizQ = pool): Promise<TxnContext> {
  // Mapping-based resolution: a file name resolves to a master ONLY through a
  // saved import_mappings row (kind + normalised name → target). No silent
  // name matching — an unmapped name holds the row at needs_mapping until the
  // user maps or creates the master. Stale mappings (target deleted since)
  // are skipped, which sends the name back to the mapping step.
  const products = await loadMappedProducts(q);
  const parties = await loadMappedParties(module === "sales" ? "customer" : "vendor", q);

  const existingInvoices = new Set<string>();
  if (module === "sales") {
    // Both numbers guard against re-importing the same file: bills renumbered
    // into the SB2B/SB2C series keep their original number in
    // legacy_invoice_number, and the import source still carries the original.
    const { rows } = await q.query(
      `SELECT lower(invoice_number) AS inv, lower(legacy_invoice_number) AS legacy_inv
         FROM sales WHERE invoice_number IS NOT NULL`
    );
    for (const r of rows) {
      existingInvoices.add(String(r.inv));
      if (r.legacy_inv) existingInvoices.add(String(r.legacy_inv));
    }
  } else {
    const { rows } = await q.query(`SELECT vendor_id, lower(invoice_number) AS inv FROM purchases WHERE invoice_number IS NOT NULL`);
    for (const r of rows) existingInvoices.add(`${Number(r.vendor_id)}|${String(r.inv)}`);
  }

  const { rows: [comp] } = await q.query(`SELECT COALESCE(state, '') AS state FROM company_settings LIMIT 1`);

  const stockAvail = new Map<number, number>();
  if (module === "sales") {
    const branchId = loc.type === "headoffice" ? 1 : loc.id;
    const { rows } = await q.query(
      `SELECT item_id, quantity::float8 AS qty FROM stock_entries
        WHERE material_type = 'item' AND branch_type = $1 AND branch_id = $2`,
      [loc.type, branchId],
    );
    for (const r of rows) stockAvail.set(Number(r.item_id), Number(r.qty));
  }

  return {
    products,
    nameMaps: module === "purchases" ? await buildNameMaps(q) : ({ material: new Map(), raw_material: new Map(), item: new Map() } as unknown as NameMaps),
    parties, existingInvoices,
    companyState: String(comp?.state ?? "").trim().toLowerCase(),
    stockAvail,
    ...(module === "purchases"
      ? await (async () => {
          const acc = await importAccountContext(q, loc as ProdLocation);
          return { accounts: acc.options, foreignBanks: acc.foreignBanks };
        })()
      : { accounts: [], foreignBanks: [] }),
    expenseLedgers: module === "purchases" ? await importExpenseLedgerOptions(q) : new Map(),
    chargeMappings: await loadChargeMappings(q),
    settings: await loadImportSettings(q),
  };
}

interface TxnRowInput { rowNumber: number; values: Record<string, string> }

interface TxnDocAcc {
  key: string | null;
  headIdx: number;
  rowIdxs: number[];
  inv: string;
  dateIso: string | null;
  party: TxnParty | null;
  partyName: string;
  billDiscount: number;
  status: "paid" | "unpaid" | "partial" | null;
  paidGiven: number | null;
  modeGiven: "cash" | "bank" | "upi" | "credit" | null;
  /** Purchases only: the Payment Account cell (Cash / Bank / exact ledger name). */
  accountRaw: string;
  reference: string | null;
  narration: string | null;
  /** Sales: blank Customer on a settled (cash/bank/upi) sale → POS-style
   *  walk-in bill with NO customer (Company Settings → Data Import toggle). */
  walkIn?: boolean;
}

/**
 * Multi-pass validation for transaction imports.
 *
 * Pass 0 groups rows into documents by INVOICE NUMBER alone — rows of one
 * invoice may sit anywhere in the file (legacy exports are rarely sorted
 * bill-by-bill). Blank invoice numbers = single-row documents. Blank
 * Date/Customer cells inherit the invoice's values; conflicting non-blank
 * values are hard errors. Document order = first-appearance order, so the
 * file's entry order still drives average-cost/stock sequencing at commit.
 * Pass 1 normalises each line (product, qty, price — optionally derived from
 * a Line Total cell). Pass 2 prices each complete document through the SAME
 * arithmetic commit will use (buildSaleLines / priceBill) so paid-amount
 * checks and GST cross-checks can never disagree with what gets recorded.
 */
/**
 * Optional per-row Location cross-check for transaction/voucher files.
 * Every document in the file is recorded at the batch's location (picked at
 * upload) — a non-blank Location cell must therefore name that SAME location.
 * This catches "exported for branch A, imported into branch B" mistakes.
 * Mirror-safe: matches on the normalised NAME, never on type+id.
 */
async function loadRowLocationCheck(loc: { type: string; id: number }, q: WizQ = pool): Promise<(locRaw: string) => string | null> {
  const [{ rows: whs }, { rows: outs }] = await Promise.all([
    q.query(`SELECT id, name FROM warehouses`),
    q.query(`SELECT id, name FROM outlets`),
  ]);
  const known = new Set<string>();
  for (const r of [...whs, ...outs]) known.add(normHeader(String(r.name)));
  let batchName = "Head Office";
  if (loc.type === "warehouse") batchName = String(whs.find((w: any) => Number(w.id) === loc.id)?.name ?? "warehouse");
  else if (loc.type === "outlet") batchName = String(outs.find((o: any) => Number(o.id) === loc.id)?.name ?? "outlet");
  return (locRaw: string): string | null => {
    const lkey = normHeader(locRaw);
    const isHO = lkey === "headoffice" || lkey === "ho" || lkey === "hq";
    const matches = loc.type === "headoffice" ? isHO : lkey === normHeader(batchName);
    if (matches) return null;
    if (!isHO && !known.has(lkey)) {
      return `Location "${locRaw}" does not match Head Office or any warehouse/outlet`;
    }
    return `Location "${locRaw}" does not match "${batchName}" — this file is being imported into ${batchName}; re-upload with the right location selected`;
  };
}

async function validateTransactionRows(
  module: TxnModule,
  rowsIn: TxnRowInput[],
  loc: { type: string; id: number }, q: WizQ = pool,
): Promise<{
  results: RowVerdict[];
  counts: { valid: number; warning: number; error: number; needsMapping: number };
}> {
  const ctx = await loadTxnContext(module, loc, q);
  const checkRowLoc = await loadRowLocationCheck(loc, q);
  const todayIso = new Date().toISOString().slice(0, 10);
  const partyLabel = module === "sales" ? "Customer" : "Vendor";

  type Slot = { errors: string[]; warnings: string[]; suggestions: string[]; norm: Record<string, any> };
  const slots: Slot[] = rowsIn.map(() => ({ errors: [], warnings: [], suggestions: [], norm: {} }));

  // ── Pass 0: order-independent grouping by Invoice No ──
  // Every row carrying the same (non-blank) invoice number belongs to ONE
  // document no matter where it sits in the file. Blank invoice numbers =
  // single-row documents. Document order = FIRST-APPEARANCE order, so entry
  // order still drives average-cost/stock sequencing at commit.
  const docs: TxnDocAcc[] = [];
  const docOf: number[] = new Array(rowsIn.length).fill(-1);
  {
    const docByInv = new Map<string, number>();
    for (let i = 0; i < rowsIn.length; i++) {
      const invRaw = (rowsIn[i].values.invoiceNo ?? "").trim();
      const invKey = invRaw.toLowerCase();
      const existing = invRaw ? docByInv.get(invKey) : undefined;
      if (existing !== undefined) {
        docs[existing].rowIdxs.push(i);
        docOf[i] = existing;
        continue;
      }
      docs.push({
        key: invRaw ? invKey : null, headIdx: i, rowIdxs: [i], inv: invRaw,
        dateIso: null, party: null, partyName: "",
        billDiscount: 0, status: null, paidGiven: null, modeGiven: null,
        accountRaw: "", reference: null, narration: null,
      });
      docOf[i] = docs.length - 1;
      if (invRaw) docByInv.set(invKey, docs.length - 1);
    }
  }

  // ── Document-level cells: date, party, settlement fields ──
  // Blank cells on repeat rows inherit the invoice's value (first non-blank
  // wins); CONFLICTING non-blank values are errors for date/party (one bill
  // cannot carry two dates or two parties) and warnings for the rest.
  for (const doc of docs) {
    const head = slots[doc.headIdx];
    const docLabel = doc.inv ? `Invoice "${doc.inv}"` : `Row ${rowsIn[doc.headIdx].rowNumber}`;

    const docCell = (k: string, label: string, warnOnConflict = true): string => {
      let v = ""; let fromRow = 0;
      for (const i of doc.rowIdxs) {
        const c = (rowsIn[i].values[k] ?? "").trim();
        if (!c) continue;
        if (!v) { v = c; fromRow = rowsIn[i].rowNumber; }
        else if (warnOnConflict && c !== v) {
          slots[i].warnings.push(`${label} "${c}" differs from "${v}" (row ${fromRow}) — the invoice's first value is used`);
        }
      }
      return v;
    };

    // Date — conflicting parseable dates are errors; blanks inherit.
    let dateFromRow = 0;
    for (const i of doc.rowIdxs) {
      const raw = (rowsIn[i].values.date ?? "").trim();
      if (!raw) continue;
      const iso = parseDateFlexible(raw);
      if (!iso) {
        slots[i].errors.push(`Date "${raw}" not understood`);
        slots[i].suggestions.push("Use YYYY-MM-DD or DD/MM/YYYY");
        continue;
      }
      if (doc.dateIso === null) { doc.dateIso = iso; dateFromRow = rowsIn[i].rowNumber; }
      else if (iso !== doc.dateIso) {
        slots[i].errors.push(`${docLabel} has two different dates — ${doc.dateIso} (row ${dateFromRow}) vs ${iso} here; one invoice must carry ONE date`);
        slots[i].suggestions.push("Fix the date, or renumber the row if it is genuinely a different invoice");
      }
    }
    if (!doc.dateIso) head.errors.push("Date is required");
    else if (doc.dateIso > todayIso) head.warnings.push(`Date ${doc.dateIso} is in the future`);

    // Party — conflicting non-blank names are errors; blanks inherit.
    let partyFromRow = 0;
    for (const i of doc.rowIdxs) {
      const raw = (rowsIn[i].values.party ?? "").trim();
      if (!raw) continue;
      if (!doc.partyName) { doc.partyName = raw; partyFromRow = rowsIn[i].rowNumber; }
      else if (raw.toLowerCase() !== doc.partyName.toLowerCase()) {
        slots[i].errors.push(`${docLabel} names two different ${partyLabel.toLowerCase()}s — "${doc.partyName}" (row ${partyFromRow}) vs "${raw}" here; one invoice belongs to ONE ${partyLabel.toLowerCase()}`);
        slots[i].suggestions.push("Fix the name, or renumber the row if it is genuinely a different invoice");
      }
    }
    doc.party = doc.partyName ? ctx.parties.get(normName(doc.partyName)) ?? null : null;

    // Settlement / other document-level fields.
    doc.accountRaw = docCell("account", "Payment Account");
    doc.reference = docCell("reference", "Reference") || null;
    doc.narration = docCell("narration", "Narration", false) || null;
    if (module === "sales") {
      const bdRaw = docCell("billDiscount", "Bill Discount");
      const bd = parseMoney(bdRaw);
      if (bd !== null) {
        if (!Number.isFinite(bd) || bd < 0) head.errors.push(`Bill Discount "${bdRaw}" must be a number ≥ 0`);
        else doc.billDiscount = bd;
      }
      const pmRaw = docCell("paymentMode", "Payment Account");
      const pm = parsePaymentMode(pmRaw);
      if (pm === "invalid") head.warnings.push(`Payment Account "${pmRaw}" not understood — treating the sale as Customer Credit (use Cash / Bank / UPI / Customer Credit)`);
      else doc.modeGiven = pm;
    } else {
      // Purchases have no bill-level discount — the manual purchase module
      // works in per-line Discount %, and an import must never produce a
      // bill that manual entry could not.
      const bdRaw = docCell("billDiscount", "Bill Discount");
      const bd = parseMoney(bdRaw);
      if (bd !== null && bd > 0.004) {
        head.errors.push(`Bill Discount ₹${bd} is not supported for purchase bills`);
        head.suggestions.push("Spread the bill discount into each line's Discount % (the purchase module has no bill-level discount)");
      }
    }
    const stRaw = docCell("paymentStatus", "Payment Status");
    const st = parsePaymentStatus(stRaw);
    if (st === "invalid") head.warnings.push(`Payment Status "${stRaw}" not understood — treating as Unpaid (use Paid / Unpaid / Partial)`);
    else doc.status = st;
    const paRaw = docCell("paidAmount", "Paid Amount");
    const pa = parseMoney(paRaw);
    if (pa !== null) {
      if (!Number.isFinite(pa) || pa < 0) head.errors.push(`Paid Amount "${paRaw}" must be a number ≥ 0`);
      else doc.paidGiven = pa;
    }

    // Blank customer → walk-in (sales only; the POS rule: settled modes may
    // omit the customer, credit cannot — someone has to owe the money).
    if (!doc.partyName) {
      if (module !== "sales") {
        head.errors.push("Vendor is required");
      } else {
        const effMode = doc.modeGiven ?? (doc.status === "paid" ? "cash" : "credit");
        if (effMode === "credit") {
          head.errors.push("Customer is required for a credit sale — a bill with no customer (walk-in) must be Cash, Bank or UPI");
          head.suggestions.push("Fill the Customer column, or set Payment Account to Cash/Bank/UPI if it was a settled counter sale");
        } else if (!ctx.settings.autoWalkInCustomer) {
          head.errors.push("Customer is required");
          head.suggestions.push("Fill the Customer column, or switch on \u201cBlank customer = walk-in sale\u201d under Company Settings → Data Import");
        } else {
          doc.walkIn = true;
          head.warnings.push("No customer name — recorded as a walk-in counter sale (no customer on the bill), like a POS cash sale");
        }
      }
    } else if (!doc.party) {
      // Unmapped party name → the mapping step. NEVER auto-created and never
      // silently matched: the user maps the old-ERP name onto an existing
      // master (or creates one) once, and the mapping is remembered forever.
      const mk = module === "sales" ? "customer" : "vendor";
      for (const i of doc.rowIdxs) addMissingMapping(slots[i].norm, mk, doc.partyName);
      head.suggestions.push(`Map "${doc.partyName}" to an existing ${partyLabel.toLowerCase()} (or create it) in the mapping step`);
    }

    // Already-recorded invoices / placeholder-number note (head row).
    if (doc.inv) {
      if (module === "sales" && ctx.existingInvoices.has(doc.inv.toLowerCase())) {
        head.errors.push(`Invoice "${doc.inv}" is already recorded in this system`);
        head.suggestions.push("Already-migrated or manually entered — remove the row, or renumber if it is genuinely a different invoice");
      }
      if (module === "purchases" && doc.party && ctx.existingInvoices.has(`${doc.party.id}|${doc.inv.toLowerCase()}`)) {
        head.errors.push(`Invoice "${doc.inv}" is already recorded for ${doc.party.name}`);
        head.suggestions.push("Already-migrated or manually entered — remove the row, or renumber if it is genuinely a different bill");
      }
    } else if (module === "sales") {
      head.warnings.push("No invoice number — a placeholder (IMP-<batch>-<n>) will be assigned at commit");
    }
  }

  const stockNeeded = new Map<number, number>(); // running requirement across the whole file (sales)

  // ── Pass 1: per-row line normalisation ──
  for (let i = 0; i < rowsIn.length; i++) {
    const { values } = rowsIn[i];
    const s = slots[i];
    const doc = docs[docOf[i]];
    s.norm.doc = docOf[i];
    if (doc.headIdx === i) s.norm.head = true;
    if (doc.dateIso) s.norm.dateIso = doc.dateIso;

    // Location cross-check (optional column)
    const rowLocRaw = (values.location ?? "").trim();
    if (rowLocRaw) {
      const locErr = checkRowLoc(rowLocRaw);
      if (locErr) s.errors.push(locErr);
    }

    // GSTIN cross-check (against the document's party)
    const gst = (values.gstNumber ?? "").trim().toUpperCase();
    if (gst) {
      if (!GSTIN_RE.test(gst)) {
        s.errors.push(`GSTIN "${gst}" is not a valid 15-character GSTIN`);
        s.suggestions.push("Format: 2-digit state code + PAN + entity digit + Z + check digit, e.g. 33AAACM1234F1Z5");
      } else if (doc.party?.gst && doc.party.gst.toUpperCase() !== gst) {
        s.warnings.push(`GSTIN differs from the ${partyLabel.toLowerCase()} master (${doc.party.gst}) — the master's GSTIN is used`);
      }
    }

    // Product — resolved ONLY through a saved product mapping. A name the
    // user mapped as a BILL CHARGE (old-software purchase reports list
    // freight/packing as item lines) becomes an other-charge on the bill
    // instead of a stock line — purchases only.
    const itemName = (values.item ?? "").trim();
    let product: TxnProduct | null = null;
    let charge: { id: number; name: string } | null = null;
    if (!itemName) {
      s.errors.push("Item is required");
    } else if (ctx.chargeMappings.has(normName(itemName))) {
      if (module !== "purchases") {
        s.errors.push(`"${itemName}" is mapped as a bill charge — that treatment exists for purchase bills only`);
        s.suggestions.push("Re-point the mapping at a product on the Manage Mappings screen");
      } else {
        charge = ctx.chargeMappings.get(normName(itemName))!;
      }
    } else {
      const mapped = (ctx.products.get(normName(itemName)) ?? [])[0] ?? null;
      if (!mapped) {
        addMissingMapping(s.norm, "product", itemName);
        s.suggestions.push(`Map "${itemName}" to a product (or create the item) in the mapping step`);
      } else if (module === "sales" && mapped.kind !== "item") {
        s.errors.push(`"${itemName}" is mapped to ${KIND_LABEL[mapped.kind]} — sales sell finished items only`);
        s.suggestions.push("Fix the mapping on the Manage Mappings screen to point at a finished item");
      } else {
        product = mapped;
      }
    }

    // Quantity
    const qty = parseQty(values.quantity ?? "");
    if (qty === null) s.errors.push("Qty is required");
    else if (!Number.isFinite(qty) || qty <= 0) s.errors.push(`Qty "${values.quantity}" must be a number greater than 0`);

    // Discount (parsed before the price so Line Total cross-checks can
    // account for it). Sales: ₹ per UNIT; purchases: % per line.
    let discount = 0;
    const discRaw = (values.discount ?? "").trim();
    if (module === "sales") {
      const d = parseMoney(discRaw);
      if (d !== null) {
        if (!Number.isFinite(d) || d < 0) s.errors.push(`Discount "${discRaw}" must be a number ≥ 0`);
        else discount = d;
      }
    } else {
      const d = discRaw ? Number(discRaw.replace(/%/g, "").replace(/,/g, "")) : null;
      if (d !== null) {
        if (!Number.isFinite(d) || d < 0 || d > 100) s.errors.push(`Discount % "${discRaw}" must be between 0 and 100`);
        else discount = d;
      }
    }

    // Price / rate — a Line Total cell can stand in for a blank price
    // (legacy exports often carry amount-only lines). Toggle-gated.
    const priceKey = module === "sales" ? "price" : "rate";
    const priceLabel = module === "sales" ? "Price" : "Rate";
    let price = parseMoney((values[priceKey] ?? "").trim());
    const ltRaw = (values.lineTotal ?? "").trim();
    const lt = ctx.settings.detectLineTotal && ltRaw ? parseMoney(ltRaw) : null;
    if (lt !== null && (!Number.isFinite(lt) || lt < 0)) {
      s.errors.push(`Line Total "${ltRaw}" must be a number ≥ 0`);
    } else if (lt !== null && qty !== null && Number.isFinite(qty) && qty > 0) {
      const round2 = (n: number) => Math.round(n * 100) / 100;
      if (price === null) {
        // The Line Total is what the row PAID, i.e. net of any discount on
        // the row. The pricing engine applies the discount again, so the
        // derived unit figure must be the GROSS one (discount added back) —
        // deriving lt÷qty and then discounting again would understate money.
        if (discount > 0 && module !== "sales" && discount >= 99.995) {
          s.errors.push(`Cannot work out the ${priceLabel} from the Line Total with a 100% discount — give the ${priceLabel} explicitly`);
        } else {
          price = module === "sales"
            ? round2(lt / qty + discount)
            : round2(lt / qty / (1 - discount / 100));
          const discNote = discount > 0
            ? (module === "sales"
              ? ` (Line Total taken as AFTER the ₹${discount.toFixed(2)}/unit discount)`
              : ` (Line Total taken as AFTER the ${discount}% discount)`)
            : "";
          s.warnings.push(`${priceLabel} was blank — unit ${priceLabel.toLowerCase()} ₹${price.toFixed(2)} worked out as Line Total ₹${lt.toFixed(2)} ÷ Qty ${qty}${discNote}`);
        }
      } else if (Number.isFinite(price) && price >= 0) {
        const gross = price * qty;
        const net = module === "sales" ? (price - discount) * qty : gross * (1 - discount / 100);
        const tol = Math.max(0.05, lt * 0.001);
        if (Math.abs(gross - lt) <= tol || Math.abs(net - lt) <= tol) {
          // consistent — nothing to flag
        } else if (discount === 0 && qty > 1.0001 && Math.abs(price - lt) <= 0.01) {
          // Price column holds the line total. Only unpacked when there is
          // NO discount — with one, gross vs net is ambiguous, so the row
          // falls through to the mismatch warning and the Price column wins.
          price = round2(lt / qty);
          s.warnings.push(`The ${priceLabel} column holds the LINE TOTAL (₹${lt.toFixed(2)} for ${qty} units) — unit ${priceLabel.toLowerCase()} ₹${price.toFixed(2)} recorded instead`);
        } else {
          s.warnings.push(`Check this row: Line Total ₹${lt.toFixed(2)} does not match ${priceLabel} × Qty = ₹${round2(gross).toFixed(2)} — the ${priceLabel} column is used`);
        }
      }
    }
    if (price === null) s.errors.push(`${priceLabel} is required${ctx.settings.detectLineTotal ? " (or give a Line Total to work it out from)" : ""}`);
    else if (!Number.isFinite(price) || price < 0) s.errors.push(`${priceLabel} "${values[priceKey]}" must be a number ≥ 0`);

    if (module === "sales" && price !== null && Number.isFinite(price) && discount > price + 0.004) {
      s.errors.push(`Discount ₹${discount} per unit exceeds the Price ₹${Number(price).toFixed(2)} — Discount is per UNIT, not for the whole line`);
    }

    // Unit + GST% cross-checks against the master
    if (product) {
      const unitGiven = (values.unit ?? "").trim();
      if (unitGiven && product.unit && unitGiven.toLowerCase() !== product.unit.toLowerCase()) {
        s.warnings.push(`Unit "${unitGiven}" differs from the master ("${product.unit}") — quantities are taken as ${product.unit}`);
      }
      const gstGiven = (values.gstRate ?? "").trim();
      if (gstGiven && Number.isFinite(Number(gstGiven)) && Math.abs(Number(gstGiven) - product.taxRate) > 0.004) {
        s.warnings.push(`GST% ${gstGiven} differs from the master rate ${product.taxRate}% — the master rate is recorded`);
      }
      if (module === "purchases" && !isValidGstSlab(product.taxRate)) {
        s.errors.push(`"${product.name}" has GST rate ${product.taxRate}% in the master, which is not a valid slab`);
        s.suggestions.push("Fix the product master's GST rate (0, 5, 12, 18 or 28), then re-upload");
      }
      // POS convention (checkMrpFloor in routes/sales.ts): the recorded MRP
      // can never sit below the Item Master MRP — MRP is only ever raised.
      // A file price below MRP is recorded exactly like the POS would: price
      // = master MRP, with the difference folded into the per-unit discount
      // (the customer's net price is unchanged). A price above MRP becomes
      // the line's MRP as-is with the file's discount kept.
      let linePrice = (price !== null && Number.isFinite(price)) ? price : 0;
      let lineUnitDiscount = discount;
      if (module === "sales" && product.mrp > 0 && linePrice < product.mrp - 0.004) {
        if (ctx.settings.mrpToDiscount) {
          lineUnitDiscount = Math.round((discount + (product.mrp - linePrice)) * 100) / 100;
          s.warnings.push(
            `Price ₹${linePrice.toFixed(2)} is below the Item Master MRP ₹${product.mrp.toFixed(2)} for ${product.name} — recorded like the POS: MRP ₹${product.mrp.toFixed(2)} with ₹${lineUnitDiscount.toFixed(2)}/unit discount (net price unchanged)`,
          );
          linePrice = product.mrp;
        } else {
          s.errors.push(`Price ₹${linePrice.toFixed(2)} is below the Item Master MRP ₹${product.mrp.toFixed(2)} for ${product.name}`);
          s.suggestions.push("Fix the price, or switch on \u201cRecord below-MRP prices as discounts\u201d under Company Settings → Data Import");
        }
      }
      if (product && qty !== null && Number.isFinite(qty) && qty > 0) {
        // Sales lines carry the manual-entry semantics: GST-INCLUSIVE price
        // and a per-UNIT discount (`unitDiscount`). Rows validated before this
        // convention keep their legacy `discount` (line-total, exclusive
        // price) shape — the commit path honours whichever key is present.
        s.norm.line = module === "sales"
          ? { kind: "item", id: product.id, name: product.name, quantity: qty, price: linePrice, unitDiscount: lineUnitDiscount }
          : { kind: product.kind, id: product.id, name: product.name, quantity: qty, rate: price ?? 0, discountPct: discount };
      }

      // Stock snapshot warning (sales) — cumulative across the file
      if (module === "sales" && qty !== null && Number.isFinite(qty) && qty > 0) {
        const needed = (stockNeeded.get(product.id) ?? 0) + qty;
        stockNeeded.set(product.id, needed);
        const have = ctx.stockAvail.get(product.id) ?? 0;
        if (needed > have + 0.001) {
          s.warnings.push(`Stock check: this file needs ${needed} of "${product.name}" but the location holds ${have} right now — the document will fail at commit if stock is still short`);
        }
      }
    }

    // Charge-mapped line (purchases): the row's money becomes a bill charge —
    // posted to the mapped expense ledger and owed to the vendor, never into
    // stock. The vendor is owed the INCLUSIVE figure, so any GST on the row
    // (file amounts first, else the file's GST%) folds into the charge.
    if (charge && qty !== null && Number.isFinite(qty) && qty > 0
        && price !== null && Number.isFinite(price) && price >= 0) {
      const round2c = (n: number) => Math.round(n * 100) / 100;
      const base = round2c(price * qty * (1 - discount / 100));
      const fileGstAmt = (parseMoney((values.cgst ?? "").trim()) ?? 0)
        + (parseMoney((values.sgst ?? "").trim()) ?? 0)
        + (parseMoney((values.igst ?? "").trim()) ?? 0);
      const pctRaw = Number((values.gstRate ?? "").trim());
      const gstAmt = fileGstAmt > 0.004
        ? round2c(fileGstAmt)
        : (Number.isFinite(pctRaw) && pctRaw > 0 ? round2c(base * pctRaw / 100) : 0);
      const amount = round2c(base + gstAmt);
      if (amount <= 0) {
        s.errors.push(`Bill charge "${itemName}" works out to ₹0 — give the row a rate above zero`);
      } else {
        s.norm.chargeLine = { ledgerId: charge.id, ledgerName: charge.name, amount };
        s.warnings.push(`"${itemName}" is a bill charge — ₹${amount.toFixed(2)}${gstAmt > 0 ? " (incl. GST)" : ""} posts to "${charge.name}" and is owed to the vendor; it never enters stock`);
      }
    }

    // Other Purchase Charges — an optional (ledger, amount) pair on any row of
    // the bill. Both-or-neither: an amount without a ledger (or the reverse)
    // is a hard error, never a silent skip that understates the vendor's dues.
    if (module === "purchases") {
      const ocLedgerRaw = (values.otherChargeLedger ?? "").trim();
      const ocAmtRaw = (values.otherChargeAmount ?? "").trim();
      if (ocLedgerRaw || ocAmtRaw) {
        const amt = parseMoney(ocAmtRaw);
        if (!ocLedgerRaw) {
          s.errors.push(`Other Charge Amount "${ocAmtRaw}" has no Other Charge Ledger — name the expense ledger it belongs to`);
        } else if (amt === null || !Number.isFinite(amt) || amt <= 0) {
          s.errors.push(`Other Charge Amount "${ocAmtRaw || "(blank)"}" must be a number above zero when an Other Charge Ledger is named`);
        } else {
          const led = ctx.expenseLedgers.get(ocLedgerRaw.toLowerCase());
          if (!led) {
            s.errors.push(`Other Charge Ledger "${ocLedgerRaw}" is not a postable expense ledger in the Chart of Accounts — create it under Accounts → Chart of Accounts first, then re-validate`);
          } else {
            s.norm.otherCharge = { ledgerId: led.id, ledgerName: led.name, amount: Math.round(amt * 100) / 100 };
          }
        }
      }
    }

  }

  // ── Pass 2: document-level pricing + settlement resolution ──
  const supplyCache = new Map<number, Awaited<ReturnType<typeof resolveSupplyTaxType>>>();
  for (let dIdx = 0; dIdx < docs.length; dIdx++) {
    const doc = docs[dIdx];
    const head = slots[doc.headIdx];
    const anyError = doc.rowIdxs.some((i) => slots[i].errors.length > 0);
    // A charge-mapped purchase row has no stock line — its chargeLine stands in.
    const anyMissingLine = doc.rowIdxs.some((i) => !slots[i].norm.line && !slots[i].norm.chargeLine);
    if (anyError || anyMissingLine || !doc.dateIso) continue;
    // Unmapped names stay unpriced — they hold the batch at the mapping step
    // and re-validation prices them once the mapping is saved.
    if (!doc.party && !doc.walkIn) continue;
    // Purchases: rows mapped as bill charges fold into the bill's other
    // charges below — the pricing engine only ever sees the goods rows.
    const goodsIdxs = doc.rowIdxs.filter((i) => slots[i].norm.line);
    if (module === "purchases" && goodsIdxs.length === 0) {
      head.errors.push("Every line of this bill is mapped as a bill charge — a purchase bill needs at least one stock line. Enter pure-expense bills as journal vouchers instead, or re-point a mapping at a product");
      continue;
    }

    let total = 0;
    let computedTax = 0;
    let computedTaxable = 0;
    let computedQty = 0;
    let computedDiscount = 0;
    let otherChargesTot = 0;
    if (module === "sales") {
      const itemTaxMap = new Map<number, { taxRate: number; name: string; hsnCode: string | null; unit: string | null }>();
      for (const i of doc.rowIdxs) {
        const l = slots[i].norm.line;
        const p = (ctx.products.get(String(l.name).toLowerCase()) ?? [])[0];
        itemTaxMap.set(Number(l.id), { taxRate: p?.taxRate ?? 0, name: l.name, hsnCode: null, unit: p?.unit ?? null });
      }
      // Walk-in / to-be-created customers have no state on record →
      // intra-state, the same default manual entry lands on.
      const custState = String(doc.party?.state ?? "").trim().toLowerCase();
      const isInterState = !!(ctx.companyState && custState && ctx.companyState !== custState);
      // Manual-entry semantics: prices INCLUDE GST, discount is per unit.
      const built = buildSaleLines(
        doc.rowIdxs.map((i) => {
          const l = slots[i].norm.line;
          return { itemId: l.id, quantity: l.quantity, unitPrice: l.price, unitDiscount: l.unitDiscount ?? 0, priceMode: "inclusive" };
        }),
        itemTaxMap, isInterState, doc.billDiscount,
      );
      if (!built.ok) { head.errors.push(built.error); continue; }
      const subtotal = built.lineItems.reduce((t: number, li: any) => t + li.lineSubtotal, 0);
      computedTax = built.lineItems.reduce((t: number, li: any) => t + li.taxAmount, 0);
      total = Math.round((subtotal + computedTax) * 100) / 100;
      // Summary figures come from the BUILT lines, never re-derived from the
      // file values: li.discount is the engine's paise-exact per-line total
      // (item discount + allocated bill-discount share), so the preview can
      // never disagree with what the commit records.
      computedTaxable = subtotal;
      for (const li of built.lineItems as any[]) {
        computedQty += Number(li.quantity ?? 0);
        computedDiscount += Number(li.discount ?? 0);
      }
    } else {
      let supply: Awaited<ReturnType<typeof resolveSupplyTaxType>>;
      if (doc.party) {
        const cached = supplyCache.get(doc.party.id);
        supply = cached ?? await resolveSupplyTaxType(doc.party.id, { type: loc.type, id: loc.id }, q);
        if (!supplyCache.has(doc.party.id)) supplyCache.set(doc.party.id, supply);
      } else {
        // Vendor doesn't exist yet (created at commit) — price intra-state.
        // Inter vs intra only changes the CGST/SGST↔IGST split, never the
        // bill total, so the preview total still matches what commit records.
        supply = { taxType: "intra", why: "new vendor — priced intra-state" };
      }
      const priced = priceBill(
        goodsIdxs.map((i) => {
          const l = slots[i].norm.line;
          return { materialType: l.kind, materialId: l.id, quantity: l.quantity, unitCost: l.rate, discount: l.discountPct };
        }),
        "exclusive", ctx.nameMaps, supply.taxType,
      );
      total = Math.round(Number(priced.totalAmount) * 100) / 100;
      computedTax = Number(priced.taxTotal);
      // Straight from the pricing engine — the same totals the bill records.
      computedTaxable = Number(priced.taxableTotal);
      computedDiscount = Number(priced.discountTotal);
      for (const i of goodsIdxs) computedQty += Number(slots[i].norm.line.quantity ?? 0);
      // Other Purchase Charges gathered across the bill's rows — explicit
      // (ledger, amount) pairs AND charge-mapped item lines both land here.
      // They add to what the vendor is owed (and what "Paid" may settle),
      // never to the goods total, the GST cross-check or stock cost.
      const ocs = [
        ...doc.rowIdxs.map((i) => slots[i].norm.otherCharge).filter(Boolean),
        ...doc.rowIdxs.map((i) => slots[i].norm.chargeLine).filter(Boolean),
      ];
      if (ocs.length > 0) {
        head.norm.otherCharges = ocs.map((c: any) => ({ ledgerId: c.ledgerId, amount: c.amount }));
        otherChargesTot = Math.round(ocs.reduce((t: number, c: any) => t + Number(c.amount), 0) * 100) / 100;
        head.norm.otherChargesTotal = otherChargesTot;
      }
      if (doc.dateIso < todayIso) {
        head.warnings.push("Backdated bill — average cost updates in the ORDER bills are entered, not by bill date; import oldest bills first");
      }
    }

    // File-GST cross-check (sum of CGST/SGST/IGST cells vs computed tax).
    // Charge-mapped rows are excluded — their GST already folded into the
    // charge amount, so counting it here would double it against the goods.
    const fileTax = doc.rowIdxs.reduce((t, i) => {
      if (slots[i].norm.chargeLine) return t;
      const v = rowsIn[i].values;
      return t + (parseMoney((v.cgst ?? "").trim()) || 0) + (parseMoney((v.sgst ?? "").trim()) || 0) + (parseMoney((v.igst ?? "").trim()) || 0);
    }, 0);
    if (fileTax > 0.004 && Math.abs(fileTax - computedTax) > 1) {
      head.warnings.push(`GST in the file (₹${fileTax.toFixed(2)}) differs from the computed GST (₹${computedTax.toFixed(2)}) — the computed figure is recorded`);
    }

    // Settlement resolution. Blank Paid Amount follows the Payment Status:
    // Paid → the computed grand total, Partial → an error (the amount is the
    // whole point of Partial), Unpaid/blank → 0. A supplied Paid Amount is
    // always honoured — a blank status with an amount records a part-payment
    // (the template hints document this).
    if (doc.status === "partial" && doc.paidGiven === null) {
      head.errors.push("Payment Status is Partial but Paid Amount is blank — enter the amount actually received");
    }
    let paid = 0;
    let mode: "cash" | "bank" | "upi" | "credit" = "credit";
    let paidFromLedgerId: number | null = null;
    if (module === "sales") {
      mode = doc.modeGiven ?? (doc.status === "paid" ? "cash" : "credit");
      if (mode !== "credit") {
        paid = total;
        if (doc.status === "partial" || (doc.paidGiven !== null && Math.abs(doc.paidGiven - total) > 0.01 && doc.status !== "paid")) {
          head.warnings.push(`${mode.toUpperCase()} sales settle in full at creation — recorded as fully paid ₹${total.toFixed(2)}; use Customer Credit for partly-paid invoices`);
        }
      } else {
        paid = doc.paidGiven ?? (doc.status === "paid" ? total : 0);
        if (paid > total + 0.01) {
          head.warnings.push(`Paid Amount ₹${paid.toFixed(2)} exceeds the computed total ₹${total.toFixed(2)} — capped at the total`);
          paid = total;
        }
        if (doc.status === "paid" && doc.paidGiven === null) paid = total;
      }
    } else {
      // A purchase bill's payable side is goods PLUS other charges — both
      // credit the vendor, so "Paid" may settle the whole of it.
      const grand = Math.round((total + otherChargesTot) * 100) / 100;
      paid = doc.paidGiven ?? (doc.status === "paid" ? grand : 0);
      if (paid > grand + 0.01) {
        head.warnings.push(`Paid Amount ₹${paid.toFixed(2)} exceeds the computed total ₹${grand.toFixed(2)}${otherChargesTot > 0 ? " (goods + other charges)" : ""} — capped at the total`);
        paid = grand;
      }
      if (doc.status === "paid" && doc.paidGiven !== null && doc.paidGiven < grand - 0.01) {
        head.warnings.push(`Marked Paid but Paid Amount is ₹${doc.paidGiven.toFixed(2)} of ₹${grand.toFixed(2)} — recorded as partly paid`);
      }
      // Payment Account: which money account settles the paid amount —
      // resolved exactly like voucher imports (Cash / Bank / exact ledger name).
      if (paid > 0.004 || doc.accountRaw) {
        const acct = resolveAccountValue(doc.accountRaw, ctx.accounts, ctx.foreignBanks);
        if (!acct.ok) head.errors.push(`Payment Account: ${acct.error}`);
        else paidFromLedgerId = acct.account.id;
      }
    }

    head.norm.invoiceNumber = doc.inv;
    head.norm.dateIso = doc.dateIso;
    head.norm.partyName = doc.party ? doc.party.name : doc.walkIn ? "Walk-in customer" : doc.partyName;
    if (doc.party) head.norm.partyId = doc.party.id;
    if (doc.walkIn) head.norm.walkIn = true;
    head.norm.billDiscount = doc.billDiscount;
    head.norm.paymentMode = mode;
    head.norm.paymentStatus = doc.status;
    head.norm.paidAmount = Math.round(paid * 100) / 100;
    if (module === "purchases") head.norm.paidFromLedgerId = paidFromLedgerId;
    head.norm.reference = doc.reference;
    head.norm.narration = doc.narration;
    head.norm.computedTotal = total;
    head.norm.computedTax = Math.round(computedTax * 100) / 100;
    head.norm.computedTaxable = Math.round(computedTaxable * 100) / 100;
    head.norm.computedQty = Math.round(computedQty * 1000) / 1000;
    head.norm.computedDiscount = Math.round(computedDiscount * 100) / 100;
  }

  // ── Verdicts ──
  const counts = { valid: 0, warning: 0, error: 0, needsMapping: 0 };
  const results: RowVerdict[] = slots.map((s) => {
    const missing: Array<{ kind: MappingKind; name: string }> = s.norm.missingMappings ?? [];
    const status: RowVerdict["status"] =
      s.errors.length > 0 ? "error"
      : missing.length > 0 ? "needs_mapping"
      : s.warnings.length > 0 ? "warning" : "valid";
    if (status === "valid") counts.valid++;
    else if (status === "warning") counts.warning++;
    else if (status === "needs_mapping") counts.needsMapping++;
    else counts.error++;
    const reason = status === "needs_mapping"
      ? [missing.map((m) => `${MAPPING_LABEL[m.kind]} "${m.name}" is not mapped yet`).join("; ") + " — map or create it in the mapping step", ...s.warnings].join("; ")
      : [...s.errors, ...s.warnings].join("; ") || null;
    return { status, reason, suggestion: s.suggestions[0] ?? null, duplicateOfId: null, norm: s.norm };
  });

  return { results, counts };
}

// ── Voucher validation (receipts & payments) ─────────────────────────────────

/** One outstanding document a voucher can allocate against. The `outstanding`
 *  field is a RUNNING figure shared across the whole file: earlier rows'
 *  planned allocations reduce what later rows see, so the preview matches
 *  what commit will actually do. */
interface VoucherOpenDoc {
  id: number;
  partyId: number;
  invoiceNumber: string | null;
  date: string;
  outstanding: number;
  cancelled: boolean;
  branchTransfer: boolean;
  inScope: boolean;
}

interface VoucherContext {
  parties: Map<string, { id: number; name: string }>; // lower(name) → party
  existingVoucherNos: Set<string>;                    // lower(voucher_number)
  accounts: Awaited<ReturnType<typeof importAccountOptions>>;
  /** Bank ledgers owned by OTHER locations — never resolvable for this batch,
   *  but named in errors so "no bank exists" is never claimed when one does. */
  foreignBanks: ForeignBankAccount[];
  /** party id → open, in-scope docs in FIFO (oldest-first) order */
  docsByParty: Map<number, VoucherOpenDoc[]>;
  /** `${partyId}|${lower(invoiceNumber)}` → doc (ALL docs, incl. settled/cancelled — for explicit-reference errors) */
  docByRef: Map<string, VoucherOpenDoc>;
  /** Non-party names ROUTED to a ledger (mapping target_kind 'ledger') —
   *  the row imports as a journal voucher against that ledger. Old-software
   *  receipt/payment reports mix capital accounts and expense heads in with
   *  real parties; routing keeps them in the books without inventing fake
   *  customers/vendors. norm(name) → ledger. */
  routes: Map<string, { ledgerId: number; ledgerName: string }>;
  /** Names the user chose to SKIP (mapping target_kind 'skip') — surfaced
   *  as warnings + a skip report, never silently dropped. */
  skips: Set<string>;
}

async function loadVoucherContext(module: VoucherModule, loc: { type: string; id: number }, q: WizQ = pool): Promise<VoucherContext> {
  const parties = new Map<string, { id: number; name: string }>();
  const partyTable = module === "receipts" ? "customers" : "vendors";
  const { rows: partyRows } = await q.query(`SELECT id, name FROM ${partyTable}`);
  for (const r of partyRows) {
    const key = String(r.name ?? "").trim().toLowerCase();
    if (key && !parties.has(key)) parties.set(key, { id: Number(r.id), name: String(r.name) });
  }

  // Mapping overlay for this module's party kind. target_kind decides what a
  // saved decision MEANS: NULL → old name points at an existing party;
  // 'ledger' → the row posts as a journal voucher against that ledger;
  // 'skip' → the row is excluded, visibly. A stale/inactive route ledger is
  // dropped, which sends the name back to the mapping step (never a silent
  // fallback to some other treatment).
  const routes = new Map<string, { ledgerId: number; ledgerName: string }>();
  const skips = new Set<string>();
  {
    const partyById = new Map<number, { id: number; name: string }>();
    for (const r of partyRows) partyById.set(Number(r.id), { id: Number(r.id), name: String(r.name) });
    const mappings = await loadMappings(module === "receipts" ? "customer" : "vendor", q);
    const ledgerIds = [...mappings.values()].filter((t) => t.targetKind === "ledger").map((t) => t.targetId);
    const ledgerById = new Map<number, string>();
    if (ledgerIds.length > 0) {
      const { rows } = await q.query(
        `SELECT id, name FROM account_ledgers
          WHERE id = ANY($1::int[]) AND NOT COALESCE(is_group, false) AND COALESCE(is_active, true)`,
        [ledgerIds],
      );
      for (const r of rows) ledgerById.set(Number(r.id), String(r.name));
    }
    for (const [norm, t] of mappings) {
      if (t.targetKind === "skip") { skips.add(norm); continue; }
      if (t.targetKind === "ledger") {
        const nm = ledgerById.get(t.targetId);
        if (nm) routes.set(norm, { ledgerId: t.targetId, ledgerName: nm });
        continue;
      }
      const p = partyById.get(t.targetId);
      if (p) parties.set(norm, p); // mapped name → party (overrides nothing real: keys are normalised file names)
    }
  }

  // Re-import guard: vouchers always draw a fresh ERP number, so the file's
  // number can only collide with a LEGACY reference stored by an earlier
  // import — that is what marks "this old-ERP voucher is already in".
  const existingVoucherNos = new Set<string>();
  const vTable = module === "receipts" ? "receipts" : "payments";
  const { rows: vnos } = await q.query(`SELECT lower(legacy_voucher_number) AS v FROM ${vTable} WHERE legacy_voucher_number IS NOT NULL`);
  for (const r of vnos) existingVoucherNos.add(String(r.v));

  const { options: accounts, foreignBanks } = await importAccountContext(q, loc as any);

  const docsByParty = new Map<number, VoucherOpenDoc[]>();
  const docByRef = new Map<string, VoucherOpenDoc>();
  const pushDoc = (doc: VoucherOpenDoc) => {
    if (doc.invoiceNumber) {
      const key = `${doc.partyId}|${doc.invoiceNumber.toLowerCase()}`;
      if (!docByRef.has(key)) docByRef.set(key, doc);
    }
    if (!doc.cancelled && !doc.branchTransfer && doc.inScope && doc.outstanding > 0.004) {
      const list = docsByParty.get(doc.partyId) ?? [];
      list.push(doc);
      docsByParty.set(doc.partyId, list);
    }
  };

  if (module === "receipts") {
    const { rows } = await q.query(
      `SELECT s.id, s.customer_id, s.invoice_number,
              to_char(s.sale_date, 'YYYY-MM-DD') AS d,
              ${outstandingExpr("s")}::float8 AS outstanding,
              (s.cancelled_at IS NOT NULL) AS cancelled,
              (s.branch_transfer_id IS NOT NULL) AS btr,
              COALESCE(s.location_type, 'outlet') AS ltype,
              COALESCE(s.location_id, s.outlet_id, 0) AS lid
         FROM sales s
        ORDER BY s.sale_date ASC, s.id ASC`,
    );
    for (const r of rows) {
      pushDoc({
        id: Number(r.id), partyId: Number(r.customer_id),
        invoiceNumber: r.invoice_number ? String(r.invoice_number) : null,
        date: String(r.d), outstanding: Math.max(0, Number(r.outstanding)),
        cancelled: Boolean(r.cancelled), branchTransfer: Boolean(r.btr),
        inScope: loc.type === "headoffice" || (String(r.ltype) === loc.type && Number(r.lid) === loc.id),
      });
    }
  } else {
    // Dues the way every report computes them — the shared settlement index
    // (explicit allocations + advance applications + the FIFO pool).
    const idx = await purchaseSettlementIndex();
    const { rows } = await q.query(
      `SELECT p.id, p.vendor_id, p.invoice_number,
              to_char(p.purchase_date, 'YYYY-MM-DD') AS d,
              (p.branch_transfer_id IS NOT NULL) AS btr,
              COALESCE(p.location_type, 'headoffice') AS ltype,
              COALESCE(p.location_id, 0) AS lid
         FROM purchases p
        ORDER BY p.purchase_date ASC, p.id ASC`,
    );
    for (const r of rows) {
      pushDoc({
        id: Number(r.id), partyId: Number(r.vendor_id),
        invoiceNumber: r.invoice_number ? String(r.invoice_number) : null,
        date: String(r.d), outstanding: Math.max(0, Number(idx.get(Number(r.id))?.due ?? 0)),
        cancelled: false, branchTransfer: Boolean(r.btr),
        inScope: loc.type === "headoffice" || (String(r.ltype) === loc.type && Number(r.lid) === loc.id),
      });
    }
  }

  return { parties, existingVoucherNos, accounts, foreignBanks, docsByParty, docByRef, routes, skips };
}

/**
 * Validation for voucher imports: one row = one voucher. Every row also gets
 * a PLANNED allocation (norm.plan) computed with the same explicit-first /
 * FIFO-oldest rules commit uses, over a running outstanding shared across the
 * file — so the preview shows exactly where each rupee will land. Commit
 * recomputes the allocation on LOCKED rows; the plan is preview-grade.
 */
async function validateVoucherRows(
  module: VoucherModule,
  rowsIn: TxnRowInput[],
  loc: { type: string; id: number }, q: WizQ = pool,
): Promise<{
  results: RowVerdict[];
  counts: { valid: number; warning: number; error: number; needsMapping: number };
}> {
  const ctx = await loadVoucherContext(module, loc, q);
  const checkRowLoc = await loadRowLocationCheck(loc, q);
  const todayIso = new Date().toISOString().slice(0, 10);
  const partyLabel = module === "receipts" ? "Customer" : "Vendor";
  const docLabel = module === "receipts" ? "Invoice" : "Bill";
  const round2 = (n: number) => Math.round(n * 100) / 100;

  type Slot = { errors: string[]; warnings: string[]; suggestions: string[]; norm: Record<string, any> };
  const slots: Slot[] = rowsIn.map(() => ({ errors: [], warnings: [], suggestions: [], norm: {} }));
  const seenVouchers = new Map<string, number>(); // lower(voucher no) → first row number

  for (let i = 0; i < rowsIn.length; i++) {
    const { rowNumber, values } = rowsIn[i];
    const s = slots[i];

    // Voucher number — kept verbatim; unique in-file AND against the system.
    const vno = (values.voucherNo ?? "").trim();
    if (vno) {
      const key = vno.toLowerCase();
      const first = seenVouchers.get(key);
      if (first !== undefined) {
        s.errors.push(`Voucher number "${vno}" already appeared at row ${first} in this file`);
        s.suggestions.push("Every voucher needs its own number — renumber or remove the duplicate");
      } else {
        seenVouchers.set(key, rowNumber);
        if (ctx.existingVoucherNos.has(key)) {
          s.errors.push(`Voucher number "${vno}" was already imported — an earlier voucher carries it as its legacy reference`);
          s.suggestions.push("Already migrated — remove the row, or renumber if it is genuinely a different voucher");
        }
      }
      s.norm.voucherNo = vno;
      s.norm.legacyVoucherNo = vno;
    } else {
      s.warnings.push("No voucher number in the file — the ERP allocates its own number either way; there will be no legacy reference to search by");
    }

    // Date
    const dateRaw = (values.date ?? "").trim();
    const dateIso = parseDateFlexible(dateRaw);
    if (!dateRaw) s.errors.push("Date is required");
    else if (!dateIso) {
      s.errors.push(`Date "${dateRaw}" not understood`);
      s.suggestions.push("Use YYYY-MM-DD or DD/MM/YYYY");
    } else if (dateIso > todayIso) {
      s.warnings.push(`Date ${dateIso} is in the future`);
    }
    if (dateIso) s.norm.dateIso = dateIso;

    // Location cross-check (optional column)
    const rowLocRaw = (values.location ?? "").trim();
    if (rowLocRaw) {
      const locErr = checkRowLoc(rowLocRaw);
      if (locErr) s.errors.push(locErr);
    }

    // Party — resolved ONLY through a saved mapping (customer/vendor).
    // Old-software reports mix NON-party accounts (capital, expense heads…)
    // in with real parties; a saved routing decision either SKIPS the row
    // (with a visible report) or posts it as a JOURNAL voucher against the
    // chosen ledger — never a silent drop, never a fake party.
    const partyName = (values.party ?? "").trim();
    if (!partyName) s.errors.push(`${partyLabel} is required`);
    if (partyName && ctx.skips.has(normName(partyName))) {
      s.norm.route = "skip";
      s.norm.partyName = partyName;
      const skipAmt = parseMoney((values.amount ?? "").trim());
      if (skipAmt !== null && Number.isFinite(skipAmt) && skipAmt > 0) s.norm.amount = skipAmt;
      s.warnings.push(`"${partyName}" is marked SKIP in your mappings — this row will NOT be imported (it stays listed in the skip report)`);
      continue;
    }
    const routed = partyName ? ctx.routes.get(normName(partyName)) ?? null : null;
    if (routed) {
      s.norm.route = "journal";
      s.norm.routeLedgerId = routed.ledgerId;
      s.norm.routeLedgerName = routed.ledgerName;
      s.norm.partyName = partyName;
    }
    const party = partyName && !routed ? ctx.parties.get(normName(partyName)) ?? null : null;
    if (partyName && !party && !routed) {
      addMissingMapping(s.norm, module === "receipts" ? "customer" : "vendor", partyName, true);
      s.suggestions.push(`Map "${partyName}" to an existing ${partyLabel.toLowerCase()} (or create it) in the mapping step — or, if it is not a ${partyLabel.toLowerCase()} at all, route it to a ledger as a journal entry or skip it`);
    }
    if (party) { s.norm.partyId = party.id; s.norm.partyName = party.name; }

    // Party type — cross-check only; the module decides the side.
    const ptNorm = (values.partyType ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (ptNorm) {
      const isCust = ["customer", "debtor", "buyer", "client", "cust"].includes(ptNorm);
      const isVend = ["vendor", "supplier", "creditor", "vend"].includes(ptNorm);
      if (module === "receipts" && isVend) {
        s.errors.push(`Party Type "${values.partyType}" — receipts settle CUSTOMER invoices; import money paid to vendors through the Payment Vouchers module`);
      } else if (module === "payments" && isCust) {
        s.errors.push(`Party Type "${values.partyType}" — payments settle VENDOR bills; import money received from customers through the Receipt Vouchers module`);
      } else if (!isCust && !isVend) {
        s.warnings.push(`Party Type "${values.partyType}" not understood — treated as ${partyLabel}`);
      }
    }

    // Amount
    const amt = parseMoney((values.amount ?? "").trim());
    if (amt === null) s.errors.push("Amount is required");
    else if (!Number.isFinite(amt) || amt <= 0) s.errors.push(`Amount "${values.amount}" must be a number greater than 0`);
    else s.norm.amount = amt;

    // Received-in / paid-from account
    const acc = resolveAccountValue(values.account ?? "", ctx.accounts, ctx.foreignBanks);
    if (!acc.ok) {
      s.errors.push(acc.error);
    } else {
      s.norm.accountLedgerId = acc.account.id;
      s.norm.accountName = acc.account.name;
      s.norm.accountKind = acc.account.kind;
    }

    if ((values.reference ?? "").trim()) s.norm.reference = values.reference.trim();
    if ((values.narration ?? "").trim()) s.norm.narration = values.narration.trim();

    // Against-invoice reference (explicit allocation target)
    const refRaw = (values.againstInvoice ?? "").trim();
    let explicitDoc: VoucherOpenDoc | null = null;
    if (refRaw) s.norm.againstInvoice = refRaw;
    if (refRaw && party) {
      const doc = ctx.docByRef.get(`${party.id}|${refRaw.toLowerCase()}`) ?? null;
      if (!doc) {
        s.errors.push(`${docLabel} "${refRaw}" not found for ${party.name}`);
        s.suggestions.push(`Import the ${module === "receipts" ? "sales invoices" : "purchase bills"} first, fix the reference, or leave it blank to auto-allocate oldest-first`);
      } else if (doc.cancelled) {
        s.errors.push(`${docLabel} "${refRaw}" is cancelled — nothing can be settled against it`);
      } else if (doc.branchTransfer) {
        s.errors.push(`${docLabel} "${refRaw}" is a branch transfer document and is settled by the transfer flow`);
      } else if (!doc.inScope) {
        s.errors.push(`${docLabel} "${refRaw}" was raised at another location — record its ${module === "receipts" ? "collection" : "payment"} there`);
      } else if (doc.outstanding <= 0.004) {
        s.errors.push(`${docLabel} "${refRaw}" is already fully settled${doc.outstanding <= 0.004 ? " (counting earlier rows of this file)" : ""} — remove the reference or point it at an open ${docLabel.toLowerCase()}`);
      } else {
        explicitDoc = doc;
      }
    }

    // Routed rows post as a journal voucher — describe the exact legs so the
    // preview says precisely what commit will write.
    const amountOk = amt !== null && Number.isFinite(amt) && amt > 0;
    if (routed && amountOk && acc.ok) {
      if (refRaw) s.errors.push(`"${partyName}" is routed to a ledger — an Against ${docLabel} reference cannot apply to a journal entry; clear the reference or map the name to a ${partyLabel.toLowerCase()}`);
      else {
        const a = (amt as number).toFixed(2);
        s.warnings.push(module === "receipts"
          ? `"${partyName}" is routed to the ledger "${routed.ledgerName}" — imported as a journal voucher: Dr ${acc.account.name} ₹${a} / Cr ${routed.ledgerName} ₹${a}`
          : `"${partyName}" is routed to the ledger "${routed.ledgerName}" — imported as a journal voucher: Dr ${routed.ledgerName} ₹${a} / Cr ${acc.account.name} ₹${a}`);
      }
    }

    // Planned allocation — explicit-first, else FIFO oldest-first; excess → advance.
    if (s.errors.length === 0 && party && amountOk && acc.ok) {
      const allocations: Array<{ id: number; invoiceNumber: string | null; amount: number }> = [];
      let remaining = round2(amt as number);
      if (explicitDoc) {
        const take = round2(Math.min(remaining, explicitDoc.outstanding));
        allocations.push({ id: explicitDoc.id, invoiceNumber: explicitDoc.invoiceNumber, amount: take });
        explicitDoc.outstanding = round2(explicitDoc.outstanding - take);
        remaining = round2(remaining - take);
        s.norm[module === "receipts" ? "explicitSaleId" : "explicitPurchaseId"] = explicitDoc.id;
      } else {
        for (const d of ctx.docsByParty.get(party.id) ?? []) {
          if (remaining <= 0.004) break;
          if (d.outstanding <= 0.004) continue;
          const take = round2(Math.min(remaining, d.outstanding));
          allocations.push({ id: d.id, invoiceNumber: d.invoiceNumber, amount: take });
          d.outstanding = round2(d.outstanding - take);
          remaining = round2(remaining - take);
        }
      }
      const advance = remaining > 0.004 ? remaining : 0;
      if (advance > 0) {
        const ledger = module === "receipts" ? "customer advance (CADV)" : "vendor advance (VADV)";
        s.warnings.push(
          allocations.length > 0
            ? `₹${advance.toFixed(2)} exceeds the open balance — the excess will be parked as a ${ledger}, adjustable against future ${module === "receipts" ? "invoices" : "bills"}`
            : `${party.name} has no open ${docLabel.toLowerCase()}s${explicitDoc ? "" : " at this location"} — the full ₹${advance.toFixed(2)} will be parked as a ${ledger}`,
        );
      }
      s.norm.plan = { allocations, advance, accountName: acc.account.name };
    }
  }

  // ── Verdicts ──
  const counts = { valid: 0, warning: 0, error: 0, needsMapping: 0 };
  const results: RowVerdict[] = slots.map((s) => {
    const missing: Array<{ kind: MappingKind; name: string }> = s.norm.missingMappings ?? [];
    const status: RowVerdict["status"] =
      s.errors.length > 0 ? "error"
      : missing.length > 0 ? "needs_mapping"
      : s.warnings.length > 0 ? "warning" : "valid";
    if (status === "valid") counts.valid++;
    else if (status === "warning") counts.warning++;
    else if (status === "needs_mapping") counts.needsMapping++;
    else counts.error++;
    const reason = status === "needs_mapping"
      ? [missing.map((m) => `${MAPPING_LABEL[m.kind]} "${m.name}" is not mapped yet`).join("; ") + " — map or create it in the mapping step", ...s.warnings].join("; ")
      : [...s.errors, ...s.warnings].join("; ") || null;
    return { status, reason, suggestion: s.suggestions[0] ?? null, duplicateOfId: null, norm: s.norm };
  });

  return { results, counts };
}

// ── Day Book validation (journal / contra vouchers) ─────────────────────────

/**
 * One voucher = every row sharing a Voucher No (required — the number is what
 * groups legs). Ledger names resolve ONLY through 'ledger' mappings. Per
 * voucher: one date, one type, legs must balance to the paise, at least two
 * legs. The ERP allocates its own voucher number at import; the file's
 * number is stored as the searchable legacy reference.
 */
async function validateDaybookRows(
  rowsIn: TxnRowInput[],
  loc: { type: string; id: number }, q: WizQ = pool,
): Promise<{
  results: RowVerdict[];
  counts: { valid: number; warning: number; error: number; needsMapping: number };
}> {
  const checkRowLoc = await loadRowLocationCheck(loc, q);
  const todayIso = new Date().toISOString().slice(0, 10);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Mapped, postable ledgers (stale/unpostable targets → back to the mapping step)
  const { rows: ledRows } = await q.query(
    `SELECT id, name FROM account_ledgers
      WHERE NOT COALESCE(is_group, false) AND COALESCE(is_active, true)`,
  );
  const ledById = new Map<number, { id: number; name: string }>();
  for (const r of ledRows) ledById.set(Number(r.id), { id: Number(r.id), name: String(r.name) });
  const ledgers = new Map<string, { id: number; name: string }>();
  for (const [norm, t] of await loadMappings("ledger", q)) {
    const meta = ledById.get(t.targetId);
    if (meta) ledgers.set(norm, meta);
  }

  // Re-import guard: file numbers only ever land in legacy_voucher_number.
  const existingLegacy = new Set<string>();
  {
    const { rows } = await q.query(
      `SELECT lower(legacy_voucher_number) AS v FROM journal_vouchers WHERE legacy_voucher_number IS NOT NULL`,
    );
    for (const r of rows) existingLegacy.add(String(r.v));
  }

  type Slot = { errors: string[]; warnings: string[]; suggestions: string[]; norm: Record<string, any> };
  const slots: Slot[] = rowsIn.map(() => ({ errors: [], warnings: [], suggestions: [], norm: {} }));

  // Group by voucher number (first-appearance order).
  type VDoc = { vno: string; headIdx: number; rowIdxs: number[] };
  const docs: VDoc[] = [];
  const docByNo = new Map<string, number>();
  for (let i = 0; i < rowsIn.length; i++) {
    const vno = (rowsIn[i].values.voucherNo ?? "").trim();
    if (!vno) {
      slots[i].errors.push("Voucher No is required — rows sharing a number form ONE voucher, so every leg must carry it");
      continue;
    }
    const key = vno.toLowerCase();
    const at = docByNo.get(key);
    if (at !== undefined) { docs[at].rowIdxs.push(i); continue; }
    docs.push({ vno, headIdx: i, rowIdxs: [i] });
    docByNo.set(key, docs.length - 1);
  }

  // Per-row: date, ledger, debit/credit, location cross-check.
  for (let i = 0; i < rowsIn.length; i++) {
    const { values } = rowsIn[i];
    const s = slots[i];

    const rowLocRaw = (values.location ?? "").trim();
    if (rowLocRaw) {
      const locErr = checkRowLoc(rowLocRaw);
      if (locErr) s.errors.push(locErr);
    }

    const dateRaw = (values.date ?? "").trim();
    if (dateRaw) {
      const iso = parseDateFlexible(dateRaw);
      if (!iso) {
        s.errors.push(`Date "${dateRaw}" not understood`);
        s.suggestions.push("Use YYYY-MM-DD or DD/MM/YYYY");
      } else {
        s.norm.dateIso = iso;
        if (iso > todayIso) s.warnings.push(`Date ${iso} is in the future`);
      }
    }

    const ledgerRaw = (values.ledger ?? "").trim();
    if (!ledgerRaw) {
      s.errors.push("Ledger is required on every row");
    } else {
      const led = ledgers.get(normName(ledgerRaw));
      if (!led) {
        addMissingMapping(s.norm, "ledger", ledgerRaw);
        s.suggestions.push(`Map "${ledgerRaw}" to a ledger in the Chart of Accounts (or create one) in the mapping step`);
      } else {
        s.norm.ledgerId = led.id;
        s.norm.ledgerName = led.name;
      }
    }

    const dr = parseMoney((values.debit ?? "").trim());
    const cr = parseMoney((values.credit ?? "").trim());
    const drOk = dr !== null && Number.isFinite(dr) && dr > 0.004;
    const crOk = cr !== null && Number.isFinite(cr) && cr > 0.004;
    if ((dr !== null && (!Number.isFinite(dr) || dr < 0)) || (cr !== null && (!Number.isFinite(cr) || cr < 0))) {
      s.errors.push("Debit/Credit must be numbers ≥ 0");
    } else if (drOk && crOk) {
      s.errors.push("A row carries a Debit OR a Credit, never both — split it into two rows");
    } else if (!drOk && !crOk) {
      s.errors.push("Each row needs a Debit or a Credit amount above zero");
    } else {
      s.norm.debit = drOk ? round2(dr!) : 0;
      s.norm.credit = crOk ? round2(cr!) : 0;
    }

    const vt = (values.voucherType ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (vt) {
      if (["journal", "jv", "jrnl"].includes(vt)) s.norm.voucherType = "journal";
      else if (["contra", "contravoucher"].includes(vt)) s.norm.voucherType = "contra";
      else s.errors.push(`Voucher Type "${values.voucherType}" must be Journal or Contra`);
    }
  }

  // Per-voucher: one date, one type, balanced legs, ≥ 2 legs, legacy dupe.
  for (const doc of docs) {
    const head = slots[doc.headIdx];
    const label = `Voucher "${doc.vno}"`;

    if (existingLegacy.has(doc.vno.toLowerCase())) {
      head.errors.push(`${label} was already imported — an earlier journal voucher carries it as its legacy reference`);
      head.suggestions.push("Already migrated — remove these rows, or renumber if it is genuinely a different voucher");
    }

    let dateIso: string | null = null; let dateFrom = 0;
    let vtype: string | null = null; let vtypeFrom = 0;
    let narration: string | null = null;
    let sumDr = 0, sumCr = 0;
    for (const i of doc.rowIdxs) {
      const n = slots[i].norm;
      if (n.dateIso) {
        if (!dateIso) { dateIso = String(n.dateIso); dateFrom = rowsIn[i].rowNumber; }
        else if (String(n.dateIso) !== dateIso) {
          slots[i].errors.push(`${label} has two different dates — ${dateIso} (row ${dateFrom}) vs ${n.dateIso} here; one voucher carries ONE date`);
        }
      }
      if (n.voucherType) {
        if (!vtype) { vtype = String(n.voucherType); vtypeFrom = rowsIn[i].rowNumber; }
        else if (String(n.voucherType) !== vtype) {
          slots[i].errors.push(`${label} mixes voucher types — ${vtype} (row ${vtypeFrom}) vs ${n.voucherType} here`);
        }
      }
      if (!narration && (rowsIn[i].values.narration ?? "").trim()) narration = (rowsIn[i].values.narration ?? "").trim();
      sumDr = round2(sumDr + Number(n.debit ?? 0));
      sumCr = round2(sumCr + Number(n.credit ?? 0));
    }
    if (!dateIso) head.errors.push(`${label} has no date — at least one of its rows must carry the Date`);
    if (doc.rowIdxs.length < 2) {
      head.errors.push(`${label} has only one row — a voucher needs at least a debit leg and a credit leg`);
    }
    const anyBad = doc.rowIdxs.some((i) => slots[i].errors.length > 0 || (slots[i].norm.missingMappings?.length ?? 0) > 0);
    if (!anyBad && Math.abs(sumDr - sumCr) > 0.005) {
      head.errors.push(`${label} does not balance — debits ₹${sumDr.toFixed(2)} vs credits ₹${sumCr.toFixed(2)}`);
      head.suggestions.push("Fix the amounts so total debits equal total credits");
    }

    // Head row carries the assembled voucher for the import routine.
    head.norm.head = true;
    head.norm.voucher = {
      legacyVoucherNo: doc.vno,
      dateIso,
      voucherType: vtype ?? "journal",
      narration,
      totalAmount: sumDr,
      lines: doc.rowIdxs.map((i) => ({
        ledgerId: slots[i].norm.ledgerId ?? null,
        ledgerName: slots[i].norm.ledgerName ?? null,
        debit: Number(slots[i].norm.debit ?? 0),
        credit: Number(slots[i].norm.credit ?? 0),
      })),
    };
    for (const i of doc.rowIdxs) slots[i].norm.doc = docs.indexOf(doc);
  }

  // ── Verdicts ──
  const counts = { valid: 0, warning: 0, error: 0, needsMapping: 0 };
  const results: RowVerdict[] = slots.map((s) => {
    const missing: Array<{ kind: MappingKind; name: string }> = s.norm.missingMappings ?? [];
    const status: RowVerdict["status"] =
      s.errors.length > 0 ? "error"
      : missing.length > 0 ? "needs_mapping"
      : s.warnings.length > 0 ? "warning" : "valid";
    if (status === "valid") counts.valid++;
    else if (status === "warning") counts.warning++;
    else if (status === "needs_mapping") counts.needsMapping++;
    else counts.error++;
    const reason = status === "needs_mapping"
      ? [missing.map((m) => `${MAPPING_LABEL[m.kind]} "${m.name}" is not mapped yet`).join("; ") + " — map or create it in the mapping step", ...s.warnings].join("; ")
      : [...s.errors, ...s.warnings].join("; ") || null;
    return { status, reason, suggestion: s.suggestions[0] ?? null, duplicateOfId: null, norm: s.norm };
  });
  return { results, counts };
}

// ── Opening Stock validation ─────────────────────────────────────────────────

/**
 * The whole file is ONE opening-stock document: every row must carry the SAME
 * as-on date, one row per item. Items resolve ONLY through 'product' mappings
 * that point at finished items (opening stock is an Item Master concern —
 * materials arrive through purchases).
 */
async function validateOpeningStockRows(
  rowsIn: TxnRowInput[],
  loc: { type: string; id: number }, q: WizQ = pool,
): Promise<{
  results: RowVerdict[];
  counts: { valid: number; warning: number; error: number; needsMapping: number };
}> {
  const checkRowLoc = await loadRowLocationCheck(loc, q);
  const todayIso = new Date().toISOString().slice(0, 10);
  const products = await loadMappedProducts(q);

  // Existing stock at the target location — an opening import ADDS on top,
  // which is almost never what a migration wants for an item already stocked.
  const stockAvail = new Map<number, number>();
  {
    const branchId = loc.type === "headoffice" ? 1 : loc.id;
    const { rows } = await q.query(
      `SELECT item_id, quantity::float8 AS qty FROM stock_entries
        WHERE material_type = 'item' AND branch_type = $1 AND branch_id = $2`,
      [loc.type, branchId],
    );
    for (const r of rows) stockAvail.set(Number(r.item_id), Number(r.qty));
  }

  type Slot = { errors: string[]; warnings: string[]; suggestions: string[]; norm: Record<string, any> };
  const slots: Slot[] = rowsIn.map(() => ({ errors: [], warnings: [], suggestions: [], norm: {} }));

  let docDate: string | null = null; let dateFrom = 0;
  const seenItems = new Map<number, number>(); // item id → first row number

  for (let i = 0; i < rowsIn.length; i++) {
    const { rowNumber, values } = rowsIn[i];
    const s = slots[i];

    const rowLocRaw = (values.location ?? "").trim();
    if (rowLocRaw) {
      const locErr = checkRowLoc(rowLocRaw);
      if (locErr) s.errors.push(locErr);
    }

    const dateRaw = (values.date ?? "").trim();
    if (!dateRaw) {
      s.errors.push("As-on Date is required on every row");
    } else {
      const iso = parseDateFlexible(dateRaw);
      if (!iso) {
        s.errors.push(`As-on Date "${dateRaw}" not understood`);
        s.suggestions.push("Use YYYY-MM-DD or DD/MM/YYYY");
      } else {
        if (!docDate) { docDate = iso; dateFrom = rowNumber; }
        else if (iso !== docDate) {
          s.errors.push(`As-on Date ${iso} differs from ${docDate} (row ${dateFrom}) — the whole file is ONE opening-stock statement as of ONE date`);
          s.suggestions.push("Split different dates into separate files");
        }
        if (iso > todayIso) s.warnings.push(`As-on Date ${iso} is in the future`);
        s.norm.dateIso = iso;
      }
    }

    const itemRaw = (values.item ?? "").trim();
    if (!itemRaw) {
      s.errors.push("Item is required");
    } else {
      const mapped = (products.get(normName(itemRaw)) ?? [])[0] ?? null;
      if (!mapped) {
        addMissingMapping(s.norm, "product", itemRaw);
        s.suggestions.push(`Map "${itemRaw}" to a finished item (or create it) in the mapping step`);
      } else if (mapped.kind !== "item") {
        s.errors.push(`"${itemRaw}" is mapped to ${KIND_LABEL[mapped.kind]} — opening stock covers finished items only`);
        s.suggestions.push("Fix the mapping on the Manage Mappings screen to point at a finished item");
      } else {
        const firstAt = seenItems.get(mapped.id);
        if (firstAt !== undefined) {
          s.errors.push(`"${mapped.name}" already appeared at row ${firstAt} — one row per item`);
          s.suggestions.push("Combine the quantities into one row");
        } else {
          seenItems.set(mapped.id, rowNumber);
          s.norm.itemId = mapped.id;
          s.norm.itemName = mapped.name;
          const have = stockAvail.get(mapped.id) ?? 0;
          if (have > 0.001) {
            s.warnings.push(`The location already holds ${have} of "${mapped.name}" — this opening quantity ADDS on top of it`);
          }
        }
      }
    }

    const qty = parseQty(values.quantity ?? "");
    if (qty === null) s.errors.push("Quantity is required");
    else if (!Number.isFinite(qty) || qty <= 0) s.errors.push(`Quantity "${values.quantity}" must be a number greater than 0`);
    else s.norm.quantity = qty;

    const uc = parseMoney((values.unitCost ?? "").trim());
    if (uc !== null) {
      if (!Number.isFinite(uc) || uc < 0) s.errors.push(`Unit Cost "${values.unitCost}" must be a number ≥ 0`);
      else s.norm.unitCost = uc;
    }
    if ((values.notes ?? "").trim()) s.norm.notes = values.notes.trim();
  }

  // ── Verdicts ──
  const counts = { valid: 0, warning: 0, error: 0, needsMapping: 0 };
  const results: RowVerdict[] = slots.map((s) => {
    const missing: Array<{ kind: MappingKind; name: string }> = s.norm.missingMappings ?? [];
    const status: RowVerdict["status"] =
      s.errors.length > 0 ? "error"
      : missing.length > 0 ? "needs_mapping"
      : s.warnings.length > 0 ? "warning" : "valid";
    if (status === "valid") counts.valid++;
    else if (status === "warning") counts.warning++;
    else if (status === "needs_mapping") counts.needsMapping++;
    else counts.error++;
    const reason = status === "needs_mapping"
      ? [missing.map((m) => `${MAPPING_LABEL[m.kind]} "${m.name}" is not mapped yet`).join("; ") + " — map or create it in the mapping step", ...s.warnings].join("; ")
      : [...s.errors, ...s.warnings].join("; ") || null;
    return { status, reason, suggestion: s.suggestions[0] ?? null, duplicateOfId: null, norm: s.norm };
  });
  return { results, counts };
}

// ── Serialisation ────────────────────────────────────────────────────────────

/** Human-facing batch id shown in history, dialogs and the audit trail. */
function batchDisplayId(id: number): string {
  return `IMP${String(id).padStart(6, "0")}`;
}

/** Legacy/unknown module strings count as master (no wizard buttons). */
function batchIsMaster(b: any): boolean {
  const m = asModule(String(b.module ?? ""));
  return m == null || isMasterModule(m);
}

function batchJson(b: any) {
  return {
    id: Number(b.id),
    displayId: batchDisplayId(Number(b.id)),
    module: b.module,
    filename: b.filename,
    status: b.status,
    totalRows: Number(b.total_rows),
    validRows: Number(b.valid_rows),
    warningRows: Number(b.warning_rows),
    errorRows: Number(b.error_rows),
    importedRows: Number(b.imported_rows),
    updatedRows: Number(b.updated_rows),
    skippedRows: Number(b.skipped_rows),
    failedRows: Number(b.failed_rows),
    locationType: b.location_type ?? null,
    locationId: b.location_id == null ? null : Number(b.location_id),
    createdBy: b.created_by,
    createdAt: b.created_at,
    committedAt: b.committed_at,
    committedBy: b.committed_by,
    rolledBackAt: b.rolled_back_at,
    rolledBackBy: b.rolled_back_by,
    // ── Wizard state ──
    demoAt: b.demo_at ?? null,
    demoBy: b.demo_by ?? null,
    demoSummary: b.demo_summary ?? null,
    hasDemoReport: b.has_demo_report != null ? Boolean(b.has_demo_report) : b.demo_report != null,
    discardedAt: b.discarded_at ?? null,
    discardedBy: b.discarded_by ?? null,
    legacyRange: (b.legacy_min || b.legacy_max)
      ? { min: b.legacy_min ?? null, max: b.legacy_max ?? null }
      : null,
    /** Old-software report conversion metadata (null for normal template files). */
    conversion: b.conversion ?? null,
    canDemo: !batchIsMaster(b) && (b.status === "validated" || b.status === "demo_ready"),
    canApprove: !batchIsMaster(b) && b.status === "demo_ready",
    canDiscard: !batchIsMaster(b) && (b.status === "validated" || b.status === "demo_ready"),
    canCommit: batchIsMaster(b) && b.status === "validated",
    // "available" from cheap state — actual eligibility is re-decided at
    // rollback time from live usage.
    rollbackAvailable:
      b.status === "committed" && !b.rolled_back_at &&
      (Number(b.imported_rows) > 0),
  };
}

function rowJson(r: any) {
  const raw = r.raw ?? {};
  return {
    id: Number(r.id),
    rowNumber: Number(r.row_number),
    status: r.status,
    reason: r.reason ?? null,
    suggestion: r.suggestion ?? null,
    duplicateOfId: r.duplicate_of_id == null ? null : Number(r.duplicate_of_id),
    values: raw.values ?? {},
    /** unmapped names holding this row at needs_mapping */
    missingMappings: raw.norm?.missingMappings ?? [],
    docIndex: raw.norm?.doc ?? null,
    /** txn imports: walk-in counter sale (no customer on the bill) */
    walkIn: raw.norm?.walkIn === true,
    /** voucher imports: planned allocation shown in the preview */
    plan: raw.norm?.plan ?? null,
    /** voucher imports: what commit actually recorded */
    created: raw.created ?? null,
    /** wizard: this row's outcome in the last demo run */
    demo: raw.demo ?? null,
    createdRecordType: r.created_record_type ?? null,
    createdRecordId: r.created_record_id == null ? null : Number(r.created_record_id),
    createdLedgerId: r.created_ledger_id == null ? null : Number(r.created_ledger_id),
  };
}

const username = (req: Request) => (req as any).employee?.username ?? "system";

/**
 * Batch-level money totals for a sales/purchase preview — summed over the
 * documents that validated fully (head rows carrying computedTotal). All
 * figures come from the SAME pricing pass the commit will use; nothing is
 * recomputed here.
 */
function txnBatchSummary(dbRows: Array<{ raw?: any }>): {
  invoices: number; totalQuantity: number; totalTaxable: number;
  totalGst: number; totalDiscount: number; totalAmount: number;
  distinctParties: number; distinctItems: number;
  walkInInvoices: number;
  unmappedNames: Array<{ kind: string; name: string }>;
} {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let invoices = 0, qty = 0, taxable = 0, gst = 0, discount = 0, amount = 0, walkIns = 0;
  const partyKeys = new Set<string>();
  const itemKeys = new Set<string>();
  const unmapped = new Map<string, { kind: string; name: string }>(); // `${kind}|${norm}` → display
  for (const r of dbRows) {
    const n = r.raw?.norm ?? {};
    if (n.line?.name) itemKeys.add(String(n.line.name).toLowerCase());
    for (const m of (n.missingMappings ?? []) as Array<{ kind: string; name: string }>) {
      unmapped.set(`${m.kind}|${normName(String(m.name))}`, { kind: m.kind, name: String(m.name) });
    }
    if (!n.head || n.computedTotal == null) continue;
    invoices++;
    amount += Number(n.computedTotal ?? 0);
    gst += Number(n.computedTax ?? 0);
    taxable += Number(n.computedTaxable ?? 0);
    qty += Number(n.computedQty ?? 0);
    discount += Number(n.computedDiscount ?? 0);
    if (n.walkIn === true) walkIns++;
    else if (n.partyId != null) partyKeys.add(`#${n.partyId}`);
  }
  return {
    invoices, totalQuantity: Math.round(qty * 1000) / 1000,
    totalTaxable: r2(taxable), totalGst: r2(gst),
    totalDiscount: r2(discount), totalAmount: r2(amount),
    distinctParties: partyKeys.size, distinctItems: itemKeys.size,
    walkInInvoices: walkIns,
    unmappedNames: [...unmapped.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
  };
}

// ── 1. Sample templates ──────────────────────────────────────────────────────

router.get("/imports/templates/:module", requireModuleAction(PERM, "download"), async (req: Request, res: Response): Promise<void> => {
  const module = asModule(req.params.module);
  if (!module) { res.status(400).json({ error: `Unknown import module — use one of: ${MODULES.join(", ")}` }); return; }
  const spec = TEMPLATES[module];

  const wb = new ExcelJS.Workbook();
  // Excel forbids * ? : \ / [ ] in worksheet names and caps them at 31 chars —
  // a display title like "Day Book (Journal / Contra)" must be sanitised or
  // exceljs throws and the download 500s.
  const ws = wb.addWorksheet(spec.title.replace(/[*?:\\/[\]]/g, "-").slice(0, 31));

  // Hidden columns (cross-check-only, e.g. GST amounts) never appear in the
  // template — the user supplies business data only; the ERP computes the rest.
  const visibleCols = spec.columns.filter((c) => !c.hidden);
  ws.columns = visibleCols.map((c) => ({
    header: c.required ? `${c.header} *` : c.header,
    key: c.key,
    width: Math.max(16, c.header.length + 6),
  }));
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  visibleCols.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    if (c.required) cell.font = { bold: true, color: { argb: "FFC00000" } };
    cell.note = c.hint + (c.required ? " — REQUIRED" : "");
  });
  ws.addRow(visibleCols.map((c) => c.example));
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // Second sheet: how to fill + (for ledgers) the live list of valid groups.
  const help = wb.addWorksheet(module === "ledgers" ? "Valid Groups" : "Instructions");
  help.getColumn(1).width = 60;
  help.addRow(["How to use this template"]).font = { bold: true };
  help.addRow(["• Columns marked * (red) are required. Keep the header row unchanged."]);
  help.addRow(["• Replace the example row with your data — one record per row."]);
  if (isTxnModule(module)) {
    const party = module === "sales" ? "Customer" : "Vendor";
    help.addRow([`• One row per invoice LINE. Every row carrying the same Invoice No belongs to that invoice — rows may sit anywhere in the file. Repeat rows may leave Date and ${party} blank (they inherit the invoice's values); a DIFFERENT date or ${party.toLowerCase()} on the same invoice number is an error.`]);
    if (module === "sales") {
      help.addRow(["• Price INCLUDES GST — it is the selling price / MRP, exactly as in manual sale entry. The ERP works the GST out from the Item Master rate; you never enter GST amounts."]);
      help.addRow(["• Line Total is optional: leave Price blank and the unit price is worked out as Line Total ÷ Qty. When both are given they are cross-checked."]);
      help.addRow(["• Discount is ₹ per UNIT. Bill Discount is a pre-tax ₹ off the whole invoice — put it on any one row of the invoice."]);
      help.addRow(["• A price BELOW the Item Master MRP is recorded like the POS: MRP stays at the master value and the difference becomes a per-unit discount — the customer's net price is unchanged. A price above MRP is used as-is."]);
      help.addRow(["• A blank Customer on a Cash/Bank/UPI sale is recorded as a walk-in counter sale (no customer on the bill), like a POS cash sale. Credit sales always need a customer."]);
    } else {
      help.addRow(["• Purchase Rate EXCLUDES GST, exactly as in manual purchase entry. The ERP adds GST from the product master rate; you never enter GST amounts."]);
      help.addRow(["• Line Total is optional: leave Purchase Rate blank and the unit rate is worked out as Line Total ÷ Qty (before GST). When both are given they are cross-checked."]);
      help.addRow(["• Discount % is a percent off that line. There is no bill-level discount on purchases — spread it into the lines."]);
    }
    help.addRow(["• Dates: YYYY-MM-DD or DD/MM/YYYY."]);
    help.addRow([`• Every item and ${party.toLowerCase()} name from your old ERP is matched through the mapping step: you link each name to an existing record (or create one) ONCE, and the link is remembered for every later file.`]);
    help.addRow(["• Payment Status: Paid / Unpaid / Partial. Paid with a blank Paid Amount = fully paid; Partial REQUIRES a Paid Amount; blank = Unpaid (or partly paid when a Paid Amount is given)."]);
    if (module === "sales") {
      help.addRow(["• Payment Account: Cash / Bank / UPI / Customer Credit. Cash, Bank and UPI sales are recorded as fully paid at creation; use Customer Credit + Paid Amount for partly-paid invoices."]);
      help.addRow(["• Each imported sale is given the next SB2B/SB2C bill number automatically (B2B when the customer has a GST number). The invoice number from your file is kept as the old reference — bills stay searchable by it."]);
      help.addRow(["• Stock: each sale deducts stock at the chosen location — import purchases/opening stock first."]);
    } else {
      help.addRow(["• Payment Account: where the Paid Amount was paid from — Cash, Bank, or the exact bank ledger name. Blank = the selected location's cash."]);
      help.addRow(["• Backdated bills: average cost updates in the ORDER bills are entered, not by bill date — import oldest bills first."]);
    }
  } else if (isVoucherModule(module)) {
    const party = module === "receipts" ? "Customer" : "Vendor";
    const docWord = module === "receipts" ? "invoice" : "bill";
    help.addRow(["• One row per voucher."]);
    help.addRow([`• ${module === "receipts" ? "Against Invoice" : "Against Bill"} is optional: fill it to settle ONLY that ${docWord}; leave it blank to auto-allocate against the ${party.toLowerCase()}'s oldest unpaid ${docWord}s (FIFO).`]);
    help.addRow([`• Any amount beyond the open balance is parked as a ${party.toLowerCase()} advance, adjustable against future ${docWord}s.`]);
    help.addRow([`• ${module === "receipts" ? "Received In" : "Paid From"}: write Cash, Bank, or the exact bank ledger name — it decides whether the money ${module === "receipts" ? "lands in" : "leaves"} the cash book or bank book.`]);
    help.addRow(["• The ERP gives every voucher its own number; the number from your file is kept as the old reference and stays searchable. A file number that was already imported is flagged."]);
    help.addRow(["• Dates: YYYY-MM-DD or DD/MM/YYYY."]);
    help.addRow([`• ${party} names are matched through the mapping step (map once, remembered forever). Import the ${docWord}s FIRST so allocation finds them.`]);
  } else if (module === "daybook") {
    help.addRow(["• One row per voucher LEG. Every row carrying the same Voucher No belongs to that voucher; each row is a Debit OR a Credit, and the voucher's debits must equal its credits."]);
    help.addRow(["• Voucher Type: Journal or Contra (blank = Journal). One date per voucher."]);
    help.addRow(["• Ledger names are matched through the mapping step — link each old-ERP ledger to your Chart of Accounts once, and it is remembered for every later file."]);
    help.addRow(["• The ERP gives every voucher its own number; the number from your file is kept as the old reference and stays searchable."]);
    help.addRow(["• Sales, purchases, receipts and payments have their own imports — the Day Book is for the journal and contra entries that remain."]);
    help.addRow(["• Dates: YYYY-MM-DD or DD/MM/YYYY."]);
  } else if (module === "opening_stock") {
    help.addRow(["• The whole file is ONE opening-stock statement: every row carries the SAME As-on Date, one row per item."]);
    help.addRow(["• Item names are matched through the mapping step to your Item Master (finished items only)."]);
    help.addRow(["• Unit Cost is optional — when given, the stock is valued at it; when blank, the item's current average cost is used."]);
    help.addRow(["• Quantities ADD to whatever the location already holds — a warning tells you when that happens."]);
  } else {
    help.addRow(["• Opening Type is Dr or Cr. Opening Balance is the amount as on migration date."]);
    help.addRow([""]);
    if (module === "ledgers") {
      help.addRow(["Valid Ledger Group values (current chart of accounts):"]).font = { bold: true };
      for (const c of await loadParentCandidates()) help.addRow([c.name]);
    } else {
      help.addRow(["Names must be unique — a name that already exists is flagged as a duplicate,"]);
      help.addRow(["and you choose at commit time whether to skip it or update the existing record."]);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${module}-import-sample.xlsx"`);
  res.send(Buffer.from(buf as ArrayBuffer));
});

// ── 2. Upload + parse + validate ─────────────────────────────────────────────

const MAX_ROWS = 2000;

/**
 * Load the first sheet of an uploaded workbook, map its headers through the
 * module's alias table and walk the data rows into { rowNumber, values }
 * records. Shared by the single-file parse endpoint and the Migration
 * Wizard's per-module file uploads — validation happens AFTER this, per
 * caller.
 */
async function parseWorkbookValues(
  module: ImportModule, body: Buffer,
): Promise<{ error: string } | { parsed: Array<{ rowNumber: number; values: Record<string, string> }>; conversion?: LegacyConversionMeta }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(body as any);
  } catch {
    return { error: "That file could not be read as an Excel (.xlsx) workbook. Download the sample and fill it in." };
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) return { error: "The first sheet has no data rows below the header." };

  // Old-software report pre-pass: the owner's previous software exports a
  // report family whose layout the sample-template parser cannot read.
  // Detection is signature-based (sample files never match); a detected file
  // is CONVERTED into normal template rows and flows through the unchanged
  // validate → map → demo → approve pipeline. The row cap applies to the
  // converted rows — the raw day book legitimately exceeds it.
  const legacy = convertLegacyReport(module, ws);
  if (legacy) {
    if ("error" in legacy) return { error: legacy.error };
    if (legacy.parsed.length > MAX_ROWS) {
      return { error: `Old-software ${legacy.conversion.report} recognised, but after conversion it still has ${legacy.parsed.length} rows — more than the ${MAX_ROWS}-row limit. Export it in smaller date ranges.` };
    }
    if (legacy.parsed.length === 0) {
      return { error: `Old-software ${legacy.conversion.report} recognised, but no data rows survived conversion — check the export.` };
    }
    return legacy;
  }

  const spec = TEMPLATES[module];
  const colForIdx = new Map<number, string>();
  const headerCells = ws.getRow(1);
  headerCells.eachCell((cell, colNumber) => {
    const h = normHeader(cellText(cell.value).replace(/\*/g, ""));
    if (!h) return;
    const match = spec.columns.find((c) => c.aliases.includes(h) || normHeader(c.header) === h);
    if (match && ![...colForIdx.values()].includes(match.key)) colForIdx.set(colNumber, match.key);
  });
  const mappedKeys = new Set(colForIdx.values());
  const missingRequired = spec.columns.filter((c) => c.required && !mappedKeys.has(c.key));
  if (missingRequired.length > 0) {
    return { error: `Required column${missingRequired.length > 1 ? "s" : ""} not found: ${missingRequired.map((c) => c.header).join(", ")}. Keep the sample's header row unchanged.` };
  }

  // Walk data rows. Row numbers reported to the user are SPREADSHEET rows.
  const parsed: Array<{ rowNumber: number; values: Record<string, string> }> = [];
  for (let rn = 2; rn <= ws.rowCount; rn++) {
    const row = ws.getRow(rn);
    const values: Record<string, string> = {};
    let hasAny = false;
    for (const [colNumber, key] of colForIdx) {
      const text = cellText(row.getCell(colNumber).value);
      if (text) hasAny = true;
      values[key] = text;
    }
    if (!hasAny) continue; // blank line
    if (parsed.length >= MAX_ROWS) {
      return { error: `That file has more than ${MAX_ROWS} rows — split it into smaller files.` };
    }
    parsed.push({ rowNumber: rn, values });
  }
  if (parsed.length === 0) return { error: "No data rows found below the header." };
  return { parsed };
}

/** Whole-file validator dispatch for the wizard (demo) modules. */
async function runWizardValidators(
  module: DemoModule,
  rowsIn: Array<{ rowNumber: number; values: Record<string, string> }>,
  stamp: { type: string; id: number }, q: WizQ = pool,
): Promise<{ results: RowVerdict[]; counts: { valid: number; warning: number; error: number; needsMapping: number } }> {
  return isTxnModule(module) ? validateTransactionRows(module, rowsIn, stamp, q)
    : isVoucherModule(module) ? validateVoucherRows(module, rowsIn, stamp, q)
    : module === "daybook" ? validateDaybookRows(rowsIn, stamp, q)
    : validateOpeningStockRows(rowsIn, stamp, q);
}

router.post(
  "/imports/parse",
  requireModuleAction(PERM, "add"),
  // Raw body (like the backup upload): the file is parsed server-side anyway,
  // so a multipart wrapper or a presigned round-trip buys nothing.
  express.raw({ type: () => true, limit: "10mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const module = asModule(req.query.module);
    if (!module) { res.status(400).json({ error: `Pass ?module= one of: ${MODULES.join(", ")}` }); return; }
    const filename = String(req.query.filename ?? "upload.xlsx").replace(/[^A-Za-z0-9 ._()-]/g, "_").slice(-120);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "The uploaded file was empty." }); return;
    }

    const pw = await parseWorkbookValues(module, body);
    if ("error" in pw) { res.status(400).json({ error: pw.error }); return; }

    // Transaction AND voucher imports must know WHERE the documents land
    // before anything is validated — stock checks, ledgers, allocation scope
    // and duplicates are all per-location. The location is a request,
    // resolveActingLocation is the authority.
    let txnLoc: { type: string; id: number } | null = null;
    if (isDemoModule(module)) {
      // Explicit choice required — defaulting to the uploader's own branch
      // would silently stamp a whole migration onto the wrong location.
      if (!req.query.locationType) {
        res.status(400).json({ error: "Pick the target location first — every document in the file is recorded there." });
        return;
      }
      const resolved = await resolveActingLocation(pool, {
        employee: (req as any).employee,
        requested: { type: req.query.locationType, id: req.query.locationId },
      });
      if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
      if (resolved.loc.type === "outlet" && await outletWritesBlocked(pool)) {
        res.status(400).json({ error: OUTLETS_DISABLED_MESSAGE }); return;
      }
      {
        const disabledMsg = await disabledWarehouseError(pool, [{ type: resolved.loc.type, id: resolved.loc.id }]);
        if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
      }
      txnLoc = resolved.loc;
    }

    // Existing-name index for duplicate detection (master modules only).
    const existingByName = new Map<string, number>();
    const existingLedgerMeta = new Map<string, { id: number; system: boolean }>();
    if (module === "ledgers") {
      const { rows } = await pool.query<any>(
        `SELECT id, lower(name) AS lname, (code IS NOT NULL OR is_group = true OR is_system_group = true) AS system
           FROM account_ledgers`,
      );
      for (const r of rows) {
        if (!existingByName.has(r.lname)) {
          existingByName.set(r.lname, Number(r.id));
          existingLedgerMeta.set(r.lname, { id: Number(r.id), system: Boolean(r.system) });
        }
      }
    } else if (module === "customers" || module === "vendors") {
      const { rows } = await pool.query<any>(`SELECT id, lower(name) AS lname FROM ${module}`);
      for (const r of rows) if (!existingByName.has(r.lname)) existingByName.set(r.lname, Number(r.id));
    }
    const existingItemCodes = new Map<string, number>();
    const existingBarcodes = new Map<string, number>();
    if (module === "items") {
      const { rows } = await pool.query<any>(
        `SELECT id, lower(name) AS lname, lower(item_code) AS lcode, lower(barcode) AS lbarcode FROM items`,
      );
      for (const r of rows) {
        if (!existingByName.has(r.lname)) existingByName.set(r.lname, Number(r.id));
        if (r.lcode && !existingItemCodes.has(r.lcode)) existingItemCodes.set(r.lcode, Number(r.id));
        if (r.lbarcode && !existingBarcodes.has(r.lbarcode)) existingBarcodes.set(r.lbarcode, Number(r.id));
      }
    }

    // Master modules: index of assignable locations, plus which of them the
    // uploader may actually assign (Head Office = all; branch = own scope).
    // Ledgers included — an imported ledger is owned by a location too.
    let partyLocations: ValidateContext["partyLocations"];
    let allowedLocationKeys: ValidateContext["allowedLocationKeys"];
    if (module === "customers" || module === "vendors" || module === "ledgers") {
      partyLocations = new Map();
      const [{ rows: whs }, { rows: outs }] = await Promise.all([
        pool.query<any>(`SELECT id, name FROM warehouses`),
        pool.query<any>(`SELECT id, name FROM outlets`),
      ]);
      for (const w of whs) partyLocations.set(normHeader(String(w.name)), { type: "warehouse", id: Number(w.id), name: String(w.name) });
      for (const o of outs) partyLocations.set(normHeader(String(o.name)), { type: "outlet", id: Number(o.id), name: String(o.name) });
      const uploader = (req as any).employee as { branchType: string; branchId: number } | undefined;
      const { getUserDataScope } = await import("../lib/dataScope");
      const scope = uploader ? await getUserDataScope(uploader) : null;
      if (scope && !scope.isHeadOffice) {
        allowedLocationKeys = new Set<string>([
          ...scope.warehouseIds.map((i) => `warehouse:${i}`),
          ...scope.outletIds.map((i) => `outlet:${i}`),
        ]);
      } else {
        allowedLocationKeys = null; // Head Office assigns anywhere
      }
    }

    const ctx: ValidateContext = {
      existingByName,
      existingLedgerMeta: module === "ledgers" ? existingLedgerMeta : undefined,
      seenNames: new Map(),
      parentCandidates: module === "ledgers" ? await loadParentCandidates() : undefined,
      partyLocations,
      allowedLocationKeys,
      existingItemCodes: module === "items" ? existingItemCodes : undefined,
      existingBarcodes: module === "items" ? existingBarcodes : undefined,
    };

    // Row verdicts. Wizard-module rows are validated as a whole file
    // (grouping and running allocation both need order); master rows one by
    // one against the ctx indexes.
    const parsed: Array<{ rowNumber: number; values: Record<string, string>; verdict: RowVerdict }> =
      pw.parsed.map((p) => ({
        rowNumber: p.rowNumber, values: p.values,
        verdict: isDemoModule(module)
          ? { status: "valid", reason: null, suggestion: null, duplicateOfId: null, norm: {} }
          : validateRow(module, p.rowNumber, p.values, ctx),
      }));

    if (isDemoModule(module) && txnLoc) {
      const { results } = await runWizardValidators(
        module, parsed.map((p) => ({ rowNumber: p.rowNumber, values: p.values })), txnLoc,
      );
      parsed.forEach((p, i) => { p.verdict = results[i]; });
    }

    const counts = { valid: 0, warning: 0, error: 0 };
    for (const p of parsed) counts[p.verdict.status === "needs_mapping" ? "error" : p.verdict.status]++;

    const emp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
    const { rows: [batch] } = await pool.query(
      `INSERT INTO import_batches (module, filename, status, total_rows, valid_rows, warning_rows, error_rows, created_by, location_type, location_id, conversion)
       VALUES ($1, $2, 'validated', $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [module, filename, parsed.length, counts.valid, counts.warning, counts.error,
       username(req),
       txnLoc?.type ?? emp?.branchType ?? "headoffice",
       txnLoc?.id ?? emp?.branchId ?? 0,
       pw.conversion ? JSON.stringify(pw.conversion) : null],
    );

    const rowsOut: any[] = [];
    for (const p of parsed) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO import_rows (batch_id, row_number, raw, status, reason, suggestion, duplicate_of_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [batch.id, p.rowNumber, JSON.stringify({ values: p.values, norm: p.verdict.norm }),
         p.verdict.status, p.verdict.reason, p.verdict.suggestion, p.verdict.duplicateOfId],
      );
      rowsOut.push(r);
    }

    logActivity({
      action: "CREATE", module: "imports", entityType: "import_batch", entityId: Number(batch.id),
      description: `Validated ${module} import "${filename}" — ${parsed.length} rows (${counts.valid} valid, ${counts.warning} warnings, ${counts.error} errors)`,
      user: username(req),
    }).catch(() => {});

    res.status(201).json({
      batch: batchJson(batch), rows: rowsOut.map(rowJson),
      ...(isTxnModule(module) ? { summary: txnBatchSummary(rowsOut) } : {}),
    });
  },
);

// ── 2b. Mapping step ─────────────────────────────────────────────────────────
// import_mappings is permanent memory: map an old-ERP name once (choose an
// existing master or create one) and every later file resolves it silently.
// Masters created here are REAL records — created through the SAME code paths
// as manual creation. Saving mappings re-validates the batch from its stored
// raw values, so no re-upload is ever needed.

/** Re-run the whole-file validator for a demo-module batch from stored raws. */
export async function revalidateDemoBatch(
  id: number, module: DemoModule, stamp: { type: string; id: number },
  // Pass a transaction client to keep the revalidation writes atomic with the
  // caller's other writes (the wizard approve does this).
  q: { query: (sql: string, params?: unknown[]) => Promise<any> } = pool,
) {
  const { rows: importRows } = await q.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id]);
  const rowsIn = importRows.map((r: any) => ({ rowNumber: Number(r.row_number), values: (r.raw?.values ?? {}) as Record<string, string> }));
  const { results, counts } = await runWizardValidators(module, rowsIn, stamp, q);
  for (let i = 0; i < importRows.length; i++) {
    const v = results[i];
    await q.query(
      `UPDATE import_rows SET status = $2, reason = $3, suggestion = $4, raw = $5 WHERE id = $1`,
      [importRows[i].id, v.status, v.reason, v.suggestion,
       JSON.stringify({ values: rowsIn[i].values, norm: v.norm })],
    );
  }
  const { rows: [updated] } = await q.query(
    `UPDATE import_batches SET valid_rows = $2, warning_rows = $3, error_rows = $4,
        demo_report  = CASE WHEN status = 'demo_ready' THEN NULL ELSE demo_report END,
        demo_summary = CASE WHEN status = 'demo_ready' THEN NULL ELSE demo_summary END,
        status       = CASE WHEN status = 'demo_ready' THEN 'validated' ELSE status END
     WHERE id = $1 RETURNING *`,
    [id, counts.valid, counts.warning, counts.error + counts.needsMapping],
  );
  const { rows: outRows } = await q.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id]);
  return { updated, outRows, counts };
}

/** Master tables a mapping kind can target. product spans three tables with
 *  overlapping id spaces, so its rows carry target_kind. */
const PRODUCT_TARGET_KINDS = ["item", "material", "raw_material"] as const;
const PRODUCT_TABLE: Record<string, string> = { item: "items", material: "materials", raw_material: "raw_materials" };

/** Verify a chosen mapping target actually exists (and, for ledgers, is a
 *  postable active ledger). Returns the target's display name or an error. */
async function checkMappingTarget(
  kind: MappingKind, targetId: number, targetKind: string | null,
): Promise<{ name: string; targetKind: string | null } | { error: string }> {
  if (!Number.isInteger(targetId) || targetId <= 0) return { error: "targetId must be a positive integer" };
  if (kind === "customer" || kind === "vendor") {
    // target_kind 'ledger': a NON-party name in a receipt/payment file routed
    // to a Chart-of-Accounts ledger — its rows import as journal vouchers.
    if (targetKind === "ledger") {
      const { rows: [r] } = await pool.query(
        `SELECT name, COALESCE(is_group, false) AS grp, COALESCE(is_active, true) AS act FROM account_ledgers WHERE id = $1`,
        [targetId],
      );
      if (!r) return { error: `Ledger #${targetId} does not exist` };
      if (r.grp) return { error: `"${r.name}" is a group — route onto a postable ledger, not a group` };
      if (!r.act) return { error: `Ledger "${r.name}" is inactive` };
      return { name: `${r.name} (journal entry)`, targetKind: "ledger" };
    }
    const { rows: [r] } = await pool.query(`SELECT name FROM ${kind === "customer" ? "customers" : "vendors"} WHERE id = $1`, [targetId]);
    return r ? { name: String(r.name), targetKind: null } : { error: `${MAPPING_LABEL[kind]} #${targetId} does not exist` };
  }
  if (kind === "ledger") {
    const { rows: [r] } = await pool.query(
      `SELECT name, COALESCE(is_group, false) AS grp, COALESCE(is_active, true) AS act FROM account_ledgers WHERE id = $1`,
      [targetId],
    );
    if (!r) return { error: `Ledger #${targetId} does not exist` };
    if (r.grp) return { error: `"${r.name}" is a group — map onto a postable ledger, not a group` };
    if (!r.act) return { error: `Ledger "${r.name}" is inactive` };
    return { name: String(r.name), targetKind: null };
  }
  // product — target_kind 'charge' routes a charge-type "item" line (freight,
  // packing…) onto a purchase-bill expense ledger instead of a stock product.
  if (targetKind === "charge") {
    const eligible = await importExpenseLedgerOptions();
    const led = [...eligible.values()].find((l) => l.id === targetId);
    if (!led) return { error: `Ledger #${targetId} is not a postable expense ledger eligible as a purchase bill charge` };
    return { name: `Bill charge → ${led.name}`, targetKind: "charge" };
  }
  const tk = targetKind && (PRODUCT_TARGET_KINDS as readonly string[]).includes(targetKind) ? targetKind : "item";
  const { rows: [r] } = await pool.query(`SELECT name FROM ${PRODUCT_TABLE[tk]} WHERE id = $1`, [targetId]);
  return r ? { name: String(r.name), targetKind: tk } : { error: `${KIND_LABEL[tk as keyof typeof KIND_LABEL] ?? tk} #${targetId} does not exist` };
}

async function upsertMapping(kind: MappingKind, sourceName: string, targetId: number, targetKind: string | null, user: string) {
  await pool.query(
    `INSERT INTO import_mappings (kind, source_name, source_norm, target_id, target_kind, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kind, source_norm) DO UPDATE
       SET target_id = EXCLUDED.target_id, target_kind = EXCLUDED.target_kind,
           source_name = EXCLUDED.source_name, updated_at = now()`,
    [kind, sourceName, normName(sourceName), targetId, targetKind, user],
  );
}

/** Build the mapping workspace — unmapped names (with exact-match
 *  suggestions the user CONFIRMS; prefill only, nothing is ever mapped
 *  without an explicit save) plus the pick-lists for "choose existing" —
 *  from any set of import rows: one batch or a whole migration. */
async function buildMappingWorkspace(importRows: Array<{ raw?: any }>) {
  const unmapped = new Map<string, { kind: MappingKind; name: string; rows: number; routable?: boolean }>();
  for (const r of importRows) {
    for (const m of (r.raw?.norm?.missingMappings ?? []) as Array<{ kind: MappingKind; name: string; routable?: boolean }>) {
      const key = `${m.kind}|${normName(String(m.name))}`;
      const cur = unmapped.get(key);
      if (cur) { cur.rows++; if (m.routable) cur.routable = true; }
      else unmapped.set(key, { kind: m.kind, name: String(m.name), rows: 1, ...(m.routable ? { routable: true } : {}) });
    }
  }

  // Exact-name candidates for prefill.
  const kindsPresent = new Set([...unmapped.values()].map((u) => u.kind));
  const suggest = new Map<string, { targetId: number; targetKind: string | null; name: string }>();
  const index = (kind: MappingKind, tk: string | null) => (r: any) => {
    const key = `${kind}|${normName(String(r.name))}`;
    if (!suggest.has(key)) suggest.set(key, { targetId: Number(r.id), targetKind: tk, name: String(r.name) });
  };
  if (kindsPresent.has("customer")) (await pool.query(`SELECT id, name FROM customers`)).rows.forEach(index("customer", null));
  if (kindsPresent.has("vendor")) (await pool.query(`SELECT id, name FROM vendors`)).rows.forEach(index("vendor", null));
  if (kindsPresent.has("ledger")) {
    (await pool.query(
      `SELECT id, name FROM account_ledgers WHERE NOT COALESCE(is_group, false) AND COALESCE(is_active, true)`,
    )).rows.forEach(index("ledger", null));
  }
  if (kindsPresent.has("product")) {
    (await pool.query(`SELECT id, name FROM items`)).rows.forEach(index("product", "item"));
    (await pool.query(`SELECT id, name FROM materials`)).rows.forEach(index("product", "material"));
    (await pool.query(`SELECT id, name FROM raw_materials`)).rows.forEach(index("product", "raw_material"));
  }

  // Pick-lists for the "choose existing" dropdowns — served here because the
  // import page's permission does not imply the masters pages' permissions.
  const candidates: Record<string, Array<{ id: number; name: string; targetKind?: string }>> = {};
  if (kindsPresent.has("customer")) {
    candidates.customer = (await pool.query(`SELECT id, name FROM customers ORDER BY name`)).rows
      .map((r: any) => ({ id: Number(r.id), name: String(r.name) }));
  }
  if (kindsPresent.has("vendor")) {
    candidates.vendor = (await pool.query(`SELECT id, name FROM vendors ORDER BY name`)).rows
      .map((r: any) => ({ id: Number(r.id), name: String(r.name) }));
  }
  if (kindsPresent.has("ledger")) {
    candidates.ledger = (await pool.query(
      `SELECT id, name FROM account_ledgers WHERE NOT COALESCE(is_group, false) AND COALESCE(is_active, true) ORDER BY name`,
    )).rows.map((r: any) => ({ id: Number(r.id), name: String(r.name) }));
  }
  if (kindsPresent.has("product")) {
    const prods: Array<{ id: number; name: string; targetKind: string }> = [];
    for (const [table, tk] of [["items", "item"], ["materials", "material"], ["raw_materials", "raw_material"]] as const) {
      (await pool.query(`SELECT id, name FROM ${table} ORDER BY name`)).rows
        .forEach((r: any) => prods.push({ id: Number(r.id), name: String(r.name), targetKind: tk }));
    }
    // Bill-charge routing for charge-type lines in purchase files (freight,
    // packing…) — pick "Bill charge → <expense ledger>" instead of a product.
    for (const led of [...(await importExpenseLedgerOptions()).values()].sort((a, b) => a.name.localeCompare(b.name))) {
      prods.push({ id: led.id, name: `Bill charge → ${led.name}`, targetKind: "charge" });
    }
    candidates.product = prods;
  }

  // Ledgers a non-party receipt/payment name may be ROUTED to (journal entry)
  // — only offered when the file surfaced at least one routable name.
  const anyRoutable = [...unmapped.values()].some((u) => u.routable);
  const routeLedgers = anyRoutable
    ? (await pool.query(
        `SELECT id, name FROM account_ledgers WHERE NOT COALESCE(is_group, false) AND COALESCE(is_active, true) ORDER BY name`,
      )).rows.map((r: any) => ({ id: Number(r.id), name: String(r.name) }))
    : [];

  return {
    unmapped: [...unmapped.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
      .map((u) => ({ ...u, suggestion: suggest.get(`${u.kind}|${normName(u.name)}`) ?? null })),
    candidates,
    routeLedgers,
    /** Groups a NEW ledger may be created under (create-ledger flow). */
    ledgerGroups: kindsPresent.has("ledger") ? await loadParentCandidates() : [],
  };
}

/** Unmapped names of a single batch (per-file flow). */
router.get("/imports/batches/:id/mappings", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [batch] } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
  if (!batch) { res.status(404).json({ error: "Import batch not found" }); return; }
  const module = asModule(batch.module);
  if (!module || !isDemoModule(module)) {
    res.status(400).json({ error: "Master imports have no mapping step — names ARE the records being created." }); return;
  }
  const { rows: importRows } = await pool.query(`SELECT raw FROM import_rows WHERE batch_id = $1`, [id]);
  res.json({ batch: batchJson(batch), ...(await buildMappingWorkspace(importRows)) });
});

/** Apply a list of mapping decisions — choose existing (targetId) or create
 *  new (create payload) per name — using the SAME creation code paths as
 *  manual entry, then upsert the permanent mapping memory. Shared by the
 *  per-batch and migration mapping endpoints. `noteRef` lands in the created
 *  masters' notes/description. */
async function applyMappingEntries(
  mappingsIn: any[],
  stamp: { type: string; id: number },
  user: string,
  noteRef: string,
): Promise<{
  saved: Array<{ kind: string; name: string; targetName: string }>;
  created: Array<{ kind: string; name: string; targetName: string }>;
  errors: Array<{ kind: string; name: string; reason: string }>;
}> {
  const saved: Array<{ kind: string; name: string; targetName: string }> = [];
  const created: Array<{ kind: string; name: string; targetName: string }> = [];
  const errors: Array<{ kind: string; name: string; reason: string }> = [];

  for (const m of mappingsIn as any[]) {
    const kind = String(m?.kind ?? "") as MappingKind;
    const name = String(m?.name ?? "").trim();
    if (!MAPPING_KINDS.includes(kind)) { errors.push({ kind: String(m?.kind), name, reason: `kind must be one of: ${MAPPING_KINDS.join(", ")}` }); continue; }
    if (!name) { errors.push({ kind, name: "(blank)", reason: "name is required" }); continue; }

    try {
      if (m?.targetKind === "skip") {
        // Explicit SKIP decision (receipt/payment non-party names only) —
        // recorded so the rows surface in the skip report, never re-asked.
        if (kind !== "customer" && kind !== "vendor") {
          errors.push({ kind, name, reason: "Only receipt/payment party names can be skipped" }); continue;
        }
        await upsertMapping(kind, name, 0, "skip", user);
        saved.push({ kind, name, targetName: "Skipped — not imported" });
        continue;
      }
      if (m?.create && typeof m.create === "object") {
        // Create a REAL master (same code path as manual creation), then map.
        const c = m.create as Record<string, unknown>;
        const newName = String(c.name ?? name).trim() || name;
        if (kind === "customer" || kind === "vendor") {
          const gst = String(c.gstNumber ?? "").trim().toUpperCase();
          if (gst && !GSTIN_RE.test(gst)) { errors.push({ kind, name, reason: `GSTIN "${gst}" is not a valid 15-character GSTIN` }); continue; }
          const phone = parsePhone(String(c.phone ?? "").trim());
          if (phone === "invalid") { errors.push({ kind, name, reason: `Phone "${c.phone}" is not a 10-digit number` }); continue; }
          const table = kind === "customer" ? "customers" : "vendors";
          const { rows: [dupe] } = await pool.query(`SELECT id, name FROM ${table} WHERE lower(name) = lower($1) LIMIT 1`, [newName]);
          if (dupe) {
            // Someone created it meanwhile — map onto it instead of failing.
            await upsertMapping(kind, name, Number(dupe.id), null, user);
            saved.push({ kind, name, targetName: String(dupe.name) });
            continue;
          }
          const input: any = {
            name: newName,
            ...(gst ? { gstNumber: gst } : {}),
            ...(phone ? { phone } : {}),
            ...(String(c.state ?? "").trim() ? { state: String(c.state).trim() } : {}),
            ...(String(c.address ?? "").trim() ? { address: String(c.address).trim() } : {}),
            notes: `Created at the mapping step (${noteRef})`,
          };
          const { row } = kind === "customer"
            ? await createCustomerWithLedger(input, stamp)
            : await createVendorWithLedger(input, stamp);
          const cl = Number(c.creditLimit ?? NaN);
          if (kind === "customer" && Number.isFinite(cl) && cl > 0) {
            await pool.query(`UPDATE customers SET credit_limit = $1 WHERE id = $2`, [Math.round(cl * 100) / 100, row.id]);
          }
          await upsertMapping(kind, name, Number(row.id), null, user);
          created.push({ kind, name, targetName: newName });
        } else if (kind === "product") {
          const input = {
            name: newName,
            unit: String(c.unit ?? "").trim(),
            hsnCode: String(c.hsnCode ?? "").trim() || null,
            taxRate: c.taxRate == null || c.taxRate === "" ? 0 : Number(c.taxRate),
            mrp: c.mrp == null || c.mrp === "" ? 0 : Number(c.mrp),
            cost: c.cost == null || c.cost === "" ? 0 : Number(c.cost),
          };
          const invalid = itemCreateError(input);
          if (invalid) { errors.push({ kind, name, reason: invalid }); continue; }
          const { rows: [dupe] } = await pool.query(`SELECT id, name FROM items WHERE lower(name) = lower($1) LIMIT 1`, [newName]);
          if (dupe) {
            await upsertMapping(kind, name, Number(dupe.id), "item", user);
            saved.push({ kind, name, targetName: String(dupe.name) });
            continue;
          }
          const createdItem = await createItemCore(pool, input);
          await upsertMapping(kind, name, createdItem.id, "item", user);
          created.push({ kind, name, targetName: newName });
        } else {
          // ledger — parent group comes from the caller (picked off the chart).
          const parentId = Number(c.parentId ?? NaN);
          const parents = await loadParentCandidates();
          const parent = parents.find((p) => p.id === parentId);
          if (!parent) { errors.push({ kind, name, reason: "Pick a valid Ledger Group (parentId) for the new ledger" }); continue; }
          const { rows: [dupe] } = await pool.query(`SELECT id, name FROM account_ledgers WHERE lower(name) = lower($1) LIMIT 1`, [newName]);
          if (dupe) {
            const check = await checkMappingTarget("ledger", Number(dupe.id), null);
            if ("error" in check) { errors.push({ kind, name, reason: `"${newName}" already exists but ${check.error.replace(/^Ledger /, "").toLowerCase()}` }); continue; }
            await upsertMapping(kind, name, Number(dupe.id), null, user);
            saved.push({ kind, name, targetName: String(dupe.name) });
            continue;
          }
          const createdLedger = await insertChartAccount(pool, {
            name: newName, type: parent.type, parentId: parent.id, section: parent.section,
            description: `Created at the mapping step (${noteRef})`, isGroup: false, user,
          });
          await pool.query(
            `UPDATE account_ledgers SET location_type = $1, location_id = $2 WHERE id = $3`,
            [stamp.type, stamp.id, createdLedger.id],
          );
          await upsertMapping(kind, name, createdLedger.id, null, user);
          created.push({ kind, name, targetName: newName });
        }
      } else {
        // Choose existing.
        const targetId = Number(m?.targetId ?? NaN);
        const check = await checkMappingTarget(kind, targetId, m?.targetKind == null ? null : String(m.targetKind));
        if ("error" in check) { errors.push({ kind, name, reason: check.error }); continue; }
        await upsertMapping(kind, name, targetId, check.targetKind, user);
        saved.push({ kind, name, targetName: check.name });
      }
    } catch (e: any) {
      errors.push({ kind, name, reason: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return { saved, created, errors };
}

/** Save mappings for a batch: choose existing (targetId) or create new
 *  (create payload) per name; upserts import_mappings and re-validates. */
router.post("/imports/batches/:id/mappings", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [batch] } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
  if (!batch) { res.status(404).json({ error: "Import batch not found" }); return; }
  const module = asModule(batch.module);
  if (!module || !isDemoModule(module)) {
    res.status(400).json({ error: "Master imports have no mapping step." }); return;
  }
  if (batch.migration_id != null) {
    res.status(409).json({ error: `This file belongs to migration ${migrationDisplayId(Number(batch.migration_id))} — save its mappings from the Migration wizard.` });
    return;
  }
  if (batch.status !== "validated") {
    res.status(409).json({ error: "Mappings can only be saved while the batch is at the mapping/analyse stage." }); return;
  }

  const body = (req.body ?? {}) as { mappings?: unknown };
  const mappingsIn = Array.isArray(body.mappings) ? body.mappings : [];
  if (mappingsIn.length === 0) {
    res.status(400).json({ error: "Pass mappings: [{ kind, name, targetId | create }]" }); return;
  }
  if (mappingsIn.length > 500) { res.status(400).json({ error: "Too many mappings in one request." }); return; }

  const stamp = { type: String(batch.location_type ?? "headoffice"), id: Number(batch.location_id ?? 0) };
  const user = username(req);
  const { saved, created, errors } = await applyMappingEntries(mappingsIn, stamp, user, `import batch #${id}`);

  const { updated, outRows } = await revalidateDemoBatch(id, module, stamp);

  logActivity({
    action: "UPDATE", module: "imports", entityType: "import_batch", entityId: id,
    description: `Saved mappings for ${module} import "${batch.filename}" — ${saved.length} mapped, ${created.length} created${errors.length ? `, ${errors.length} failed` : ""}`,
    user,
  }).catch(() => {});

  res.json({
    batch: batchJson(updated), rows: outRows.map(rowJson), saved, created, errors,
    ...(isTxnModule(module) ? { summary: txnBatchSummary(outRows) } : {}),
  });
});

// ── 2c. Manage Mappings (permanent memory, independent of any batch) ────────

router.get("/imports/mappings", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const kindFilter = req.query.kind ? String(req.query.kind) : null;
  if (kindFilter && !(MAPPING_KINDS as string[]).includes(kindFilter)) {
    res.status(400).json({ error: `kind must be one of: ${MAPPING_KINDS.join(", ")}` }); return;
  }
  const { rows } = await pool.query<any>(
    `SELECT m.*,
            CASE m.kind
              WHEN 'customer' THEN CASE COALESCE(m.target_kind, '')
                WHEN 'skip'   THEN 'Skipped — not imported'
                WHEN 'ledger' THEN (SELECT l.name || ' (journal entry)' FROM account_ledgers l WHERE l.id = m.target_id)
                ELSE (SELECT c.name FROM customers c WHERE c.id = m.target_id)
              END
              WHEN 'vendor'   THEN CASE COALESCE(m.target_kind, '')
                WHEN 'skip'   THEN 'Skipped — not imported'
                WHEN 'ledger' THEN (SELECT l.name || ' (journal entry)' FROM account_ledgers l WHERE l.id = m.target_id)
                ELSE (SELECT v.name FROM vendors v WHERE v.id = m.target_id)
              END
              WHEN 'ledger'   THEN (SELECT l.name FROM account_ledgers l WHERE l.id = m.target_id)
              WHEN 'product'  THEN CASE COALESCE(m.target_kind, 'item')
                WHEN 'material'     THEN (SELECT mt.name FROM materials mt WHERE mt.id = m.target_id)
                WHEN 'raw_material' THEN (SELECT rm.name FROM raw_materials rm WHERE rm.id = m.target_id)
                WHEN 'charge'       THEN (SELECT 'Bill charge → ' || l.name FROM account_ledgers l WHERE l.id = m.target_id)
                ELSE (SELECT i.name FROM items i WHERE i.id = m.target_id)
              END
            END AS target_name
       FROM import_mappings m
      WHERE ($1::text IS NULL OR m.kind = $1)
      ORDER BY m.kind, lower(m.source_name)`,
    [kindFilter],
  );
  res.json({
    mappings: rows.map((r: any) => ({
      id: Number(r.id),
      kind: r.kind,
      sourceName: r.source_name,
      targetId: Number(r.target_id),
      targetKind: r.target_kind ?? null,
      /** null = stale: the target was deleted since — remap or delete. */
      targetName: r.target_name ?? null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

/** Pick-lists for re-pointing a saved mapping (Manage Mappings screen). */
router.get("/imports/mapping-candidates", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const kind = String(req.query.kind ?? "") as MappingKind;
  if (!MAPPING_KINDS.includes(kind)) {
    res.status(400).json({ error: `kind must be one of: ${MAPPING_KINDS.join(", ")}` }); return;
  }
  const out: Array<{ id: number; name: string; targetKind?: string }> = [];
  if (kind === "customer") {
    (await pool.query(`SELECT id, name FROM customers ORDER BY name`)).rows
      .forEach((r: any) => out.push({ id: Number(r.id), name: String(r.name) }));
  } else if (kind === "vendor") {
    (await pool.query(`SELECT id, name FROM vendors ORDER BY name`)).rows
      .forEach((r: any) => out.push({ id: Number(r.id), name: String(r.name) }));
  } else if (kind === "ledger") {
    (await pool.query(
      `SELECT id, name FROM account_ledgers WHERE NOT COALESCE(is_group, false) AND COALESCE(is_active, true) ORDER BY name`,
    )).rows.forEach((r: any) => out.push({ id: Number(r.id), name: String(r.name) }));
  } else {
    for (const [table, tk] of [["items", "item"], ["materials", "material"], ["raw_materials", "raw_material"]] as const) {
      (await pool.query(`SELECT id, name FROM ${table} ORDER BY name`)).rows
        .forEach((r: any) => out.push({ id: Number(r.id), name: String(r.name), targetKind: tk }));
    }
  }
  res.json({ candidates: out });
});

/** A change to the permanent mapping memory invalidates every wizard batch
 *  still in flight: rows re-resolve against the current mappings and any
 *  pending demo is cleared (demo_ready → validated), so an approve can never
 *  post to targets the reviewed demo report never showed. Over-invalidation
 *  (batches not touching the edited name) is harmless — they just re-demo. */
async function revalidateInFlightBatches(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, module, location_type, location_id FROM import_batches
      WHERE status IN ('validated', 'demo_ready')
        AND module IN ('sales','purchases','receipts','payments','daybook','opening_stock')`,
  );
  for (const b of rows) {
    await revalidateDemoBatch(
      Number(b.id),
      b.module as DemoModule,
      { type: String(b.location_type ?? "headoffice"), id: Number(b.location_id ?? 1) },
    );
  }
  // Migrations gate their approve on THEIR demo snapshot — a mapping change
  // invalidates that too (over-invalidation is harmless: just re-demo).
  await pool.query(
    `UPDATE import_migrations SET status = 'draft', demo_report = NULL, demo_summary = NULL, demo_at = NULL, demo_by = NULL
      WHERE status = 'demo_ready'`,
  );
}

router.put("/imports/mappings/:id", requireModuleAction(PERM, "edit"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [row] } = await pool.query(`SELECT * FROM import_mappings WHERE id = $1`, [id]);
  if (!row) { res.status(404).json({ error: "Mapping not found" }); return; }
  const kind = String(row.kind) as MappingKind;
  const body = (req.body ?? {}) as { targetId?: unknown; targetKind?: unknown };
  const targetId = Number(body.targetId ?? NaN);
  const check = await checkMappingTarget(kind, targetId, body.targetKind == null ? null : String(body.targetKind));
  if ("error" in check) { res.status(400).json({ error: check.error }); return; }
  const { rows: [updated] } = await pool.query(
    `UPDATE import_mappings SET target_id = $2, target_kind = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, targetId, check.targetKind],
  );
  await revalidateInFlightBatches();
  logActivity({
    action: "UPDATE", module: "imports", entityType: "import_mapping", entityId: id,
    description: `Re-pointed ${kind} mapping "${row.source_name}" → "${check.name}"`,
    user: username(req),
  }).catch(() => {});
  res.json({
    mapping: {
      id: Number(updated.id), kind: updated.kind, sourceName: updated.source_name,
      targetId: Number(updated.target_id), targetKind: updated.target_kind ?? null, targetName: check.name,
    },
  });
});

router.delete("/imports/mappings/:id", requireModuleAction(PERM, "delete"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [row] } = await pool.query(`DELETE FROM import_mappings WHERE id = $1 RETURNING *`, [id]);
  if (!row) { res.status(404).json({ error: "Mapping not found" }); return; }
  await revalidateInFlightBatches();
  logActivity({
    action: "DELETE", module: "imports", entityType: "import_mapping", entityId: id,
    description: `Deleted ${row.kind} mapping "${row.source_name}" — the name will ask to be mapped again on its next appearance`,
    user: username(req),
  }).catch(() => {});
  res.json({ success: true });
});


// ── 3. History + detail ──────────────────────────────────────────────────────

/** Resolve a batch's location stamp to a display name for the history list. */
async function locationNameResolver(): Promise<(b: any) => string | null> {
  const [{ rows: whs }, { rows: outs }] = await Promise.all([
    pool.query<any>(`SELECT id, name FROM warehouses`),
    pool.query<any>(`SELECT id, name FROM outlets`),
  ]);
  const wh = new Map<number, string>(whs.map((r: any) => [Number(r.id), String(r.name)] as [number, string]));
  const out = new Map<number, string>(outs.map((r: any) => [Number(r.id), String(r.name)] as [number, string]));
  return (b: any): string | null => {
    const t = b.location_type ?? null;
    if (!t) return null;
    if (t === "headoffice") return "Head Office";
    if (t === "warehouse") return wh.get(Number(b.location_id)) ?? `Warehouse #${b.location_id}`;
    if (t === "outlet") return out.get(Number(b.location_id)) ?? `Outlet #${b.location_id}`;
    return String(t);
  };
}

router.get("/imports/batches", requireModuleView(PERM), async (_req: Request, res: Response): Promise<void> => {
  // Migration-owned files are managed (and listed) by the Migration wizard.
  const [{ rows }, nameOf] = await Promise.all([
    pool.query(`SELECT *, (demo_report IS NOT NULL) AS has_demo_report FROM import_batches WHERE migration_id IS NULL ORDER BY id DESC LIMIT 200`),
    locationNameResolver(),
  ]);
  res.json({ batches: rows.map((b: any) => { const { demo_report: _dr, ...rest } = b; return { ...batchJson(rest), locationName: nameOf(b) }; }) });
});

router.get("/imports/batches/:id", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [batch] } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
  if (!batch) { res.status(404).json({ error: "Import batch not found" }); return; }
  const [{ rows }, nameOf] = await Promise.all([
    pool.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id]),
    locationNameResolver(),
  ]);
  res.json({
    batch: { ...batchJson(batch), locationName: nameOf(batch) },
    rows: rows.map(rowJson),
    ...(isTxnModule(batch.module) ? { summary: txnBatchSummary(rows) } : {}),
  });
});

// ── 3b. Error file — only the problem rows, with the reason on each ─────────
// Original (visible) template columns + Error Reason + How To Fix, so the user
// corrects the rows in Excel and re-uploads just those.
router.get("/imports/batches/:id/error-file", requireModuleAction(PERM, "download"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [batch] } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
  if (!batch) { res.status(404).json({ error: "Import batch not found" }); return; }
  const module = asModule(batch.module);
  if (!module) { res.status(400).json({ error: "Unknown module on this batch" }); return; }
  const { rows } = await pool.query(
    `SELECT * FROM import_rows WHERE batch_id = $1 AND status IN ('error', 'needs_party', 'needs_mapping', 'failed') ORDER BY row_number`,
    [id],
  );
  if (rows.length === 0) { res.status(404).json({ error: "This batch has no failed rows — nothing to download." }); return; }

  const spec = TEMPLATES[module];
  const visibleCols = spec.columns.filter((c) => !c.hidden);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Failed Rows");
  ws.columns = [
    ...visibleCols.map((c) => ({ header: c.header, key: c.key, width: Math.max(16, c.header.length + 6) })),
    { header: "Error Reason", key: "__reason", width: 60 },
    { header: "How To Fix", key: "__fix", width: 50 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const values = (r.raw?.values ?? {}) as Record<string, string>;
    ws.addRow([
      ...visibleCols.map((c) => values[c.key] ?? ""),
      r.reason ?? "",
      r.suggestion ?? "",
    ]);
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${module}-import-errors-${batchDisplayId(id)}.xlsx"`);
  res.send(Buffer.from(buf as ArrayBuffer));
});


// ── 4a. Wizard: demo run, approve, discard ───────────────────────────────────
//
// ONE routine (runBatchImport) performs the actual import for every demo
// module, writing exclusively through the caller's PoolClient. The demo
// endpoint runs it inside a transaction it NEVER commits — computing the full
// report pack on the same client first, so the reports show the books exactly
// as they would look — then rolls everything back. Approve runs the very same
// routine and commits, all-or-nothing.

interface RunRowOutcome {
  rowId: number;
  rowNumber: number;
  status: "imported" | "skipped" | "failed";
  reason: string | null;
  createdType: string | null;
  createdId: number | null;
  created: Record<string, unknown> | null;
}

/** Thrown in approve mode on ANY document failure: the whole transaction must
 *  die — a partially approved migration would be worse than none. */
class ImportAbort extends Error {
  constructor(public docLabel: string, public reasonText: string) {
    super(`${docLabel}: ${reasonText}`);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Old-ERP numbers sorted numeric-aware so min/max read naturally. */
function sortLegacy(nums: string[]): string[] {
  const uniq = [...new Set(nums.map((s) => String(s).trim()).filter(Boolean))];
  return uniq.sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

async function runBatchImport(client: PoolClient, opts: {
  batchId: number;
  module: DemoModule;
  importRows: any[];
  loc: { type: string; id: number };
  user: string;
  mode: "demo" | "approve";
}): Promise<{
  outcomes: RunRowOutcome[];
  counts: { imported: number; skipped: number; failed: number };
  failures: Array<{ rowNumber: number; name: string; reason: string }>;
  legacyNumbers: string[];
}> {
  const { batchId: id, module, importRows, user, mode } = opts;
  const counts = { imported: 0, skipped: 0, failed: 0 };
  const failures: Array<{ rowNumber: number; name: string; reason: string }> = [];
  const outcomes: RunRowOutcome[] = [];
  const legacyNumbers: string[] = [];

  // Rows that never validated keep their verdict text — no outcome is emitted
  // for them, so neither the demo nor the approve writer touches them.
  const rowBad = (r: any) =>
    r.status === "error" || r.status === "needs_mapping" || r.status === "needs_party";
  // Approve imports exactly what the demo proved out: documents that failed
  // in the demo run are excluded (visibly), never silently retried.
  const demoFailed = (r: any) => mode === "approve" && r.raw?.demo?.status === "failed";

  const emit = (r: any, o: Omit<RunRowOutcome, "rowId" | "rowNumber">) =>
    outcomes.push({ rowId: Number(r.id), rowNumber: Number(r.row_number), ...o });
  const emitSkip = (r: any, reason: string) => {
    counts.skipped++;
    emit(r, { status: "skipped", reason, createdType: null, createdId: null, created: null });
  };
  const failDoc = (docRows: any[], head: any, label: string, reason: string) => {
    if (mode === "approve") throw new ImportAbort(label, reason);
    counts.failed += docRows.length;
    failures.push({ rowNumber: Number(head.row_number), name: label, reason });
    for (const rr of docRows) emit(rr, { status: "failed", reason, createdType: null, createdId: null, created: null });
  };

  if (module === "sales" || module === "purchases") {
    // Whole DOCUMENTS in file order (avg cost depends on it — never re-sort).
    const loc = { type: opts.loc.type, id: Number(opts.loc.id ?? 0) } as ProdLocation;
    const docsMap = new Map<number, any[]>();
    for (const r of importRows) {
      const dIdx = Number(r.raw?.norm?.doc ?? -1);
      if (!docsMap.has(dIdx)) docsMap.set(dIdx, []);
      docsMap.get(dIdx)!.push(r);
    }
    for (const dIdx of [...docsMap.keys()].sort((a, b) => a - b)) {
      const docRows = docsMap.get(dIdx)!;
      const head = docRows.find((r) => r.raw?.norm?.head) ?? docRows[0];
      const hn = (head.raw?.norm ?? {}) as Record<string, any>;
      const label = String(hn.invoiceNumber || "") || `rows ${docRows[0].row_number}–${docRows[docRows.length - 1].row_number}`;
      const walkIn = module === "sales" && hn.walkIn === true;
      const hasBad = dIdx < 0 || docRows.some(rowBad);
      if (hasBad || (hn.partyId == null && !walkIn)) {
        for (const r of docRows) {
          if (rowBad(r)) { counts.skipped++; continue; } // keep the verdict text
          emitSkip(r, hasBad
            ? "Skipped — another row of this document has errors or unmapped names"
            : "Skipped — the document's party was never mapped");
        }
        continue;
      }
      if (docRows.some(demoFailed)) {
        for (const r of docRows) emitSkip(r, "Excluded — this document failed in the demo run");
        continue;
      }
      try {
        if (module === "sales") {
          const invoiceNumber = String(hn.invoiceNumber || "") || `IMP-${id}-${dIdx + 1}`;
          const result = await importSaleDoc({
            invoiceNumber,
            saleDate: String(hn.dateIso),
            customerId: hn.partyId != null ? Number(hn.partyId) : null, // null = walk-in
            lines: docRows.map((r) => {
              const l = r.raw?.norm?.line ?? {};
              return l.unitDiscount !== undefined
                ? { itemId: Number(l.id), quantity: Number(l.quantity), unitPrice: Number(l.price ?? 0), unitDiscount: Number(l.unitDiscount ?? 0), priceMode: "inclusive" as const }
                : { itemId: Number(l.id), quantity: Number(l.quantity), unitPrice: Number(l.price ?? 0), discount: Number(l.discount ?? 0), priceMode: "exclusive" as const };
            }),
            billDiscount: Number(hn.billDiscount ?? 0),
            paymentMode: (hn.paymentMode ?? "credit") as "cash" | "bank" | "upi" | "credit",
            paidAmount: Number(hn.paidAmount ?? 0),
            reference: hn.reference ?? null,
            loc, user,
          }, client);
          // Provenance stamps — the bill, its sale-trail receipt (named after
          // the NEW invoice number) and any clearing receipts. Same client:
          // these stamps live and die with the surrounding transaction.
          await client.query(`UPDATE sales SET import_batch_id = $1 WHERE id = $2`, [id, result.saleId]);
          await client.query(
            `UPDATE receipts SET import_batch_id = $1
              WHERE (voucher_number = $2 OR id = ANY($3::int[])) AND import_batch_id IS NULL`,
            [id, result.invoiceNumber, result.clearingReceiptIds ?? []],
          );
          counts.imported += docRows.length;
          if (hn.invoiceNumber) legacyNumbers.push(String(hn.invoiceNumber));
          for (const r of docRows) {
            emit(r, {
              status: "imported", reason: null, createdType: "sale", createdId: result.saleId,
              created: r.id === head.id ? {
                invoiceNumber: result.invoiceNumber, totalAmount: result.totalAmount,
                salePaymentIds: result.salePaymentIds, clearingReceiptIds: result.clearingReceiptIds,
              } : null,
            });
          }
        } else {
          if (hn.partyId == null) throw new Error("Purchase bills always need a vendor"); // unreachable — validation guarantees it
          const result = await importPurchaseDoc({
            invoiceNumber: String(hn.invoiceNumber || "") || null,
            purchaseDate: String(hn.dateIso),
            vendorId: Number(hn.partyId),
            // Charge-mapped rows carry no stock line — their money is already
            // inside hn.otherCharges, folded in at validation.
            lines: docRows.filter((r) => r.raw?.norm?.line).map((r) => {
              const l = r.raw?.norm?.line ?? {};
              return { kind: (l.kind ?? "item") as "item" | "material" | "raw_material", id: Number(l.id), quantity: Number(l.quantity), rate: Number(l.rate ?? 0), discountPct: Number(l.discountPct ?? 0) };
            }),
            paidAmount: Number(hn.paidAmount ?? 0),
            paidFromLedgerId: hn.paidFromLedgerId != null ? Number(hn.paidFromLedgerId) : null,
            otherCharges: Array.isArray(hn.otherCharges)
              ? hn.otherCharges.map((c: any) => ({ ledgerId: Number(c.ledgerId), amount: Number(c.amount) }))
              : [],
            narration: hn.narration ?? null,
            reference: hn.reference ?? null,
            loc, user,
          }, client);
          await client.query(`UPDATE purchases SET import_batch_id = $1 WHERE id = $2`, [id, result.purchaseId]);
          if (result.paymentId) {
            await client.query(`UPDATE payments SET import_batch_id = $1 WHERE id = $2`, [id, result.paymentId]);
          }
          counts.imported += docRows.length;
          if (hn.invoiceNumber) legacyNumbers.push(String(hn.invoiceNumber));
          for (const r of docRows) {
            emit(r, {
              status: "imported", reason: null, createdType: "purchase", createdId: result.purchaseId,
              created: r.id === head.id ? { totalAmount: result.totalAmount, paymentId: result.paymentId } : null,
            });
          }
        }
      } catch (e: any) {
        if (e instanceof ImportAbort) throw e;
        failDoc(docRows, head, label, String(e?.message ?? e).slice(0, 400));
      }
    }
  } else if (module === "receipts" || module === "payments") {
    // One row = one voucher. The ERP allocates its own voucher number; the
    // file's number becomes the searchable legacy reference.
    const loc = { type: opts.loc.type, id: Number(opts.loc.id ?? 0) };
    for (const r of importRows) {
      const norm = (r.raw?.norm ?? {}) as Record<string, any>;
      const label = String(norm.voucherNo || "") || `row ${r.row_number}`;
      if (rowBad(r)) { counts.skipped++; continue; }
      if (demoFailed(r)) { emitSkip(r, "Excluded — this voucher failed in the demo run"); continue; }
      // Routing decisions from the mapping step: non-party names (capital
      // accounts, expense heads…) are either explicitly SKIPPED — surfaced
      // in the skip report, never silently dropped — or posted as a JOURNAL
      // voucher against the ledger the user picked.
      if (norm.route === "skip") {
        emitSkip(r, `Skipped by your mapping decision — "${String(norm.partyName ?? "")}" is not imported`);
        continue;
      }
      if (norm.route === "journal") {
        if (norm.routeLedgerId == null || norm.accountLedgerId == null || !norm.dateIso || !(Number(norm.amount) > 0)) {
          emitSkip(r, "Skipped — the row was never fully validated");
          continue;
        }
        const amt = Math.round(Number(norm.amount) * 100) / 100;
        const jvLocId = opts.loc.type === "headoffice" ? 0 : Number(opts.loc.id ?? 0);
        try {
          await client.query("SAVEPOINT import_doc");
          const narr = [
            `${module === "receipts" ? "Receipt" : "Payment"} imported from the old software — ${String(norm.partyName ?? "")}`,
            norm.narration ? String(norm.narration) : null,
            norm.reference ? `Ref: ${String(norm.reference)}` : null,
          ].filter(Boolean).join(" · ");
          // Receipt: money IN — Dr money account / Cr routed ledger.
          // Payment: money OUT — Dr routed ledger / Cr money account.
          const lines = module === "receipts"
            ? [
                { ledgerId: Number(norm.accountLedgerId), debit: amt, credit: 0 },
                { ledgerId: Number(norm.routeLedgerId), debit: 0, credit: amt },
              ]
            : [
                { ledgerId: Number(norm.routeLedgerId), debit: amt, credit: 0 },
                { ledgerId: Number(norm.accountLedgerId), debit: 0, credit: amt },
              ];
          const created = await createJournalVoucherCore(client, {
            voucherType: "journal",
            voucherNumber: null, // the ERP allocates its own number
            voucherDate: String(norm.dateIso),
            narration: narr,
            partyLedgerId: null,
            reason: null,
            totalAmount: amt,
            createdBy: user,
            locationType: opts.loc.type,
            locationId: jvLocId,
            lines,
          } as any);
          await client.query(
            `UPDATE journal_vouchers SET legacy_voucher_number = $1, import_batch_id = $2 WHERE id = $3`,
            [norm.voucherNo ? String(norm.voucherNo) : null, id, created.id],
          );
          await client.query("RELEASE SAVEPOINT import_doc");
          counts.imported++;
          if (norm.voucherNo) legacyNumbers.push(String(norm.voucherNo));
          emit(r, {
            status: "imported", reason: null, createdType: "journal_voucher", createdId: created.id,
            created: { voucherNumber: created.voucherNumber, routedLedger: norm.routeLedgerName ?? null },
          });
        } catch (e: any) {
          await client.query("ROLLBACK TO SAVEPOINT import_doc").catch(() => {});
          if (e instanceof ImportAbort) throw e;
          failDoc([r], r, label, String(e?.message ?? e).slice(0, 400));
        }
        continue;
      }
      if (norm.partyId == null || norm.accountLedgerId == null || !norm.dateIso || !(Number(norm.amount) > 0)) {
        emitSkip(r, "Skipped — the row was never fully validated");
        continue;
      }
      try {
        const common = {
          legacyVoucherNumber: norm.voucherNo ? String(norm.voucherNo) : null,
          date: String(norm.dateIso),
          amount: Number(norm.amount),
          accountLedgerId: Number(norm.accountLedgerId),
          narration: norm.narration != null ? String(norm.narration) : null,
          reference: norm.reference != null ? String(norm.reference) : null,
          loc: loc as any, user,
        };
        const result = module === "receipts"
          ? await importReceiptVoucher({
              ...common,
              customerId: Number(norm.partyId), customerName: String(norm.partyName ?? ""),
              explicitSaleId: norm.explicitSaleId != null ? Number(norm.explicitSaleId) : null,
            }, client)
          : await importPaymentVoucher({
              ...common,
              vendorId: Number(norm.partyId), vendorName: String(norm.partyName ?? ""),
              explicitPurchaseId: norm.explicitPurchaseId != null ? Number(norm.explicitPurchaseId) : null,
            }, client);
        await client.query(`UPDATE ${module} SET import_batch_id = $1 WHERE id = $2`, [id, result.id]);
        counts.imported++;
        if (norm.voucherNo) legacyNumbers.push(String(norm.voucherNo));
        emit(r, {
          status: "imported", reason: null,
          createdType: module === "receipts" ? "receipt" : "payment", createdId: result.id,
          created: { voucherNumber: result.voucherNumber, allocations: result.allocations, advanceAmount: result.advanceAmount },
        });
      } catch (e: any) {
        if (e instanceof ImportAbort) throw e;
        failDoc([r], r, label, String(e?.message ?? e).slice(0, 400));
      }
    }
  } else if (module === "daybook") {
    // Whole VOUCHERS (journal/contra), grouped at validation. Voucher-family
    // convention: head-office rows carry location id 0 (sales/stock use 1).
    const locId = opts.loc.type === "headoffice" ? 0 : Number(opts.loc.id ?? 0);
    const docsMap = new Map<number, any[]>();
    for (const r of importRows) {
      const dIdx = Number(r.raw?.norm?.doc ?? -1);
      if (!docsMap.has(dIdx)) docsMap.set(dIdx, []);
      docsMap.get(dIdx)!.push(r);
    }
    for (const dIdx of [...docsMap.keys()].sort((a, b) => a - b)) {
      const docRows = docsMap.get(dIdx)!;
      const head = docRows.find((r) => r.raw?.norm?.head) ?? docRows[0];
      const v = (head.raw?.norm?.voucher ?? null) as Record<string, any> | null;
      const label = String(v?.legacyVoucherNo || "") || `rows ${docRows[0].row_number}–${docRows[docRows.length - 1].row_number}`;
      const hasBad = dIdx < 0 || !v || docRows.some(rowBad);
      if (hasBad) {
        for (const r of docRows) {
          if (rowBad(r)) { counts.skipped++; continue; }
          emitSkip(r, "Skipped — another line of this voucher has errors or unmapped ledgers");
        }
        continue;
      }
      if (docRows.some(demoFailed)) {
        for (const r of docRows) emitSkip(r, "Excluded — this voucher failed in the demo run");
        continue;
      }
      try {
        await client.query("SAVEPOINT import_doc");
        const created = await createJournalVoucherCore(client, {
          voucherType: String(v.voucherType ?? "journal") as any,
          voucherNumber: null, // the ERP allocates its own number
          voucherDate: String(v.dateIso),
          narration: v.narration != null ? String(v.narration) : null,
          partyLedgerId: null,
          reason: null,
          totalAmount: Number(v.totalAmount ?? 0),
          createdBy: user,
          locationType: opts.loc.type,
          locationId: locId,
          lines: (v.lines as any[]).map((l) => ({
            ledgerId: Number(l.ledgerId), debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0),
          })),
        } as any);
        await client.query(
          `UPDATE journal_vouchers SET legacy_voucher_number = $1, import_batch_id = $2 WHERE id = $3`,
          [v.legacyVoucherNo ? String(v.legacyVoucherNo) : null, id, created.id],
        );
        await client.query("RELEASE SAVEPOINT import_doc");
        counts.imported += docRows.length;
        if (v.legacyVoucherNo) legacyNumbers.push(String(v.legacyVoucherNo));
        for (const r of docRows) {
          emit(r, {
            status: "imported", reason: null, createdType: "journal_voucher", createdId: created.id,
            created: r.id === head.id ? { voucherNumber: created.voucherNumber } : null,
          });
        }
      } catch (e: any) {
        await client.query("ROLLBACK TO SAVEPOINT import_doc").catch(() => {});
        if (e instanceof ImportAbort) throw e;
        failDoc(docRows, head, label, String(e?.message ?? e).slice(0, 400));
      }
    }
  } else {
    // ── Opening stock: the WHOLE file is one statement ──
    const good: any[] = [];
    for (const r of importRows) {
      if (rowBad(r)) { counts.skipped++; continue; }
      good.push(r);
    }
    if (good.length > 0) {
      if (good.some(demoFailed)) {
        for (const r of good) emitSkip(r, "Excluded — the opening stock failed in the demo run");
      } else {
        const first = (good[0].raw?.norm ?? {}) as Record<string, any>;
        try {
          const result = await importOpeningStockDoc(client, {
            loc: { type: opts.loc.type, id: Number(opts.loc.id ?? 0) } as ProdLocation,
            openingDate: String(first.dateIso),
            notes: `Opening stock imported from old ERP (batch ${batchDisplayId(id)})`,
            user,
            lines: good.map((r) => ({
              itemId: Number(r.raw?.norm?.itemId),
              quantity: Number(r.raw?.norm?.quantity),
              unitCost: r.raw?.norm?.unitCost != null ? Number(r.raw.norm.unitCost) : null,
            })),
          });
          await client.query(`UPDATE stock_verifications SET import_batch_id = $1 WHERE id = $2`, [id, result.verificationId]);
          counts.imported += good.length;
          for (const r of good) {
            emit(r, { status: "imported", reason: null, createdType: "stock_verification", createdId: result.verificationId, created: null });
          }
        } catch (e: any) {
          if (e instanceof ImportAbort) throw e;
          failDoc(good, good[0], "Opening stock", String(e?.message ?? e).slice(0, 400));
        }
      }
    }
  }

  return { outcomes, counts, failures, legacyNumbers };
}

/**
 * The comparison pack, computed ON THE DEMO CLIENT so it sees the uncommitted
 * documents: Trial Balance, P&L, Balance Sheet, cash/bank books, receivables,
 * vendor dues and stock valuation — the same owning modules every live screen
 * reads (never re-derived here), so the demo figures match what the real
 * screens would show after an approve.
 */
async function buildDemoReportPack(client: PoolClient): Promise<Record<string, unknown>> {
  const trialBalance = await computeTrialBalance({ q: client });
  const books = await buildBooks(buildDerivedPostings, { q: client });

  const { rows: roots } = await client.query(
    `SELECT id, code FROM account_ledgers WHERE code IN ('STD-CASH', 'STD-BANK')`,
  );
  const rootId = (code: string) => {
    const r = roots.find((x: any) => String(x.code) === code);
    return r ? Number(r.id) : null;
  };
  const cashRootId = rootId("STD-CASH");
  const bankRootId = rootId("STD-BANK");
  const cashBook = cashRootId != null ? await computeCashBankBook({ q: client, ledgerId: cashRootId }) : null;
  const bankBook = bankRootId != null ? await computeCashBankBook({ q: client, ledgerId: bankRootId }) : null;

  const { rows: recvRows } = await client.query(
    `SELECT c.id, c.name, ROUND(SUM(${outstandingExpr("s")})::numeric, 2)::float8 AS outstanding
       FROM sales s JOIN customers c ON c.id = s.customer_id
      WHERE s.branch_transfer_id IS NULL
      GROUP BY c.id, c.name
     HAVING SUM(${outstandingExpr("s")}) > 0.005
      ORDER BY 3 DESC`,
  );
  const receivables = {
    rows: recvRows.map((r: any) => ({ customerId: Number(r.id), name: String(r.name), outstanding: Number(r.outstanding) })),
    total: round2(recvRows.reduce((s: number, r: any) => s + Number(r.outstanding), 0)),
  };

  // Vendor dues through the owning settlement walk (advances, other charges
  // and FIFO order included) — never a hand-rolled total−paid.
  const settlements = await purchaseSettlementIndex(undefined, client as any);
  const { rows: billRows } = await client.query(
    `SELECT p.id, p.vendor_id, v.name FROM purchases p JOIN vendors v ON v.id = p.vendor_id
      WHERE p.branch_transfer_id IS NULL`,
  );
  const dueByVendor = new Map<number, { vendorId: number; name: string; outstanding: number }>();
  for (const b of billRows) {
    const due = settlements.get(Number(b.id))?.due ?? 0;
    if (!(due > 0.005)) continue;
    const cur = dueByVendor.get(Number(b.vendor_id)) ?? { vendorId: Number(b.vendor_id), name: String(b.name), outstanding: 0 };
    cur.outstanding = round2(cur.outstanding + due);
    dueByVendor.set(Number(b.vendor_id), cur);
  }
  const payables = {
    rows: [...dueByVendor.values()].sort((a, b) => b.outstanding - a.outstanding),
    total: round2([...dueByVendor.values()].reduce((s, v) => s + v.outstanding, 0)),
  };

  const valuation = await stockValuation(client, {});

  return {
    generatedAt: new Date().toISOString(),
    trialBalance,
    profitAndLoss: (books as any).profitAndLoss ?? null,
    balanceSheet: (books as any).balanceSheet ?? null,
    cashBook, bankBook, receivables, payables,
    stockValuation: valuation,
    kpis: {
      totalReceivables: receivables.total,
      totalPayables: payables.total,
      stockValue: Number((valuation as any).onHandValue ?? 0),
    },
  };
}

router.post("/imports/batches/:id/demo", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid batch id" }); return; }

  const lockClient = await pool.connect();
  let locked = false;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [`import_batch_${id}`]);
    locked = true;

    const { rows: [batch] } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
    if (!batch) { res.status(404).json({ error: "Import batch not found" }); return; }
    const module = asModule(batch.module);
    if (!module || !isDemoModule(module)) {
      res.status(400).json({ error: "Master imports (customers, vendors, ledgers, items) commit directly — the demo run is for transaction imports." });
      return;
    }
    if (batch.migration_id != null) {
      res.status(409).json({ error: `This file belongs to migration ${migrationDisplayId(Number(batch.migration_id))} — run the demo from the Migration wizard.` });
      return;
    }
    if (batch.status !== "validated" && batch.status !== "demo_ready") {
      res.status(409).json({ error: `This batch is already ${String(batch.status).replace("_", " ")} — the demo runs before approval.` });
      return;
    }
    const { rows: [nm] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM import_rows WHERE batch_id = $1 AND status IN ('needs_mapping', 'needs_party')`, [id],
    );
    if (Number(nm?.n ?? 0) > 0) {
      res.status(409).json({ error: `Finish the mapping step first — ${nm.n} row${Number(nm.n) === 1 ? " still has" : "s still have"} unmapped names.` });
      return;
    }

    const { rows: importRows } = await pool.query(
      `SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id],
    );
    const loc = { type: String(batch.location_type ?? "headoffice"), id: Number(batch.location_id ?? 0) };
    const user = username(req);

    // ── The never-committed transaction ──
    const client = await pool.connect();
    let run: Awaited<ReturnType<typeof runBatchImport>>;
    let report: Record<string, unknown>;
    try {
      await client.query("BEGIN");
      run = await runBatchImport(client, { batchId: id, module, importRows, loc, user, mode: "demo" });
      report = await buildDemoReportPack(client);
    } finally {
      // EVERYTHING the demo wrote vanishes here — documents, stock, numbers.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    // Snapshot bookkeeping happens OUTSIDE the demo transaction (small,
    // ordinary writes): per-row outcomes into raw.demo, the report pack and
    // summary onto the batch.
    await pool.query(`UPDATE import_rows SET raw = raw - 'demo' WHERE batch_id = $1`, [id]);
    for (const o of run.outcomes) {
      await pool.query(`UPDATE import_rows SET raw = raw || $2::jsonb WHERE id = $1`, [o.rowId, JSON.stringify({
        demo: { status: o.status, reason: o.reason, createdType: o.createdType, created: o.created },
      })]);
    }
    const legacySorted = sortLegacy(run.legacyNumbers);
    const summary = {
      ...run.counts,
      failures: run.failures.slice(0, 100),
      legacyMin: legacySorted[0] ?? null,
      legacyMax: legacySorted[legacySorted.length - 1] ?? null,
      timeTakenMs: Date.now() - startedAt,
    };
    const { rows: [updated] } = await pool.query(
      `UPDATE import_batches SET status = 'demo_ready', demo_report = $2, demo_summary = $3,
          demo_at = NOW(), demo_by = $4, legacy_min = $5, legacy_max = $6
        WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(report), JSON.stringify(summary), user,
       legacySorted[0] ?? null, legacySorted[legacySorted.length - 1] ?? null],
    );

    logActivity({
      action: "UPDATE", module: "imports", entityType: "import_batch", entityId: id,
      description: `Demo run for ${module} import "${batch.filename}" — ${run.counts.imported} would import, ${run.counts.failed} failed, ${run.counts.skipped} skipped (nothing committed)`,
      user,
    }).catch(() => {});

    res.json({ batch: batchJson(updated), summary: run.counts, failures: run.failures });
  } finally {
    if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`import_batch_${id}`]).catch(() => {});
    lockClient.release();
  }
});

router.get("/imports/batches/:id/demo-report", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid batch id" }); return; }
  const { rows: [b] } = await pool.query(
    `SELECT demo_report, demo_summary, demo_at, demo_by, status FROM import_batches WHERE id = $1`, [id],
  );
  if (!b) { res.status(404).json({ error: "Import batch not found" }); return; }
  if (b.demo_report == null) { res.status(404).json({ error: "No demo run on record — run the demo first." }); return; }
  res.json({ report: b.demo_report, summary: b.demo_summary ?? null, demoAt: b.demo_at, demoBy: b.demo_by, status: b.status });
});

router.post("/imports/batches/:id/approve", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid batch id" }); return; }
  const user = username(req);

  const lockClient = await pool.connect();
  let locked = false;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [`import_batch_${id}`]);
    locked = true;

    // Atomic claim — approval only ever follows a demo run. Migration-owned
    // files are approved as ONE unit through the Migration wizard, never here.
    const { rows: [batch] } = await pool.query(
      `UPDATE import_batches SET status = 'committing', committed_at = NOW(), committed_by = $2
        WHERE id = $1 AND status = 'demo_ready' AND migration_id IS NULL RETURNING *`,
      [id, user],
    );
    if (!batch) {
      const { rows: [b] } = await pool.query(`SELECT status, migration_id FROM import_batches WHERE id = $1`, [id]);
      if (!b) { res.status(404).json({ error: "Import batch not found" }); return; }
      if (b.migration_id != null) {
        res.status(409).json({ error: `This file belongs to migration ${migrationDisplayId(Number(b.migration_id))} — approve the whole migration from the Migration wizard.` });
        return;
      }
      res.status(409).json({
        error: b.status === "validated"
          ? "Run the demo first — approval imports exactly what the demo showed."
          : `This batch is ${b.status === "committing" ? "already being imported" : `already ${String(b.status).replace("_", " ")}`} — refresh the history.`,
      });
      return;
    }
    const module = asModule(batch.module) as DemoModule; // demo_ready ⇒ demo module

    const { rows: importRows } = await pool.query(
      `SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id],
    );
    const loc = { type: String(batch.location_type ?? "headoffice"), id: Number(batch.location_id ?? 0) };

    const client = await pool.connect();
    let run: Awaited<ReturnType<typeof runBatchImport>>;
    try {
      await client.query("BEGIN");
      run = await runBatchImport(client, { batchId: id, module, importRows, loc, user, mode: "approve" });
      await client.query("COMMIT");
    } catch (e: any) {
      // All-or-nothing: the ROLLBACK erases every document this approval
      // created — the books are exactly as they were before the click.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await pool.query(
        `UPDATE import_batches SET status = 'demo_ready', committed_at = NULL, committed_by = NULL
          WHERE id = $1 AND status = 'committing'`, [id],
      );
      if (e instanceof ImportAbort) {
        res.status(409).json({
          error: `Import stopped at ${e.docLabel}: ${e.reasonText}. Nothing was imported — fix the cause (or re-run the demo) and approve again.`,
        });
        return;
      }
      throw e;
    }
    client.release();

    // The transaction is committed — now write the row verdicts and finish
    // the batch (ordinary bookkeeping, outside the all-or-nothing boundary).
    for (const o of run.outcomes) {
      await pool.query(
        `UPDATE import_rows SET status = $2, reason = $3, created_record_type = $4, created_record_id = $5 WHERE id = $1`,
        [o.rowId, o.status, o.reason, o.createdType, o.createdId],
      ).catch(() => {});
      if (o.created) {
        await pool.query(`UPDATE import_rows SET raw = raw || $2::jsonb WHERE id = $1`,
          [o.rowId, JSON.stringify({ created: o.created })]).catch(() => {});
      }
    }
    const legacySorted = sortLegacy(run.legacyNumbers);
    const { rows: [finished] } = await pool.query(
      `UPDATE import_batches SET status = 'committed',
          imported_rows = $2, updated_rows = 0, skipped_rows = $3, failed_rows = $4,
          legacy_min = COALESCE($5, legacy_min), legacy_max = COALESCE($6, legacy_max)
        WHERE id = $1 AND status = 'committing' RETURNING *`,
      [id, run.counts.imported, run.counts.skipped, run.counts.failed,
       legacySorted[0] ?? null, legacySorted[legacySorted.length - 1] ?? null],
    );

    // Post-import report from the provenance stamps — provable, never tallied.
    const rc = await batchRecordCounts(pool, id);
    logActivity({
      action: "CREATE", module: "imports", entityType: "import_batch", entityId: id,
      description: `Approved ${module} import "${batch.filename}" — ${run.counts.imported} imported, ${run.counts.skipped} skipped (${describeCounts(rc)})`,
      user,
    }).catch(() => {});

    res.json({
      batch: batchJson(finished ?? batch), summary: run.counts, failures: run.failures,
      details: { recordCounts: rc, timeTakenMs: Date.now() - startedAt },
    });
  } finally {
    if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`import_batch_${id}`]).catch(() => {});
    lockClient.release();
  }
});

router.post("/imports/batches/:id/discard", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid batch id" }); return; }
  const { rows: [b] } = await pool.query(
    `UPDATE import_batches SET status = 'discarded', discarded_at = NOW(), discarded_by = $2
      WHERE id = $1 AND status IN ('validated', 'demo_ready') AND migration_id IS NULL RETURNING *`,
    [id, username(req)],
  );
  if (!b) {
    const { rows: [cur] } = await pool.query(`SELECT status, migration_id FROM import_batches WHERE id = $1`, [id]);
    if (!cur) { res.status(404).json({ error: "Import batch not found" }); return; }
    if (cur.migration_id != null) {
      res.status(409).json({ error: `This file belongs to migration ${migrationDisplayId(Number(cur.migration_id))} — remove or replace it from the Migration wizard.` });
      return;
    }
    res.status(409).json({ error: `This batch is already ${String(cur.status).replace("_", " ")} — only un-imported batches can be discarded.` });
    return;
  }
  logActivity({
    action: "UPDATE", module: "imports", entityType: "import_batch", entityId: id,
    description: `Discarded ${b.module} import "${b.filename}" — nothing was ever written to the books`,
    user: username(req),
  }).catch(() => {});
  res.json({ batch: batchJson(b) });
});

// ── 4. Commit ────────────────────────────────────────────────────────────────

router.post("/imports/batches/:id/commit", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const commitStartedAt = Date.now();
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid batch id" }); return; }
  const body = (req.body ?? {}) as { skipRowIds?: unknown; duplicateAction?: unknown };
  const duplicateAction = body.duplicateAction === "update" ? "update" : "skip";
  const skipSet = new Set<number>(
    Array.isArray(body.skipRowIds) ? body.skipRowIds.map(Number).filter(Number.isInteger) : [],
  );

  // The whole commit runs under the batch's advisory lock, held on a dedicated
  // connection for the duration of the row loop. Rollback takes the same lock
  // with try-lock semantics, so it can never interleave with a live commit —
  // without this, a rollback arriving mid-commit could delete the rows created
  // so far while the loop keeps creating more, leaving untracked records.
  const lockClient = await pool.connect();
  let locked = false;
  try {
  await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [`import_batch_${id}`]);
  locked = true;

  // Direct commit is for MASTER modules only — transaction imports must go
  // through the wizard (demo → compare reports → approve).
  const { rows: [pre] } = await pool.query(`SELECT module FROM import_batches WHERE id = $1`, [id]);
  if (!pre) { res.status(404).json({ error: "Import batch not found" }); return; }
  const preModule = asModule(pre.module);
  if (!preModule || !isMasterModule(preModule)) {
    res.status(400).json({ error: "Transaction imports use the wizard: run the Demo, review the reports, then Approve." });
    return;
  }

  // Atomic claim — two concurrent commits of one batch must collapse to one.
  const { rows: [batch] } = await pool.query(
    `UPDATE import_batches SET status = 'committing', committed_at = NOW(), committed_by = $2
     WHERE id = $1 AND status = 'validated' RETURNING *`,
    [id, username(req)],
  );
  if (!batch) {
    const { rows: [b] } = await pool.query(`SELECT status FROM import_batches WHERE id = $1`, [id]);
    if (!b) { res.status(404).json({ error: "Import batch not found" }); return; }
    res.status(409).json({ error: `This batch is ${b.status === "committing" ? "already being committed" : `already ${String(b.status).replace("_", " ")}`} — refresh the history.` });
    return;
  }

  const module = batch.module as ImportModule;
  const emp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
  // Batch default = the location validated and PERSISTED at upload time, not
  // the committer's session: a different user pressing Commit must not
  // silently re-home every blank-location row onto their own branch.
  const stamp = {
    type: String(batch.location_type ?? emp?.branchType ?? "headoffice"),
    id: Number(batch.location_id ?? emp?.branchId ?? 0),
  };
  const user = username(req);
  const fy = await currentFinancialYear();

  const { rows: importRows } = await pool.query(
    `SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id],
  );

  const counts = { imported: 0, updated: 0, skipped: 0, failed: 0 };
  const failures: Array<{ rowNumber: number; name: string; reason: string }> = [];

  const setRow = (rowId: number, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    return pool.query(`UPDATE import_rows SET ${sets} WHERE id = $1`, [rowId, ...keys.map((k) => fields[k])]);
  };

  {
  for (const r of importRows) {
    const values = (r.raw?.values ?? {}) as Record<string, string>;
    const norm = (r.raw?.norm ?? {}) as Record<string, any>;
    const name = String(norm.name ?? values.name ?? "").trim();

    if (r.status === "error") {
      counts.skipped++; // error rows never commit; verdict text already explains why
      continue;
    }
    if (skipSet.has(Number(r.id))) {
      counts.skipped++;
      await setRow(r.id, { status: "skipped", reason: "Skipped by user at commit" });
      continue;
    }

    try {
      const opening = Number(norm.openingBalance ?? 0);
      const openingType = (norm.openingType ?? "debit") as "debit" | "credit";

      if (module === "customers" || module === "vendors") {
        // Re-check existence AT COMMIT TIME — another batch or a manual create
        // may have landed the same name since validation.
        const { rows: [dupe] } = await pool.query<any>(
          `SELECT id FROM ${module} WHERE lower(name) = lower($1) LIMIT 1`, [name],
        );
        if (dupe) {
          if (duplicateAction === "skip") {
            counts.skipped++;
            await setRow(r.id, { status: "skipped", reason: `"${name}" already exists — duplicates skipped`, duplicate_of_id: dupe.id });
            continue;
          }
          // Update the EXISTING record with the non-blank imported fields.
          const sets: string[] = []; const params: unknown[] = [];
          const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
          if (norm.phone !== undefined) put("phone", norm.phone);
          if (norm.email !== undefined) put("email", norm.email);
          if (norm.address !== undefined) put("address", norm.address);
          if (norm.gstNumber !== undefined) put("gst_number", norm.gstNumber);
          if (norm.state !== undefined) put("state", norm.state);
          if (norm.pan !== undefined) put("pan", norm.pan);
          if (norm.notes !== undefined) put("notes", norm.notes);
          if (module === "customers" && norm.creditLimit !== undefined) put("credit_limit", norm.creditLimit);
          if (sets.length > 0) {
            params.push(dupe.id);
            await pool.query(`UPDATE ${module} SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`, params);
          }
          let obNote = "";
          if (opening > 0) {
            const ledgerId = module === "customers"
              ? await ensureCustomerLedger(dupe.id, name)
              : await ensureVendorLedger(dupe.id, name);
            if (ledgerId) {
              await upsertOpeningBalance({
                ledgerId, balance: opening, balanceType: openingType,
                asOfDate: fy.startDate, financialYear: fy.label,
                notes: `Imported (batch #${id})`, user, ledgerName: name,
              });
              obNote = "; opening balance updated";
            } else obNote = "; opening balance NOT recorded (party ledger missing)";
          }
          counts.updated++;
          // No created ids stamped: rollback removes only records this batch
          // CREATED — updates to pre-existing records are not reversible here.
          await setRow(r.id, { status: "updated", reason: `Updated existing record${obNote}`, duplicate_of_id: dupe.id });
          continue;
        }

        // CREATE — the same code path as POST /customers|/vendors.
        const input: any = {
          name,
          ...(norm.phone !== undefined ? { phone: norm.phone } : {}),
          ...(norm.email !== undefined ? { email: norm.email } : {}),
          ...(norm.address !== undefined ? { address: norm.address } : {}),
          ...(norm.gstNumber !== undefined ? { gstNumber: norm.gstNumber } : {}),
          ...(norm.state !== undefined ? { state: norm.state } : {}),
          ...(norm.pan !== undefined ? { pan: norm.pan } : {}),
          ...(norm.notes !== undefined ? { notes: norm.notes } : {}),
        };
        // A per-row Location column (validated against the uploader's scope at
        // upload time) overrides the batch default for that row only.
        const rowStamp = typeof norm.locationType === "string" && norm.locationType
          ? { type: String(norm.locationType), id: Number(norm.locationId ?? 0) }
          : stamp;
        const { row, ledgerId } = module === "customers"
          ? await createCustomerWithLedger(input, rowStamp)
          : await createVendorWithLedger(input, rowStamp);
        // Batch provenance stamps — only on records this batch CREATED
        // (duplicate updates are deliberately never stamped: rollback must
        // never touch manual data).
        await pool.query(`UPDATE ${module} SET import_batch_id = $1 WHERE id = $2`, [id, row.id]);
        if (ledgerId) {
          await pool.query(
            `UPDATE account_ledgers SET import_batch_id = $1 WHERE id = $2 AND import_batch_id IS NULL`,
            [id, ledgerId],
          );
        }
        if (module === "customers" && norm.creditLimit !== undefined) {
          await pool.query(`UPDATE customers SET credit_limit = $1 WHERE id = $2`, [norm.creditLimit, row.id]);
        }
        let obId: number | null = null;
        let reason: string | null = null;
        if (opening > 0) {
          if (ledgerId) {
            const ob = await upsertOpeningBalance({
              ledgerId, balance: opening, balanceType: openingType,
              asOfDate: fy.startDate, financialYear: fy.label,
              notes: `Imported (batch #${id})`, user, ledgerName: name,
            });
            obId = ob.id;
            await pool.query(
              `UPDATE opening_balances SET import_batch_id = $1 WHERE id = $2 AND import_batch_id IS NULL`,
              [id, obId],
            );
          } else {
            reason = "Created, but the party ledger could not be provisioned — opening balance NOT recorded";
          }
        }
        counts.imported++;
        await setRow(r.id, {
          status: "imported", reason,
          created_record_type: module === "customers" ? "customer" : "vendor",
          created_record_id: row.id, created_ledger_id: ledgerId, opening_balance_id: obId,
        });
        continue;
      }

      if (module === "items") {
        // Re-check for a same-name item AT COMMIT TIME — another batch or a
        // manual create may have landed the same name since validation.
        const { rows: [dupe] } = await pool.query<any>(
          `SELECT id FROM items WHERE lower(name) = lower($1) LIMIT 1`, [name],
        );
        if (dupe) {
          if (duplicateAction === "skip") {
            counts.skipped++;
            await setRow(r.id, { status: "skipped", reason: `"${name}" already exists — duplicates skipped`, duplicate_of_id: dupe.id });
            continue;
          }
          // Update the EXISTING item with the non-blank imported fields
          // (tax_rate/mrp are raw-migration columns → raw SQL only).
          const sets: string[] = []; const params: unknown[] = [];
          const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
          if (norm.unit !== undefined) put("unit", norm.unit);
          if (norm.hsnCode !== undefined) put("hsn_code", norm.hsnCode);
          if (norm.taxRate !== undefined) put("tax_rate", norm.taxRate);
          if (norm.mrp !== undefined) put("mrp", norm.mrp);
          if (norm.cost !== undefined) put("cost", norm.cost);
          if (norm.reorderLevel !== undefined) put("reorder_level", norm.reorderLevel);
          if (norm.description !== undefined) put("description", norm.description);
          if (sets.length > 0) {
            params.push(dupe.id);
            await pool.query(`UPDATE items SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`, params);
          }
          counts.updated++;
          await setRow(r.id, { status: "updated", reason: "Updated existing item", duplicate_of_id: dupe.id });
          continue;
        }
        // CREATE — the same core as POST /items (code/barcode allocated when blank).
        const createdItem = await createItemCore(pool, {
          name, unit: String(norm.unit ?? ""),
          hsnCode: norm.hsnCode ?? null, taxRate: norm.taxRate ?? null,
          mrp: norm.mrp ?? null, cost: norm.cost ?? null,
          reorderLevel: norm.reorderLevel ?? null,
          itemCode: norm.itemCode ?? null, barcode: norm.barcode ?? null,
          description: norm.description ?? null,
        });
        await pool.query(`UPDATE items SET import_batch_id = $1 WHERE id = $2`, [id, createdItem.id]);
        counts.imported++;
        await setRow(r.id, { status: "imported", reason: null, created_record_type: "item", created_record_id: createdItem.id });
        continue;
      }

      // ── Ledgers ──
      const { rows: [dupe] } = await pool.query<any>(
        `SELECT id, code, is_group, is_system_group FROM account_ledgers WHERE lower(name) = lower($1) LIMIT 1`, [name],
      );
      if (dupe) {
        if (dupe.code || dupe.is_group || dupe.is_system_group) {
          counts.skipped++;
          await setRow(r.id, { status: "skipped", reason: `"${name}" already exists as a system account or group — cannot import over it`, duplicate_of_id: dupe.id });
          continue;
        }
        if (duplicateAction === "skip") {
          counts.skipped++;
          await setRow(r.id, { status: "skipped", reason: `"${name}" already exists — duplicates skipped`, duplicate_of_id: dupe.id });
          continue;
        }
        let obNote = "";
        if (opening > 0) {
          await upsertOpeningBalance({
            ledgerId: dupe.id, balance: opening, balanceType: openingType,
            asOfDate: fy.startDate, financialYear: fy.label,
            notes: `Imported (batch #${id})`, user, ledgerName: name,
          });
          obNote = "opening balance updated";
        }
        counts.updated++;
        await setRow(r.id, { status: "updated", reason: `Updated existing ledger${obNote ? ` — ${obNote}` : ""}`, duplicate_of_id: dupe.id });
        continue;
      }

      // Re-resolve the parent AT COMMIT TIME — it may have been renamed or
      // deactivated since validation.
      const candidates = await loadParentCandidates();
      const parent = norm.groupId
        ? candidates.find((c) => c.id === Number(norm.groupId)) ?? resolveGroup(String(values.group ?? ""), candidates)
        : resolveGroup(String(values.group ?? ""), candidates);
      if (!parent) {
        counts.failed++;
        failures.push({ rowNumber: r.row_number, name, reason: `Group "${values.group}" no longer exists` });
        await setRow(r.id, { status: "failed", reason: `Group "${values.group}" no longer exists — re-upload after fixing`, suggestion: groupSuggestion(candidates) });
        continue;
      }
      const descriptionParts: string[] = [];
      if (norm.notes) descriptionParts.push(String(norm.notes));
      if (norm.gstApplicable === true) descriptionParts.push("GST applicable");
      if (norm.gstApplicable === false) descriptionParts.push("GST not applicable");

      // Same code path as POST /accounts/chart — code stays NULL by design.
      const created = await insertChartAccount(pool, {
        name, type: parent.type, parentId: parent.id, section: parent.section,
        description: descriptionParts.length ? descriptionParts.join(" · ") : null,
        isGroup: false, user,
      });
      // Location + batch provenance stamps (raw-migration columns — raw SQL
      // only). Location is required on new batches; rows from batches
      // validated before the column existed fall back to the batch stamp.
      const ledgerLoc = typeof norm.locationType === "string" && norm.locationType
        ? { type: String(norm.locationType), id: Number(norm.locationId ?? 0) }
        : stamp;
      await pool.query(
        `UPDATE account_ledgers SET location_type = $1, location_id = $2, import_batch_id = $3 WHERE id = $4`,
        [ledgerLoc.type, ledgerLoc.id, id, created.id],
      );
      let obId: number | null = null;
      if (opening > 0) {
        const ob = await upsertOpeningBalance({
          ledgerId: created.id, balance: opening, balanceType: openingType,
          asOfDate: fy.startDate, financialYear: fy.label,
          notes: `Imported (batch #${id})`, user, ledgerName: name,
        });
        obId = ob.id;
        await pool.query(
          `UPDATE opening_balances SET import_batch_id = $1 WHERE id = $2 AND import_batch_id IS NULL`,
          [id, obId],
        );
      }
      counts.imported++;
      await setRow(r.id, {
        status: "imported", created_record_type: "ledger",
        created_record_id: created.id, created_ledger_id: created.id, opening_balance_id: obId,
      });
    } catch (e: any) {
      counts.failed++;
      const reason = String(e?.message ?? e).slice(0, 400);
      failures.push({ rowNumber: r.row_number, name, reason });
      await setRow(r.id, { status: "failed", reason }).catch(() => {});
    }
  }
  } // end masters loop

  // Conditional on the state this commit claimed — never overwrite whatever
  // another actor may have written (defence in depth; the advisory lock
  // already makes that impossible).
  const { rows: [finished] } = await pool.query(
    `UPDATE import_batches SET status = 'committed',
        imported_rows = $2, updated_rows = $3, skipped_rows = $4, failed_rows = $5
     WHERE id = $1 AND status = 'committing' RETURNING *`,
    [id, counts.imported, counts.updated, counts.skipped, counts.failed],
  );
  if (!finished) {
    res.status(409).json({ error: "The batch state changed while committing — refresh the history and check its rows." });
    return;
  }

  logActivity({
    action: "CREATE", module: "imports", entityType: "import_batch", entityId: id,
    description: `Committed ${module} import "${batch.filename}" — ${counts.imported} imported, ${counts.updated} updated, ${counts.skipped} skipped, ${counts.failed} failed`,
    user,
  }).catch(() => {});

  // ── Post-commit report: what this batch actually put into the books ──
  // Counts come from the provenance stamps (the same source rollback trusts),
  // never from in-loop tallies — a claim like "3 receipts created" must be
  // provable against the database.
  const rc = await batchRecordCounts(pool, id);
  const { rows: [gstRow] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM import_rows
      WHERE batch_id = $1 AND status = 'imported'
        AND (raw->'norm'->>'head')::boolean IS TRUE
        AND COALESCE((raw->'norm'->>'computedTax')::float8, 0) > 0.004`,
    [id],
  );
  // Parties created during the resolve-missing-parties step are PERMANENT
  // masters (rollback never touches them, exactly like manual creation), so
  // they are deliberately NOT stamped with import_batch_id — the resolve step
  // marks them via the notes trail instead, and the report counts that.
  // Auto-created parties (commit-time toggle) carry their own notes mark —
  // counted the same provable way.
  const resolveMark = `Created during import batch #${id}`;
  const autoMark = `Created automatically during import batch #${id}`;
  const { rows: [resolved] } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM customers WHERE notes IN ($1, $2))::int AS custs,
       (SELECT COUNT(*) FROM vendors   WHERE notes IN ($1, $2))::int AS vends,
       (SELECT COUNT(*) FROM account_ledgers al
         WHERE al.code IN (SELECT 'CUST-' || id FROM customers WHERE notes IN ($1, $2))
            OR al.code IN (SELECT 'VEND-' || id FROM vendors   WHERE notes IN ($1, $2)))::int AS ledgs`,
    [resolveMark, autoMark],
  );
  const details = {
    invoicesImported: rc.sales + rc.purchases,
    invoicesFailed: failures.length,
    customersCreated: rc.customers + Number(resolved?.custs ?? 0),
    vendorsCreated: rc.vendors + Number(resolved?.vends ?? 0),
    ledgersCreated: rc.ledgers + Number(resolved?.ledgs ?? 0),
    stockMovements: 0, // master imports move no stock
    // Books are DERIVED from the documents themselves — imports create no
    // separate journal vouchers. Reported explicitly so the figure is honest.
    journalEntriesCreated: 0,
    receiptsCreated: rc.receipts,
    paymentsCreated: rc.payments,
    gstInvoices: Number(gstRow?.n ?? 0),
    timeTakenMs: Date.now() - commitStartedAt,
  };

  res.json({ batch: batchJson(finished), summary: counts, failures, details });
  } finally {
    if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`import_batch_${id}`]).catch(() => {});
    lockClient.release();
  }
});

// ── 5. Rollback ──────────────────────────────────────────────────────────────

/**
 * Per-table counts of records carrying a batch's provenance stamp.
 * Called BEFORE the deletes (audit breakdown) and AFTER the commit
 * (leftover check — every count must be zero then).
 */
async function batchRecordCounts(
  q: { query: (sql: string, params?: unknown[]) => Promise<any> },
  batchId: number,
): Promise<Record<string, number>> {
  const { rows: [r] } = await q.query(
    `SELECT
       (SELECT COUNT(*) FROM customers        WHERE import_batch_id = $1)::int AS "customers",
       (SELECT COUNT(*) FROM vendors          WHERE import_batch_id = $1)::int AS "vendors",
       (SELECT COUNT(*) FROM account_ledgers  WHERE import_batch_id = $1)::int AS "ledgers",
       (SELECT COUNT(*) FROM opening_balances WHERE import_batch_id = $1)::int AS "openingBalances",
       (SELECT COUNT(*) FROM sales            WHERE import_batch_id = $1)::int AS "sales",
       (SELECT COUNT(*) FROM purchases        WHERE import_batch_id = $1)::int AS "purchases",
       (SELECT COUNT(*) FROM receipts         WHERE import_batch_id = $1)::int AS "receipts",
       (SELECT COUNT(*) FROM payments         WHERE import_batch_id = $1)::int AS "payments",
       (SELECT COUNT(*) FROM items            WHERE import_batch_id = $1)::int AS "items",
       (SELECT COUNT(*) FROM journal_vouchers WHERE import_batch_id = $1)::int AS "journalVouchers",
       (SELECT COUNT(*) FROM stock_verifications WHERE import_batch_id = $1)::int AS "stockVerifications"`,
    [batchId],
  );
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r ?? {})) out[k] = Number(v);
  return out;
}

const COUNT_LABELS: Array<[string, string]> = [
  ["customers", "customers"], ["vendors", "vendors"], ["ledgers", "ledgers"],
  ["items", "items"],
  ["openingBalances", "opening balances"], ["sales", "sales invoices"],
  ["purchases", "purchase bills"], ["receipts", "receipts"], ["payments", "payments"],
  ["journalVouchers", "journal vouchers"], ["stockVerifications", "opening stock uploads"],
];

function describeCounts(counts: Record<string, number>): string {
  const parts = COUNT_LABELS.filter(([k]) => (counts[k] ?? 0) > 0).map(([k, l]) => `${counts[k]} ${l}`);
  return parts.length ? parts.join(", ") : "no stamped records";
}

/** Invoice numbers of the sales THIS batch created — captured inside the
 * delete transaction (before the deletes) so verification can check the
 * exact documents this rollback touched, immune to unrelated concurrent
 * activity elsewhere in the books. */
async function batchSaleInvoiceNumbers(
  q: { query: (sql: string, params?: unknown[]) => Promise<any> },
  batchId: number,
): Promise<string[]> {
  const { rows } = await q.query(
    `SELECT invoice_number FROM sales WHERE import_batch_id = $1`, [batchId],
  );
  return rows.map((r: any) => String(r.invoice_number)).filter(Boolean);
}

/**
 * Post-rollback verification (runs AFTER the delete transaction commits —
 * the books derive postings through the pool, so an in-transaction check
 * would not see the uncommitted deletes).
 *   1. leftoverStamps — nothing anywhere still carries this batch's stamp;
 *   2. booksBalanced  — every derived posting still nets Dr == Cr;
 *   3. orphanSaleReceipts — no sale-trail receipt belonging to one of THIS
 *      batch's (now deleted) invoices survived the rollback. The check is
 *      exact (by voucher number), so unrelated concurrent writes can neither
 *      trip it nor mask a real leftover.
 */
async function verifyAfterRollback(batchId: number, batchInvoiceNumbers: string[]): Promise<{
  ok: boolean; leftoverStamps: number; booksBalanced: boolean; orphanSaleReceipts: number;
}> {
  const leftover = await batchRecordCounts(pool, batchId);
  const leftoverStamps = Object.values(leftover).reduce((a, b) => a + b, 0);
  const postings = await buildDerivedPostings({});
  const debit = postings.reduce((s: number, p: any) => s + Number(p.debit ?? 0), 0);
  const credit = postings.reduce((s: number, p: any) => s + Number(p.credit ?? 0), 0);
  const booksBalanced = Math.abs(debit - credit) < 0.01;
  let orphanSaleReceipts = 0;
  if (batchInvoiceNumbers.length > 0) {
    const { rows: [orph] } = await pool.query<any>(
      `SELECT COUNT(*)::int AS n FROM receipts WHERE voucher_number = ANY($1)`,
      [batchInvoiceNumbers],
    );
    orphanSaleReceipts = Number(orph?.n ?? 0);
  }
  return {
    ok: leftoverStamps === 0 && booksBalanced && orphanSaleReceipts === 0,
    leftoverStamps, booksBalanced, orphanSaleReceipts,
  };
}

router.post("/imports/batches/:id/rollback", requireModuleAction(PERM, "delete"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid batch id" }); return; }
  const user = username(req);

  // Deleting an import batch is restricted to top-management roles (level 1 =
  // Administrator, level 2 = Management) ON TOP of the page delete right —
  // branch staff must never be able to erase migrated history even if a
  // permissive page permission slips through. Fails closed on missing role.
  const hierarchyId = (req as any).employee?.hierarchyId ?? null;
  const { rows: [lvl] } = await pool.query<any>(`SELECT level FROM hierarchies WHERE id = $1`, [hierarchyId]);
  const roleLevel = lvl?.level == null ? null : Number(lvl.level);
  if (roleLevel == null || roleLevel > 2) {
    res.status(403).json({ error: "Only Admin or Management can delete an import batch." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Try-lock, not wait: the commit endpoint holds this lock for its whole
    // row loop, so "busy" means a commit is running right now — surface that
    // instead of blocking the request until it finishes.
    const { rows: [lock] } = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`, [`import_batch_${id}`],
    );
    if (!lock?.got) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This batch is being committed right now — wait for the commit to finish, then try again." });
      return;
    }
    const { rows: [batch] } = await client.query(`SELECT * FROM import_batches WHERE id = $1 FOR UPDATE`, [id]);
    if (!batch) { await client.query("ROLLBACK"); res.status(404).json({ error: "Import batch not found" }); return; }
    if (batch.migration_id != null) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: `This file belongs to migration ${migrationDisplayId(Number(batch.migration_id))} — a migration only rolls back as a WHOLE, from the Migration wizard.` });
      return;
    }
    if (batch.rolled_back_at || batch.status === "rolled_back") {
      await client.query("ROLLBACK"); res.status(409).json({ error: "This batch was already rolled back." }); return;
    }
    // Only FULLY committed batches roll back. 'committing' is refused even
    // when the lock was free (e.g. the committing server died mid-loop) —
    // a half-committed batch needs eyes, not an automatic delete.
    if (batch.status !== "committed") {
      await client.query("ROLLBACK"); res.status(409).json({ error: "Only committed batches can be rolled back." }); return;
    }

    // What this batch stamped — captured BEFORE the deletes so the audit
    // entry can list how many records of each kind were removed, and so
    // verification can check the exact invoices this rollback deletes.
    const countsSnapshot = await batchRecordCounts(client, id);
    const batchInvoices = await batchSaleInvoiceNumbers(client, id);

    // ── Transaction batches: reverse whole documents, all-or-nothing ──
    // Runs INSIDE this transaction: if any document is blocked by downstream
    // activity, everything reversed so far is rolled back with it.
    if (batch.module === "sales" || batch.module === "purchases") {
      const { rows: docRowsAll } = await client.query(
        `SELECT * FROM import_rows
          WHERE batch_id = $1 AND status = 'imported' AND created_record_id IS NOT NULL
          ORDER BY row_number`,
        [id],
      );
      if (docRowsAll.length === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "This batch created no documents, so there is nothing to roll back." });
        return;
      }

      const blocked: Array<{ rowNumber: number; name: string; reason: string }> = [];
      const seenDocs = new Set<number>();
      let removed = 0;
      for (const r of docRowsAll) {
        const recId = Number(r.created_record_id);
        if (seenDocs.has(recId)) continue;
        seenDocs.add(recId);
        // The head row carries the settlement ids this import created.
        const headRow = docRowsAll.find((x: any) => Number(x.created_record_id) === recId && x.raw?.created) ?? r;
        const createdInfo = (headRow.raw?.created ?? {}) as Record<string, any>;
        const label = String(createdInfo.invoiceNumber ?? headRow.raw?.norm?.invoiceNumber ?? "") || `row ${r.row_number}`;
        const reason = batch.module === "sales"
          ? await rollbackImportedSale(client as any, recId, {
              salePaymentIds: createdInfo.salePaymentIds, clearingReceiptIds: createdInfo.clearingReceiptIds,
            })
          : await rollbackImportedPurchase(client as any, recId, { paymentId: createdInfo.paymentId ?? null });
        if (reason) blocked.push({ rowNumber: Number(r.row_number), name: label, reason });
        else removed++;
      }

      if (blocked.length > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({
          error: `Cannot roll back: ${blocked.length} imported document${blocked.length === 1 ? " has" : "s have"} since gained payments, returns or other activity. Remove that activity first, or leave the batch in place.`,
          blocked,
        });
        return;
      }

      await client.query(`UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = $1 AND status = 'imported'`, [id]);
      const { rows: [finishedTxn] } = await client.query(
        `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2 WHERE id = $1 RETURNING *`,
        [id, user],
      );
      await client.query("COMMIT");

      const verification = await verifyAfterRollback(id, batchInvoices);
      logActivity({
        action: "DELETE", module: "imports", entityType: "import_batch", entityId: id,
        description: `Deleted import batch ${batchDisplayId(id)} (${batch.module} import "${batch.filename}") — removed ${describeCounts(countsSnapshot)}; stock, settlements and books restored; verification ${verification.ok ? "passed" : "FAILED"} (books ${verification.booksBalanced ? "balanced" : "NOT balanced"}, ${verification.leftoverStamps} leftover records)`,
        user,
        metadata: { displayId: batchDisplayId(id), removedCounts: countsSnapshot, verification },
      }).catch(() => {});

      res.json({ batch: batchJson(finishedTxn), removed, removedCounts: countsSnapshot, verification });
      return;
    }

    // ── Voucher batches: unwind each voucher, all-or-nothing ──
    // Mirrors the manual DELETE of an allocation voucher: settlement legs
    // removed (invoice dues restored), advances withdrawn — refusing per
    // voucher when its advance has since been adjusted against documents.
    if (batch.module === "receipts" || batch.module === "payments") {
      const { rows: vRows } = await client.query(
        `SELECT * FROM import_rows
          WHERE batch_id = $1 AND status = 'imported' AND created_record_id IS NOT NULL
          ORDER BY row_number`,
        [id],
      );
      if (vRows.length === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "This batch created no vouchers, so there is nothing to roll back." });
        return;
      }

      const blocked: Array<{ rowNumber: number; name: string; reason: string }> = [];
      let removed = 0;
      for (const r of vRows) {
        const recId = Number(r.created_record_id);
        const label = String(r.raw?.created?.voucherNumber ?? r.raw?.norm?.voucherNo ?? "") || `row ${r.row_number}`;
        // Rows ROUTED to a ledger were imported as journal vouchers (non-party
        // names) — plain removal, exactly like a day-book rollback.
        if (String(r.created_record_type) === "journal_voucher") {
          await client.query(`DELETE FROM journal_voucher_lines WHERE voucher_id = $1`, [recId]);
          await client.query(`DELETE FROM journal_vouchers WHERE id = $1`, [recId]);
          removed++;
          continue;
        }
        const reason = batch.module === "receipts"
          ? await rollbackImportedReceiptVoucher(client as any, recId)
          : await rollbackImportedPaymentVoucher(client as any, recId);
        if (reason) blocked.push({ rowNumber: Number(r.row_number), name: label, reason });
        else removed++;
      }

      if (blocked.length > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({
          error: `Cannot roll back: ${blocked.length} imported voucher${blocked.length === 1 ? " has" : "s have"} since been built upon. Remove that activity first, or leave the batch in place.`,
          blocked,
        });
        return;
      }

      await client.query(`UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = $1 AND status = 'imported'`, [id]);
      const { rows: [finishedV] } = await client.query(
        `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2 WHERE id = $1 RETURNING *`,
        [id, user],
      );
      await client.query("COMMIT");

      const verification = await verifyAfterRollback(id, batchInvoices);
      logActivity({
        action: "DELETE", module: "imports", entityType: "import_batch", entityId: id,
        description: `Deleted import batch ${batchDisplayId(id)} (${batch.module} import "${batch.filename}") — removed ${describeCounts(countsSnapshot)}; allocations unwound, dues and advances restored; verification ${verification.ok ? "passed" : "FAILED"} (books ${verification.booksBalanced ? "balanced" : "NOT balanced"}, ${verification.leftoverStamps} leftover records)`,
        user,
        metadata: { displayId: batchDisplayId(id), removedCounts: countsSnapshot, verification },
      }).catch(() => {});

      res.json({ batch: batchJson(finishedV), removed, removedCounts: countsSnapshot, verification });
      return;
    }

    // ── Day Book batches: delete the imported journal vouchers ──
    // Journal/contra vouchers have no downstream dependents (they are
    // deletable in the voucher screens too), so this is a plain removal.
    if (batch.module === "daybook") {
      const { rows: jvRows } = await client.query(
        `SELECT DISTINCT created_record_id AS jv_id FROM import_rows
          WHERE batch_id = $1 AND status = 'imported'
            AND created_record_type = 'journal_voucher' AND created_record_id IS NOT NULL`,
        [id],
      );
      const jvIds = jvRows.map((r: any) => Number(r.jv_id));
      if (jvIds.length === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "This batch created no vouchers, so there is nothing to roll back." });
        return;
      }
      await client.query(`DELETE FROM journal_voucher_lines WHERE voucher_id = ANY($1::int[])`, [jvIds]);
      await client.query(`DELETE FROM journal_vouchers WHERE id = ANY($1::int[])`, [jvIds]);
      await client.query(`UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = $1 AND status = 'imported'`, [id]);
      const { rows: [finishedJv] } = await client.query(
        `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2 WHERE id = $1 RETURNING *`,
        [id, user],
      );
      await client.query("COMMIT");

      const verification = await verifyAfterRollback(id, batchInvoices);
      logActivity({
        action: "DELETE", module: "imports", entityType: "import_batch", entityId: id,
        description: `Deleted import batch ${batchDisplayId(id)} (daybook import "${batch.filename}") — removed ${describeCounts(countsSnapshot)}; verification ${verification.ok ? "passed" : "FAILED"} (books ${verification.booksBalanced ? "balanced" : "NOT balanced"}, ${verification.leftoverStamps} leftover records)`,
        user,
        metadata: { displayId: batchDisplayId(id), removedCounts: countsSnapshot, verification },
      }).catch(() => {});

      res.json({ batch: batchJson(finishedJv), removed: jvIds.length, removedCounts: countsSnapshot, verification });
      return;
    }

    // ── Opening stock batches: unwind the OPN lots and quantities ──
    // Refused when the opening lots have since been consumed (sold/produced/
    // transferred) — removing them then would corrupt costs and FEFO order.
    if (batch.module === "opening_stock") {
      const { rows: verifRows } = await client.query(
        `SELECT DISTINCT created_record_id AS vid FROM import_rows
          WHERE batch_id = $1 AND status = 'imported'
            AND created_record_type = 'stock_verification' AND created_record_id IS NOT NULL`,
        [id],
      );
      if (verifRows.length === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "This batch recorded no opening stock, so there is nothing to roll back." });
        return;
      }
      const blocked: Array<{ rowNumber: number; name: string; reason: string }> = [];
      let removed = 0;
      for (const v of verifRows) {
        const reason = await rollbackImportedOpeningStock(client as any, Number(v.vid));
        if (reason) blocked.push({ rowNumber: 0, name: `Opening stock upload #${v.vid}`, reason });
        else removed++;
      }
      if (blocked.length > 0) {
        await client.query("ROLLBACK");
        res.status(409).json({
          error: "Cannot roll back: the imported opening stock has since been sold, moved or consumed. Remove that activity first, or leave the batch in place.",
          blocked,
        });
        return;
      }
      await client.query(`UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = $1 AND status = 'imported'`, [id]);
      const { rows: [finishedOs] } = await client.query(
        `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2 WHERE id = $1 RETURNING *`,
        [id, user],
      );
      await client.query("COMMIT");

      const verification = await verifyAfterRollback(id, batchInvoices);
      logActivity({
        action: "DELETE", module: "imports", entityType: "import_batch", entityId: id,
        description: `Deleted import batch ${batchDisplayId(id)} (opening stock import "${batch.filename}") — removed ${describeCounts(countsSnapshot)}; stock restored; verification ${verification.ok ? "passed" : "FAILED"} (books ${verification.booksBalanced ? "balanced" : "NOT balanced"}, ${verification.leftoverStamps} leftover records)`,
        user,
        metadata: { displayId: batchDisplayId(id), removedCounts: countsSnapshot, verification },
      }).catch(() => {});

      res.json({ batch: batchJson(finishedOs), removed, removedCounts: countsSnapshot, verification });
      return;
    }

    const { rows: created } = await client.query(
      `SELECT * FROM import_rows
        WHERE batch_id = $1 AND status = 'imported'
          AND (created_record_id IS NOT NULL OR created_ledger_id IS NOT NULL OR opening_balance_id IS NOT NULL)
        ORDER BY row_number`,
      [id],
    );
    if (created.length === 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This batch created no records (only updates/skips), so there is nothing to roll back." });
      return;
    }

    const obIds = created.map((r: any) => r.opening_balance_id).filter((v: any) => v != null).map(Number);
    const ledgerIds = created.map((r: any) => r.created_ledger_id).filter((v: any) => v != null).map(Number);
    const customerIds = created.filter((r: any) => r.created_record_type === "customer").map((r: any) => Number(r.created_record_id));
    const vendorIds = created.filter((r: any) => r.created_record_type === "vendor").map((r: any) => Number(r.created_record_id));
    const itemIds = created.filter((r: any) => r.created_record_type === "item").map((r: any) => Number(r.created_record_id));

    // 1. Opening balances go first — inside this txn, so if anything below
    //    blocks, the deletes are undone with the ROLLBACK.
    if (obIds.length > 0) await client.query(`DELETE FROM opening_balances WHERE id = ANY($1::int[])`, [obIds]);

    // 2. Eligibility from ACTUAL state. loadLedgerUsage runs on this client so
    //    it no longer sees the opening balances we just removed — anything left
    //    is genuine downstream usage.
    const blocked: Array<{ rowNumber: number; name: string; reason: string }> = [];
    const usage = await loadLedgerUsage(client as any);

    const childCounts = new Map<number, number>();
    if (ledgerIds.length > 0) {
      const { rows } = await client.query(
        `SELECT parent_id, COUNT(*)::int AS n FROM account_ledgers WHERE parent_id = ANY($1::int[]) GROUP BY parent_id`,
        [ledgerIds],
      );
      for (const r of rows) childCounts.set(Number(r.parent_id), Number(r.n));
    }

    // Party document usage — sources checked against information_schema so a
    // missing table can never crash the rollback.
    const partyUsage = async (table: string, col: string, ids: number[]) => {
      if (ids.length === 0) return new Map<number, number>();
      const { rows: [t] } = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, col],
      );
      if (!t) return new Map<number, number>();
      const { rows } = await client.query(
        `SELECT ${col} AS pid, COUNT(*)::int AS n FROM ${table} WHERE ${col} = ANY($1::int[]) GROUP BY ${col}`,
        [ids],
      );
      return new Map<number, number>(rows.map((r: any) => [Number(r.pid), Number(r.n)]));
    };
    // Item usage — any stock movement or price row means the item is live.
    const itemUsage = new Map<number, string[]>();
    if (itemIds.length > 0) {
      const addUse = (rows: any[], msg: (n: number) => string) => {
        for (const u of rows) {
          const iid = Number(u.iid);
          itemUsage.set(iid, [...(itemUsage.get(iid) ?? []), msg(Number(u.n))]);
        }
      };
      const { rows: se } = await client.query(
        `SELECT item_id AS iid, COUNT(*)::int AS n FROM stock_entries
          WHERE material_type = 'item' AND item_id = ANY($1::int[]) GROUP BY item_id`, [itemIds]);
      addUse(se, (n) => `${n} stock record${n === 1 ? "" : "s"} exist for this item`);
      const { rows: sl } = await client.query(
        `SELECT ref_id AS iid, COUNT(*)::int AS n FROM stock_ledger
          WHERE material_type = 'item' AND ref_id = ANY($1::int[]) GROUP BY ref_id`, [itemIds]);
      addUse(sl, (n) => `${n} stock ledger entr${n === 1 ? "y" : "ies"} reference this item`);
      const { rows: ip } = await client.query(
        `SELECT item_id AS iid, COUNT(*)::int AS n FROM item_prices
          WHERE item_id = ANY($1::int[]) GROUP BY item_id`, [itemIds]);
      addUse(ip, (n) => `${n} price entr${n === 1 ? "y" : "ies"} reference this item`);
    }

    const custSales = await partyUsage("sales", "customer_id", customerIds);
    const custQuotes = await partyUsage("quotations", "customer_id", customerIds);
    const vendPurchases = await partyUsage("purchases", "vendor_id", vendorIds);
    const vendAssets = await partyUsage("asset_purchases", "vendor_id", vendorIds);

    for (const r of created) {
      const name = String(r.raw?.norm?.name ?? r.raw?.values?.name ?? `row ${r.row_number}`);
      const reasons: string[] = [];
      const lid = r.created_ledger_id == null ? null : Number(r.created_ledger_id);
      if (lid != null) {
        const u = usage.get(lid);
        if (u && u.transactions > 0) reasons.push(`its ledger carries ${u.transactions} entr${u.transactions === 1 ? "y" : "ies"} (${u.transactionSources.join(", ")})`);
        if (u && u.references.length > 0) reasons.push(`its ledger is wired to ${u.references.join(", ")}`);
        const kids = childCounts.get(lid) ?? 0;
        if (kids > 0) reasons.push(`its ledger now has ${kids} sub-account${kids === 1 ? "" : "s"}`);
      }
      if (r.created_record_type === "customer") {
        const rid = Number(r.created_record_id);
        const s = custSales.get(rid) ?? 0; const q = custQuotes.get(rid) ?? 0;
        if (s > 0) reasons.push(`${s} sale${s === 1 ? "" : "s"} reference this customer`);
        if (q > 0) reasons.push(`${q} quotation${q === 1 ? "" : "s"} reference this customer`);
      }
      if (r.created_record_type === "vendor") {
        const rid = Number(r.created_record_id);
        const p = vendPurchases.get(rid) ?? 0; const a = vendAssets.get(rid) ?? 0;
        if (p > 0) reasons.push(`${p} purchase${p === 1 ? "" : "s"} reference this vendor`);
        if (a > 0) reasons.push(`${a} asset purchase${a === 1 ? "" : "s"} reference this vendor`);
      }
      if (r.created_record_type === "item") {
        for (const msg of itemUsage.get(Number(r.created_record_id)) ?? []) reasons.push(msg);
      }
      if (reasons.length > 0) blocked.push({ rowNumber: Number(r.row_number), name, reason: reasons.join("; ") });
    }

    if (blocked.length > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Cannot roll back: ${blocked.length} imported record${blocked.length === 1 ? " has" : "s have"} since been used. Remove that activity first, or leave the batch in place.`,
        blocked,
      });
      return;
    }

    // 3. Dependency order: opening balances (done) → ledgers → parties.
    if (ledgerIds.length > 0) await client.query(`DELETE FROM account_ledgers WHERE id = ANY($1::int[])`, [ledgerIds]);
    if (customerIds.length > 0) await client.query(`DELETE FROM customers WHERE id = ANY($1::int[])`, [customerIds]);
    if (vendorIds.length > 0) await client.query(`DELETE FROM vendors WHERE id = ANY($1::int[])`, [vendorIds]);
    if (itemIds.length > 0) await client.query(`DELETE FROM items WHERE id = ANY($1::int[])`, [itemIds]);

    await client.query(
      `UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = $1 AND status = 'imported'`, [id],
    );
    const { rows: [finished] } = await client.query(
      `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2 WHERE id = $1 RETURNING *`,
      [id, user],
    );
    await client.query("COMMIT");

    const verification = await verifyAfterRollback(id, batchInvoices);
    logActivity({
      action: "DELETE", module: "imports", entityType: "import_batch", entityId: id,
      description: `Deleted import batch ${batchDisplayId(id)} (${batch.module} import "${batch.filename}") — removed ${describeCounts(countsSnapshot)}; verification ${verification.ok ? "passed" : "FAILED"} (books ${verification.booksBalanced ? "balanced" : "NOT balanced"}, ${verification.leftoverStamps} leftover records)`,
      user,
      metadata: { displayId: batchDisplayId(id), removedCounts: countsSnapshot, verification },
    }).catch(() => {});

    res.json({ batch: batchJson(finished), removed: created.length, removedCounts: countsSnapshot, verification });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

// ═══ 5. ERP Migration Wizard — ONE migration, many files ════════════════════
// A migration is the umbrella over up to one file per wizard module. The
// whole set analyses together, maps together, demos together (one combined
// never-committed transaction → one report pack), and is approved as ONE
// all-or-nothing import at a location chosen only AFTER verification.
// Rollback removes the ENTIRE migration — never a partial one.

const WIZARD_MODULES: DemoModule[] = ["sales", "purchases", "receipts", "payments", "daybook", "opening_stock"];
/** Import order inside the one transaction: stock exists before the documents
 *  that consume it, documents exist before the money that settles them. */
const WIZARD_RUN_ORDER: DemoModule[] = ["opening_stock", "purchases", "sales", "receipts", "payments", "daybook"];
/** Files are validated and demoed at Head Office until the real location is
 *  chosen AFTER verification (the wizard picks the location LAST). Approve
 *  re-stamps every file and re-validates at the chosen location before the
 *  final import. */
const PROVISIONAL_STAMP = { type: "headoffice", id: 1 };

function migrationDisplayId(id: number): string {
  return `MIG${String(id).padStart(4, "0")}`;
}

function migrationJson(m: any) {
  const status = String(m.status);
  return {
    id: Number(m.id),
    displayId: migrationDisplayId(Number(m.id)),
    status,
    locationType: m.location_type ?? null,
    locationId: m.location_id == null ? null : Number(m.location_id),
    createdBy: m.created_by,
    createdAt: m.created_at,
    demoAt: m.demo_at ?? null,
    demoBy: m.demo_by ?? null,
    demoSummary: m.demo_summary ?? null,
    hasDemoReport: m.has_demo_report != null ? Boolean(m.has_demo_report) : m.demo_report != null,
    recordCounts: m.record_counts ?? null,
    legacyRange: m.legacy_min || m.legacy_max ? { min: m.legacy_min ?? null, max: m.legacy_max ?? null } : null,
    committedAt: m.committed_at ?? null,
    committedBy: m.committed_by ?? null,
    discardedAt: m.discarded_at ?? null,
    discardedBy: m.discarded_by ?? null,
    rolledBackAt: m.rolled_back_at ?? null,
    rolledBackBy: m.rolled_back_by ?? null,
    canEdit: status === "draft" || status === "demo_ready",
    canDemo: status === "draft" || status === "demo_ready",
    canApprove: status === "demo_ready" && Number((m.demo_summary as any)?.failed ?? 0) === 0,
    canDiscard: status === "draft" || status === "demo_ready",
    rollbackAvailable: status === "committed" && !m.rolled_back_at,
  };
}

/** Which master kinds a module's name columns feed (for the analyse tiles). */
const MODULE_NAME_COLUMNS: Partial<Record<DemoModule, Array<{ column: string; kind: MappingKind }>>> = {
  sales: [{ column: "party", kind: "customer" }, { column: "item", kind: "product" }],
  purchases: [{ column: "party", kind: "vendor" }, { column: "item", kind: "product" }],
  receipts: [{ column: "party", kind: "customer" }],
  payments: [{ column: "party", kind: "vendor" }],
  daybook: [{ column: "ledger", kind: "ledger" }],
  opening_stock: [{ column: "item", kind: "product" }],
};

/** Display-only issue buckets for the combined analyse step. */
function issueBucket(reason: string | null): "duplicates" | "invalidGst" | "invalidDates" | "invalidAmounts" | "other" {
  const r = String(reason ?? "").toLowerCase();
  if (r.includes("duplicate") || r.includes("already imported") || r.includes("already exists")) return "duplicates";
  if (r.includes("gst")) return "invalidGst";
  if (r.includes("date")) return "invalidDates";
  if (r.includes("amount") || r.includes("price") || r.includes("total") || r.includes("qty") || r.includes("quantity") || r.includes("debit") || r.includes("credit") || r.includes("cost")) return "invalidAmounts";
  return "other";
}

/** Full detail for one migration: file cards + combined analysis. */
async function migrationDetail(id: number): Promise<Record<string, unknown> | null> {
  const { rows: [m] } = await pool.query(
    `SELECT *, (demo_report IS NOT NULL) AS has_demo_report FROM import_migrations WHERE id = $1`, [id],
  );
  if (!m) return null;
  const { rows: batches } = await pool.query(`SELECT * FROM import_batches WHERE migration_id = $1`, [id]);
  const byModule = new Map<string, any>(batches.map((b: any) => [String(b.module), b]));

  const issues = { duplicates: 0, invalidGst: 0, invalidDates: 0, invalidAmounts: 0, other: 0 };
  const seen: Record<MappingKind, Set<string>> = { customer: new Set(), vendor: new Set(), product: new Set(), ledger: new Set() };
  const missing: Record<MappingKind, Set<string>> = { customer: new Set(), vendor: new Set(), product: new Set(), ledger: new Set() };

  const files: any[] = [];
  for (const module of WIZARD_MODULES) {
    const b = byModule.get(module);
    if (!b) continue;
    const { rows: rws } = await pool.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [b.id]);
    let needsMapping = 0;
    let moneyTotal = 0;
    const docSet = new Set<number>();
    for (const r of rws) {
      const norm = (r.raw?.norm ?? {}) as Record<string, any>;
      if (r.status === "needs_mapping" || r.status === "needs_party") needsMapping++;
      else if (r.status === "error") issues[issueBucket(r.reason)]++;
      for (const nc of MODULE_NAME_COLUMNS[module] ?? []) {
        const v = String((r.raw?.values ?? {})[nc.column] ?? "").trim();
        if (v) seen[nc.kind].add(normName(v));
      }
      for (const mm of (norm.missingMappings ?? []) as Array<{ kind: MappingKind; name: string }>) {
        missing[mm.kind]?.add(normName(String(mm.name)));
      }
      // Rows the user chose to SKIP never reach the books — counting their
      // money would overstate what the migration will actually post.
      if (module === "receipts" || module === "payments") { if (norm.route !== "skip") moneyTotal += Number(norm.amount ?? 0); }
      else if (module === "daybook") moneyTotal += Number(norm.debit ?? 0);
      else if (module === "opening_stock") moneyTotal += Number(norm.quantity ?? 0) * Number(norm.unitCost ?? 0);
      if (norm.doc != null) docSet.add(Number(norm.doc));
    }
    let docCount = rws.length;
    let summary: Record<string, unknown> | undefined;
    if (module === "sales" || module === "purchases") {
      summary = txnBatchSummary(rws) as Record<string, unknown>;
      docCount = Number((summary as any).invoices ?? docSet.size);
      moneyTotal = Number((summary as any).totalAmount ?? 0);
    } else if (module === "daybook") {
      docCount = docSet.size;
    }
    files.push({
      ...batchJson(b),
      needsMappingRows: needsMapping,
      hardErrorRows: Math.max(0, Number(b.error_rows ?? 0) - needsMapping),
      docCount,
      moneyTotal: round2(moneyTotal),
      ...(summary ? { summary } : {}),
    });
  }

  const masters: Record<string, { found: number; missing: number }> = {};
  for (const kind of ["customer", "vendor", "product", "ledger"] as MappingKind[]) {
    if (seen[kind].size === 0 && missing[kind].size === 0) continue;
    masters[kind] = {
      found: Math.max(0, seen[kind].size - missing[kind].size),
      missing: missing[kind].size,
    };
  }
  const unmappedTotal = (Object.values(missing) as Array<Set<string>>).reduce((s, x) => s + x.size, 0);
  const nameOf = await locationNameResolver();
  return {
    migration: { ...migrationJson(m), locationName: nameOf(m) },
    files,
    analysis: { issues, masters },
    unmappedTotal,
  };
}

/** Any change to a migration's inputs invalidates its pending demo. */
async function demoteMigration(id: number): Promise<void> {
  await pool.query(
    `UPDATE import_migrations SET status = 'draft', demo_report = NULL, demo_summary = NULL, demo_at = NULL, demo_by = NULL
      WHERE id = $1 AND status IN ('draft', 'demo_ready')`,
    [id],
  );
}

router.post("/imports/migrations", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const user = username(req);
  const { rows: [m] } = await pool.query(
    `INSERT INTO import_migrations (status, created_by) VALUES ('draft', $1) RETURNING *`, [user],
  );
  logActivity({
    action: "CREATE", module: "imports", entityType: "import_migration", entityId: Number(m.id),
    description: `Started migration ${migrationDisplayId(Number(m.id))}`,
    user,
  }).catch(() => {});
  res.status(201).json({ migration: migrationJson(m) });
});

router.get("/imports/migrations", requireModuleView(PERM), async (_req: Request, res: Response): Promise<void> => {
  const [{ rows: migs }, { rows: batches }, nameOf] = await Promise.all([
    pool.query(`SELECT *, (demo_report IS NOT NULL) AS has_demo_report FROM import_migrations ORDER BY id DESC LIMIT 100`),
    pool.query(
      `SELECT id, migration_id, module, filename, status, total_rows, valid_rows, warning_rows, error_rows,
              imported_rows, skipped_rows, failed_rows
         FROM import_batches WHERE migration_id IS NOT NULL ORDER BY id`,
    ),
    locationNameResolver(),
  ]);
  const filesByMig = new Map<number, any[]>();
  for (const b of batches) {
    const mid = Number(b.migration_id);
    if (!filesByMig.has(mid)) filesByMig.set(mid, []);
    filesByMig.get(mid)!.push({
      module: b.module, filename: b.filename, status: b.status,
      totalRows: Number(b.total_rows ?? 0), validRows: Number(b.valid_rows ?? 0),
      warningRows: Number(b.warning_rows ?? 0), errorRows: Number(b.error_rows ?? 0),
      importedRows: b.imported_rows == null ? null : Number(b.imported_rows),
    });
  }
  res.json({
    migrations: migs.map((m: any) => ({
      ...migrationJson(m),
      locationName: nameOf(m),
      files: filesByMig.get(Number(m.id)) ?? [],
    })),
  });
});

router.get("/imports/migrations/:id", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const detail = await migrationDetail(id);
  if (!detail) { res.status(404).json({ error: "Migration not found" }); return; }
  res.json(detail);
});

/** Upload (or replace) one module's file inside a migration. The old file's
 *  batch is hard-deleted — a migration holds at most ONE file per module. */
router.post(
  "/imports/migrations/:id/files",
  requireModuleAction(PERM, "add"),
  express.raw({ type: () => true, limit: "10mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
    const module = asModule(req.query.module) as DemoModule | null;
    if (!module || !isDemoModule(module) || !WIZARD_MODULES.includes(module)) {
      res.status(400).json({ error: `Pass ?module= one of: ${WIZARD_MODULES.join(", ")}` }); return;
    }
    const filename = String(req.query.filename ?? "upload.xlsx").replace(/[^A-Za-z0-9 ._()-]/g, "_").slice(-120);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: "Send the .xlsx file as the request body." }); return;
    }
    const { rows: [mig] } = await pool.query(`SELECT * FROM import_migrations WHERE id = $1`, [id]);
    if (!mig) { res.status(404).json({ error: "Migration not found" }); return; }
    if (mig.status !== "draft" && mig.status !== "demo_ready") {
      res.status(409).json({ error: `Migration ${migrationDisplayId(id)} is already ${String(mig.status).replace("_", " ")} — start a new migration for more files.` });
      return;
    }

    const pw = await parseWorkbookValues(module, body);
    if ("error" in pw) { res.status(400).json({ error: pw.error }); return; }
    const { results } = await runWizardValidators(module, pw.parsed, PROVISIONAL_STAMP);

    const counts = { valid: 0, warning: 0, error: 0 };
    for (const v of results) {
      const s = String(v.status);
      counts[s === "needs_mapping" || s === "needs_party" ? "error" : (s as "valid" | "warning" | "error")]++;
    }

    // Replace: the previous upload for this module (if any) disappears.
    const { rows: oldBatches } = await pool.query(
      `SELECT id FROM import_batches WHERE migration_id = $1 AND module = $2`, [id, module],
    );
    for (const ob of oldBatches) {
      await pool.query(`DELETE FROM import_rows WHERE batch_id = $1`, [ob.id]);
      await pool.query(`DELETE FROM import_batches WHERE id = $1`, [ob.id]);
    }

    const user = username(req);
    const { rows: [batch] } = await pool.query(
      `INSERT INTO import_batches (module, filename, status, total_rows, valid_rows, warning_rows, error_rows, created_by, location_type, location_id, migration_id, conversion)
       VALUES ($1, $2, 'validated', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [module, filename, pw.parsed.length, counts.valid, counts.warning, counts.error,
       user, PROVISIONAL_STAMP.type, PROVISIONAL_STAMP.id, id,
       pw.conversion ? JSON.stringify(pw.conversion) : null],
    );
    for (let i = 0; i < pw.parsed.length; i++) {
      const p = pw.parsed[i];
      const v = results[i];
      await pool.query(
        `INSERT INTO import_rows (batch_id, row_number, raw, status, reason, suggestion, duplicate_of_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [batch.id, p.rowNumber, JSON.stringify({ values: p.values, norm: v.norm }),
         v.status, v.reason, v.suggestion, v.duplicateOfId],
      );
    }
    await demoteMigration(id);

    logActivity({
      action: "CREATE", module: "imports", entityType: "import_migration", entityId: id,
      description: `Migration ${migrationDisplayId(id)}: ${oldBatches.length > 0 ? "replaced" : "added"} ${module} file "${filename}" — ${pw.parsed.length} rows (${counts.valid} valid, ${counts.warning} warnings, ${counts.error} errors)`,
      user,
    }).catch(() => {});

    res.status(201).json(await migrationDetail(id));
  },
);

/** Remove one module's file from a draft migration. */
router.delete("/imports/migrations/:id/files/:module", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const module = asModule(req.params.module) as DemoModule | null;
  if (!module || !WIZARD_MODULES.includes(module)) { res.status(400).json({ error: "Unknown module" }); return; }
  const { rows: [mig] } = await pool.query(`SELECT * FROM import_migrations WHERE id = $1`, [id]);
  if (!mig) { res.status(404).json({ error: "Migration not found" }); return; }
  if (mig.status !== "draft" && mig.status !== "demo_ready") {
    res.status(409).json({ error: `Migration ${migrationDisplayId(id)} is already ${String(mig.status).replace("_", " ")}.` }); return;
  }
  const { rows: old } = await pool.query(`SELECT id, filename FROM import_batches WHERE migration_id = $1 AND module = $2`, [id, module]);
  if (old.length === 0) { res.status(404).json({ error: "No file uploaded for that module." }); return; }
  for (const ob of old) {
    await pool.query(`DELETE FROM import_rows WHERE batch_id = $1`, [ob.id]);
    await pool.query(`DELETE FROM import_batches WHERE id = $1`, [ob.id]);
  }
  await demoteMigration(id);
  logActivity({
    action: "DELETE", module: "imports", entityType: "import_migration", entityId: id,
    description: `Migration ${migrationDisplayId(id)}: removed ${module} file "${old[0].filename}"`,
    user: username(req),
  }).catch(() => {});
  res.json(await migrationDetail(id));
});

/** Unmapped names across ALL of a migration's files, in one workspace. */
router.get("/imports/migrations/:id/mappings", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const { rows: [mig] } = await pool.query(`SELECT id FROM import_migrations WHERE id = $1`, [id]);
  if (!mig) { res.status(404).json({ error: "Migration not found" }); return; }
  const { rows: importRows } = await pool.query(
    `SELECT r.raw FROM import_rows r JOIN import_batches b ON b.id = r.batch_id WHERE b.migration_id = $1`, [id],
  );
  res.json(await buildMappingWorkspace(importRows));
});

/** Save mapping decisions for a migration, then re-check every file. */
router.post("/imports/migrations/:id/mappings", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const { rows: [mig] } = await pool.query(`SELECT * FROM import_migrations WHERE id = $1`, [id]);
  if (!mig) { res.status(404).json({ error: "Migration not found" }); return; }
  if (mig.status !== "draft" && mig.status !== "demo_ready") {
    res.status(409).json({ error: "Mappings can only be saved before the migration is approved." }); return;
  }
  const body = (req.body ?? {}) as { mappings?: unknown };
  const mappingsIn = Array.isArray(body.mappings) ? body.mappings : [];
  if (mappingsIn.length === 0) { res.status(400).json({ error: "Pass mappings: [{ kind, name, targetId | create }]" }); return; }
  if (mappingsIn.length > 500) { res.status(400).json({ error: "Too many mappings in one request." }); return; }

  const user = username(req);
  // Masters created while mapping are stamped Head Office — visible from
  // every location, including whichever one the migration finally lands at.
  const { saved, created, errors } = await applyMappingEntries(
    mappingsIn, PROVISIONAL_STAMP, user, `migration ${migrationDisplayId(id)}`,
  );

  // Re-check every file against the new mappings (each at its own stamp).
  const { rows: batches } = await pool.query(`SELECT * FROM import_batches WHERE migration_id = $1`, [id]);
  for (const b of batches) {
    const module = asModule(b.module);
    if (!module || !isDemoModule(module)) continue;
    await revalidateDemoBatch(Number(b.id), module, {
      type: String(b.location_type ?? "headoffice"), id: Number(b.location_id ?? 1),
    });
  }
  await demoteMigration(id);

  logActivity({
    action: "UPDATE", module: "imports", entityType: "import_migration", entityId: id,
    description: `Migration ${migrationDisplayId(id)}: saved mappings — ${saved.length} mapped, ${created.length} created${errors.length ? `, ${errors.length} failed` : ""}`,
    user,
  }).catch(() => {});

  res.json({ saved, created, errors, ...(await migrationDetail(id)) });
});

/** The combined demo: every file runs through the REAL import code in ONE
 *  transaction, the full report pack is built from inside it, then EVERYTHING
 *  is rolled back. Requires every file to be clean (no errors, no unmapped
 *  names) so the demo is exactly what approval will write. */
router.post("/imports/migrations/:id/demo", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }

  const lockClient = await pool.connect();
  let locked = false;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [`import_migration_${id}`]);
    locked = true;

    const { rows: [mig] } = await pool.query(`SELECT * FROM import_migrations WHERE id = $1`, [id]);
    if (!mig) { res.status(404).json({ error: "Migration not found" }); return; }
    if (mig.status !== "draft" && mig.status !== "demo_ready") {
      res.status(409).json({ error: `Migration ${migrationDisplayId(id)} is already ${String(mig.status).replace("_", " ")}.` }); return;
    }
    const { rows: batches } = await pool.query(`SELECT * FROM import_batches WHERE migration_id = $1`, [id]);
    if (batches.length === 0) { res.status(400).json({ error: "Upload at least one file first." }); return; }

    // Strict gate: unmapped names go back to the mapping step, error rows go
    // back to the file. This is what makes the demo EQUAL the final import.
    const mapBlocks: string[] = [];
    const errBlocks: string[] = [];
    for (const b of batches) {
      const { rows: [c] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status IN ('needs_mapping','needs_party'))::int AS nm,
                COUNT(*) FILTER (WHERE status = 'error')::int AS err
           FROM import_rows WHERE batch_id = $1`, [b.id],
      );
      if (Number(c?.nm ?? 0) > 0) mapBlocks.push(`${b.module}: ${c.nm}`);
      if (Number(c?.err ?? 0) > 0) errBlocks.push(`${b.module}: ${c.err}`);
    }
    if (mapBlocks.length > 0) {
      res.status(409).json({ error: `Finish the mapping step first — unmapped names remain (${mapBlocks.join(", ")}).` }); return;
    }
    if (errBlocks.length > 0) {
      res.status(409).json({ error: `Fix the error rows first (${errBlocks.join(", ")}) — correct the file and upload it again. The demo only runs on clean files so it shows exactly what the final import will do.` }); return;
    }

    const user = username(req);
    const byModule = new Map<string, any>(batches.map((b: any) => [String(b.module), b]));

    // ── ONE never-committed transaction across every file ──
    const client = await pool.connect();
    const runs: Array<{ module: DemoModule; batch: any; run: Awaited<ReturnType<typeof runBatchImport>> }> = [];
    let report: Record<string, unknown>;
    try {
      await client.query("BEGIN");
      for (const module of WIZARD_RUN_ORDER) {
        const b = byModule.get(module);
        if (!b) continue;
        const { rows: importRows } = await pool.query(
          `SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [b.id],
        );
        const loc = { type: String(b.location_type ?? "headoffice"), id: Number(b.location_id ?? 1) };
        const run = await runBatchImport(client, { batchId: Number(b.id), module, importRows, loc, user, mode: "demo" });
        runs.push({ module, batch: b, run });
      }
      report = await buildDemoReportPack(client);
    } finally {
      // EVERYTHING the demo wrote vanishes here — documents, stock, numbers.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    // Snapshot bookkeeping outside the demo transaction.
    const totals = { imported: 0, skipped: 0, failed: 0 };
    const failures: Array<{ module: DemoModule; rowNumber: number; name: string; reason: string }> = [];
    const perModule: Record<string, unknown> = {};
    const allLegacy: string[] = [];
    for (const { module, batch: b, run } of runs) {
      await pool.query(`UPDATE import_rows SET raw = raw - 'demo' WHERE batch_id = $1`, [b.id]);
      for (const o of run.outcomes) {
        await pool.query(`UPDATE import_rows SET raw = raw || $2::jsonb WHERE id = $1`, [o.rowId, JSON.stringify({
          demo: { status: o.status, reason: o.reason, createdType: o.createdType, created: o.created },
        })]);
      }
      const legacySorted = sortLegacy(run.legacyNumbers);
      allLegacy.push(...run.legacyNumbers);
      const summary = {
        ...run.counts,
        failures: run.failures.slice(0, 100),
        legacyMin: legacySorted[0] ?? null,
        legacyMax: legacySorted[legacySorted.length - 1] ?? null,
        timeTakenMs: Date.now() - startedAt,
      };
      await pool.query(
        `UPDATE import_batches SET status = 'demo_ready', demo_summary = $2, demo_at = NOW(), demo_by = $3,
            legacy_min = $4, legacy_max = $5
          WHERE id = $1`,
        [b.id, JSON.stringify(summary), user, legacySorted[0] ?? null, legacySorted[legacySorted.length - 1] ?? null],
      );
      totals.imported += run.counts.imported;
      totals.skipped += run.counts.skipped;
      totals.failed += run.counts.failed;
      for (const f of run.failures) failures.push({ module, ...f });
      perModule[module] = {
        ...run.counts,
        legacyMin: legacySorted[0] ?? null,
        legacyMax: legacySorted[legacySorted.length - 1] ?? null,
      };
    }
    const legacyAll = sortLegacy(allLegacy);
    const migSummary = {
      ...totals,
      perModule,
      failures: failures.slice(0, 100),
      timeTakenMs: Date.now() - startedAt,
    };
    const { rows: [updated] } = await pool.query(
      `UPDATE import_migrations SET status = 'demo_ready', demo_report = $2, demo_summary = $3,
          demo_at = NOW(), demo_by = $4, legacy_min = $5, legacy_max = $6
        WHERE id = $1 RETURNING *, (demo_report IS NOT NULL) AS has_demo_report`,
      [id, JSON.stringify(report), JSON.stringify(migSummary), user,
       legacyAll[0] ?? null, legacyAll[legacyAll.length - 1] ?? null],
    );

    logActivity({
      action: "UPDATE", module: "imports", entityType: "import_migration", entityId: id,
      description: `Migration ${migrationDisplayId(id)}: demo run across ${runs.length} file${runs.length === 1 ? "" : "s"} — ${totals.imported} would import, ${totals.failed} failed, ${totals.skipped} skipped (nothing committed)`,
      user,
    }).catch(() => {});

    res.json({ migration: migrationJson(updated), summary: migSummary, failures });
  } finally {
    if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`import_migration_${id}`]).catch(() => {});
    lockClient.release();
  }
});

router.get("/imports/migrations/:id/demo-report", requireModuleView(PERM), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const { rows: [m] } = await pool.query(
    `SELECT demo_report, demo_summary, demo_at, demo_by, status FROM import_migrations WHERE id = $1`, [id],
  );
  if (!m) { res.status(404).json({ error: "Migration not found" }); return; }
  if (m.demo_report == null) { res.status(404).json({ error: "No demo run on record — run the demo first." }); return; }
  res.json({ report: m.demo_report, summary: m.demo_summary ?? null, demoAt: m.demo_at, demoBy: m.demo_by, status: m.status });
});

/** Approve = the FINAL import. The location is chosen here (after
 *  verification, per the wizard's order), every file is re-stamped and
 *  re-validated at it, and the whole set imports in ONE transaction —
 *  any failure rolls back the entire migration. */
router.post("/imports/migrations/:id/approve", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const user = username(req);

  const body = (req.body ?? {}) as { locationType?: unknown; locationId?: unknown };
  if (!body.locationType) {
    res.status(400).json({ error: "Pick the location first — every document in the migration is recorded there." }); return;
  }
  const resolved = await resolveActingLocation(pool, {
    employee: (req as any).employee,
    requested: { type: body.locationType, id: body.locationId },
  });
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  if (resolved.loc.type === "outlet" && await outletWritesBlocked(pool)) {
    res.status(400).json({ error: OUTLETS_DISABLED_MESSAGE }); return;
  }
  const loc = resolved.loc;
  {
    const disabledMsg = await disabledWarehouseError(pool, [{ type: loc.type, id: loc.id }]);
    if (disabledMsg) { res.status(409).json({ error: disabledMsg, code: WAREHOUSE_DISABLED_CODE }); return; }
  }

  const lockClient = await pool.connect();
  let locked = false;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [`import_migration_${id}`]);
    locked = true;

    // ── The ONE all-or-nothing transaction for the WHOLE approval ──
    // The status claim, the location restamp + revalidation, the documents,
    // the row outcomes, the batch statuses and the final migration status all
    // commit together: a failure ANYWHERE rolls back EVERYTHING, so the books
    // can never hold records the migration doesn't acknowledge, no partial
    // restamp/revalidation can survive a failed attempt, and the migration is
    // never stranded in 'committing' — it simply stays demo_ready, exactly as
    // the demo left it.
    const client = await pool.connect();
    const totals = { imported: 0, skipped: 0, failed: 0 };
    const recordCounts: Record<string, number> = {};
    let finished: any = null;
    let migRow: any = null;
    let runCount = 0;
    let released = false;
    const releaseClient = () => { if (!released) { released = true; client.release(); } };
    const bail = async (status: number, bodyOut: Record<string, unknown>): Promise<void> => {
      await client.query("ROLLBACK").catch(() => {});
      releaseClient();
      res.status(status).json(bodyOut);
    };
    try {
      await client.query("BEGIN");

      // Claim — approval only ever follows a clean demo run. Uncommitted, so
      // any failure below reverts it with the rest; the advisory lock (held
      // outside the transaction) serialises concurrent approve attempts.
      const { rows: [mig] } = await client.query(
        `UPDATE import_migrations SET status = 'committing', committed_at = NOW(), committed_by = $2,
            location_type = $3, location_id = $4
          WHERE id = $1 AND status = 'demo_ready' RETURNING *`,
        [id, user, loc.type, loc.id],
      );
      if (!mig) {
        const { rows: [m] } = await pool.query(`SELECT status FROM import_migrations WHERE id = $1`, [id]);
        if (!m) { await bail(404, { error: "Migration not found" }); return; }
        await bail(409, {
          error: m.status === "draft"
            ? "Run the demo first — approval imports exactly what the demo showed."
            : `Migration ${migrationDisplayId(id)} is ${m.status === "committing" ? "already being imported" : `already ${String(m.status).replace("_", " ")}`}.`,
        });
        return;
      }
      migRow = mig;

      if (Number((mig.demo_summary as any)?.failed ?? 1) > 0) {
        await bail(409, { error: "The demo run had failed documents — fix the files, re-run the demo, and approve only when the demo is clean." });
        return;
      }

      const { rows: batches } = await client.query(`SELECT * FROM import_batches WHERE migration_id = $1`, [id]);
      if (batches.length === 0) { await bail(400, { error: "This migration has no files." }); return; }

      // Re-stamp every file to the chosen location and re-validate there —
      // duplicates, stock scope and ledger ownership are all per-location.
      // Runs on the transaction client: a failure (or rejection) below rolls
      // back every restamp and every rewritten row status/reason.
      const locBlocks: string[] = [];
      for (const b of batches) {
        const module = asModule(b.module) as DemoModule;
        await client.query(`UPDATE import_batches SET location_type = $2, location_id = $3 WHERE id = $1`, [b.id, loc.type, loc.id]);
        const { counts } = await revalidateDemoBatch(Number(b.id), module, { type: loc.type, id: Number(loc.id) }, client);
        const bad = counts.error + counts.needsMapping;
        if (bad > 0) locBlocks.push(`${b.module}: ${bad} row${bad === 1 ? "" : "s"}`);
      }
      // Dev-only fault injection: verifies a crash mid-revalidation leaves
      // batch locations, row statuses and the migration status untouched.
      if (process.env.NODE_ENV !== "production" && process.env.IMPORT_FAULT_INJECT === "approve_revalidation") {
        throw new Error("Injected fault after location revalidation (IMPORT_FAULT_INJECT=approve_revalidation)");
      }
      if (locBlocks.length > 0) {
        await bail(409, {
          error: `The chosen location rejected some rows (${locBlocks.join(", ")}) — e.g. a Location column naming a different branch, or documents already existing there. Fix the cause or pick another location, then re-run the demo.`,
        });
        return;
      }

      const byModule = new Map<string, any>(batches.map((b: any) => [String(b.module), b]));
      const runs: Array<{ batch: any; run: Awaited<ReturnType<typeof runBatchImport>> }> = [];
      for (const module of WIZARD_RUN_ORDER) {
        const b = byModule.get(module);
        if (!b) continue;
        const { rows: importRows } = await client.query(
          `SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [b.id],
        );
        const run = await runBatchImport(client, {
          batchId: Number(b.id), module: module as DemoModule, importRows, loc: { type: loc.type, id: Number(loc.id) }, user, mode: "approve",
        });
        runs.push({ batch: b, run });
      }
      runCount = runs.length;

      // Dev-only fault injection: verifies the atomicity guarantee above —
      // a crash between document creation and bookkeeping must roll back both.
      if (process.env.NODE_ENV !== "production" && process.env.IMPORT_FAULT_INJECT === "approve_bookkeeping") {
        throw new Error("Injected fault after document creation (IMPORT_FAULT_INJECT=approve_bookkeeping)");
      }

      const allLegacy: string[] = [];
      for (const { batch: b, run } of runs) {
        for (const o of run.outcomes) {
          await client.query(
            `UPDATE import_rows SET status = $2, reason = $3, created_record_type = $4, created_record_id = $5 WHERE id = $1`,
            [o.rowId, o.status, o.reason, o.createdType, o.createdId],
          );
          if (o.created) {
            await client.query(`UPDATE import_rows SET raw = raw || $2::jsonb WHERE id = $1`,
              [o.rowId, JSON.stringify({ created: o.created })]);
          }
        }
        const legacySorted = sortLegacy(run.legacyNumbers);
        allLegacy.push(...run.legacyNumbers);
        await client.query(
          `UPDATE import_batches SET status = 'committed', committed_at = NOW(), committed_by = $2,
              imported_rows = $3, updated_rows = 0, skipped_rows = $4, failed_rows = $5,
              legacy_min = COALESCE($6, legacy_min), legacy_max = COALESCE($7, legacy_max)
            WHERE id = $1`,
          [b.id, user, run.counts.imported, run.counts.skipped, run.counts.failed,
           legacySorted[0] ?? null, legacySorted[legacySorted.length - 1] ?? null],
        );
        totals.imported += run.counts.imported;
        totals.skipped += run.counts.skipped;
        totals.failed += run.counts.failed;
        const rc = await batchRecordCounts(client, Number(b.id));
        for (const [k, v] of Object.entries(rc)) recordCounts[k] = (recordCounts[k] ?? 0) + Number(v);
      }
      const legacyAll = sortLegacy(allLegacy);
      const { rows: [fin] } = await client.query(
        `UPDATE import_migrations SET status = 'committed', record_counts = $2,
            legacy_min = COALESCE($3, legacy_min), legacy_max = COALESCE($4, legacy_max)
          WHERE id = $1 AND status = 'committing' RETURNING *, (demo_report IS NOT NULL) AS has_demo_report`,
        [id, JSON.stringify(recordCounts), legacyAll[0] ?? null, legacyAll[legacyAll.length - 1] ?? null],
      );
      finished = fin;
      await client.query("COMMIT");
    } catch (e: any) {
      // All-or-nothing across the WHOLE migration: the ROLLBACK erases every
      // document any file created, every restamp/revalidation write AND every
      // bookkeeping write — the books, the import tables and the migration
      // status are exactly as before, free for another attempt.
      await client.query("ROLLBACK").catch(() => {});
      releaseClient();
      if (e instanceof ImportAbort) {
        res.status(409).json({
          error: `Import stopped at ${e.docLabel}: ${e.reasonText}. Nothing was imported from ANY file — fix the cause and approve again.`,
        });
        return;
      }
      throw e;
    }
    releaseClient();
    if (res.headersSent) return; // a bail() path already answered

    logActivity({
      action: "CREATE", module: "imports", entityType: "import_migration", entityId: id,
      description: `Approved migration ${migrationDisplayId(id)} into ${loc.type === "headoffice" ? "Head Office" : `${loc.type} #${loc.id}`} — ${totals.imported} rows imported across ${runCount} file${runCount === 1 ? "" : "s"} (${describeCounts(recordCounts)})`,
      user,
    }).catch(() => {});

    res.json({
      migration: migrationJson(finished ?? migRow),
      summary: totals,
      details: { recordCounts, timeTakenMs: Date.now() - startedAt },
    });
  } finally {
    if (locked) await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`import_migration_${id}`]).catch(() => {});
    lockClient.release();
  }
});

router.post("/imports/migrations/:id/discard", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const user = username(req);
  const { rows: [m] } = await pool.query(
    `UPDATE import_migrations SET status = 'discarded', discarded_at = NOW(), discarded_by = $2
      WHERE id = $1 AND status IN ('draft', 'demo_ready') RETURNING *`,
    [id, user],
  );
  if (!m) {
    const { rows: [cur] } = await pool.query(`SELECT status FROM import_migrations WHERE id = $1`, [id]);
    if (!cur) { res.status(404).json({ error: "Migration not found" }); return; }
    res.status(409).json({ error: `Migration ${migrationDisplayId(id)} is already ${String(cur.status).replace("_", " ")}.` });
    return;
  }
  await pool.query(
    `UPDATE import_batches SET status = 'discarded', discarded_at = NOW(), discarded_by = $2
      WHERE migration_id = $1 AND status IN ('validated', 'demo_ready')`,
    [id, user],
  );
  logActivity({
    action: "UPDATE", module: "imports", entityType: "import_migration", entityId: id,
    description: `Discarded migration ${migrationDisplayId(id)} — nothing was ever written to the books`,
    user,
  }).catch(() => {});
  res.json({ migration: migrationJson(m) });
});

/** Reverse ONE committed wizard file inside the caller's transaction.
 *  Mirrors the per-batch rollback blocks; kept separate on purpose — the
 *  battle-tested per-batch handler stays untouched. */
async function reverseWizardBatch(
  client: PoolClient, batch: any,
): Promise<{ blocked: Array<{ rowNumber: number; name: string; reason: string }>; removed: number }> {
  const id = Number(batch.id);
  const blocked: Array<{ rowNumber: number; name: string; reason: string }> = [];
  let removed = 0;

  if (batch.module === "sales" || batch.module === "purchases") {
    const { rows: docRowsAll } = await client.query(
      `SELECT * FROM import_rows
        WHERE batch_id = $1 AND status = 'imported' AND created_record_id IS NOT NULL
        ORDER BY row_number`, [id],
    );
    const seenDocs = new Set<number>();
    for (const r of docRowsAll) {
      const recId = Number(r.created_record_id);
      if (seenDocs.has(recId)) continue;
      seenDocs.add(recId);
      const headRow = docRowsAll.find((x: any) => Number(x.created_record_id) === recId && x.raw?.created) ?? r;
      const createdInfo = (headRow.raw?.created ?? {}) as Record<string, any>;
      const label = String(createdInfo.invoiceNumber ?? headRow.raw?.norm?.invoiceNumber ?? "") || `row ${r.row_number}`;
      const reason = batch.module === "sales"
        ? await rollbackImportedSale(client as any, recId, {
            salePaymentIds: createdInfo.salePaymentIds, clearingReceiptIds: createdInfo.clearingReceiptIds,
          })
        : await rollbackImportedPurchase(client as any, recId, { paymentId: createdInfo.paymentId ?? null });
      if (reason) blocked.push({ rowNumber: Number(r.row_number), name: label, reason });
      else removed++;
    }
    return { blocked, removed };
  }

  if (batch.module === "receipts" || batch.module === "payments") {
    const { rows: vRows } = await client.query(
      `SELECT * FROM import_rows
        WHERE batch_id = $1 AND status = 'imported' AND created_record_id IS NOT NULL
        ORDER BY row_number`, [id],
    );
    for (const r of vRows) {
      const recId = Number(r.created_record_id);
      const label = String(r.raw?.created?.voucherNumber ?? r.raw?.norm?.voucherNo ?? "") || `row ${r.row_number}`;
      // Rows ROUTED to a ledger were imported as journal vouchers (non-party
      // names) — plain removal, exactly like a day-book rollback.
      if (String(r.created_record_type) === "journal_voucher") {
        await client.query(`DELETE FROM journal_voucher_lines WHERE voucher_id = $1`, [recId]);
        await client.query(`DELETE FROM journal_vouchers WHERE id = $1`, [recId]);
        removed++;
        continue;
      }
      const reason = batch.module === "receipts"
        ? await rollbackImportedReceiptVoucher(client as any, recId)
        : await rollbackImportedPaymentVoucher(client as any, recId);
      if (reason) blocked.push({ rowNumber: Number(r.row_number), name: label, reason });
      else removed++;
    }
    return { blocked, removed };
  }

  if (batch.module === "daybook") {
    const { rows: jvRows } = await client.query(
      `SELECT DISTINCT created_record_id AS jv_id FROM import_rows
        WHERE batch_id = $1 AND status = 'imported'
          AND created_record_type = 'journal_voucher' AND created_record_id IS NOT NULL`, [id],
    );
    const jvIds = jvRows.map((r: any) => Number(r.jv_id));
    if (jvIds.length > 0) {
      await client.query(`DELETE FROM journal_voucher_lines WHERE voucher_id = ANY($1::int[])`, [jvIds]);
      await client.query(`DELETE FROM journal_vouchers WHERE id = ANY($1::int[])`, [jvIds]);
      removed += jvIds.length;
    }
    return { blocked, removed };
  }

  if (batch.module === "opening_stock") {
    const { rows: verifRows } = await client.query(
      `SELECT DISTINCT created_record_id AS vid FROM import_rows
        WHERE batch_id = $1 AND status = 'imported'
          AND created_record_type = 'stock_verification' AND created_record_id IS NOT NULL`, [id],
    );
    for (const v of verifRows) {
      const reason = await rollbackImportedOpeningStock(client as any, Number(v.vid));
      if (reason) blocked.push({ rowNumber: 0, name: `Opening stock upload #${v.vid}`, reason });
      else removed++;
    }
    return { blocked, removed };
  }

  return { blocked, removed };
}

/** Roll back the ENTIRE migration — every file, in reverse import order,
 *  inside ONE transaction. Never partial: one blocked document keeps the
 *  whole migration in place. */
router.post("/imports/migrations/:id/rollback", requireModuleAction(PERM, "delete"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid migration id" }); return; }
  const user = username(req);

  // Same top-management gate as per-batch rollback — fails closed.
  const hierarchyId = (req as any).employee?.hierarchyId ?? null;
  const { rows: [lvl] } = await pool.query<any>(`SELECT level FROM hierarchies WHERE id = $1`, [hierarchyId]);
  const roleLevel = lvl?.level == null ? null : Number(lvl.level);
  if (roleLevel == null || roleLevel > 2) {
    res.status(403).json({ error: "Only Admin or Management can delete a migration." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [lock] } = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got`, [`import_migration_${id}`],
    );
    if (!lock?.got) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This migration is busy right now — try again in a moment." });
      return;
    }
    const { rows: [mig] } = await client.query(`SELECT * FROM import_migrations WHERE id = $1 FOR UPDATE`, [id]);
    if (!mig) { await client.query("ROLLBACK"); res.status(404).json({ error: "Migration not found" }); return; }
    if (mig.rolled_back_at || mig.status === "rolled_back") {
      await client.query("ROLLBACK"); res.status(409).json({ error: "This migration was already rolled back." }); return;
    }
    if (mig.status !== "committed") {
      await client.query("ROLLBACK"); res.status(409).json({ error: "Only committed migrations can be rolled back." }); return;
    }

    const { rows: batches } = await client.query(
      `SELECT * FROM import_batches WHERE migration_id = $1 AND status = 'committed'`, [id],
    );
    if (batches.length === 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This migration has no committed files, so there is nothing to roll back." });
      return;
    }
    const byModule = new Map<string, any>(batches.map((b: any) => [String(b.module), b]));

    // Captured BEFORE the deletes, for the audit trail and verification.
    const removedCounts: Record<string, number> = {};
    const invoicesByBatch = new Map<number, string[]>();
    for (const b of batches) {
      const rc = await batchRecordCounts(client, Number(b.id));
      for (const [k, v] of Object.entries(rc)) removedCounts[k] = (removedCounts[k] ?? 0) + Number(v);
      invoicesByBatch.set(Number(b.id), await batchSaleInvoiceNumbers(client, Number(b.id)));
    }

    // Reverse import order: money first, then documents, then opening stock.
    const blocked: Array<{ module: string; rowNumber: number; name: string; reason: string }> = [];
    let removed = 0;
    for (const module of [...WIZARD_RUN_ORDER].reverse()) {
      const b = byModule.get(module);
      if (!b) continue;
      const r = await reverseWizardBatch(client, b);
      removed += r.removed;
      for (const bl of r.blocked) blocked.push({ module, ...bl });
    }
    if (blocked.length > 0) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: `Cannot roll back: ${blocked.length} imported record${blocked.length === 1 ? " has" : "s have"} since gained payments, returns or other activity. Remove that activity first, or leave the migration in place. Nothing was deleted.`,
        blocked,
      });
      return;
    }

    for (const b of batches) {
      await client.query(`UPDATE import_rows SET status = 'rolled_back' WHERE batch_id = $1 AND status = 'imported'`, [b.id]);
      await client.query(
        `UPDATE import_batches SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2 WHERE id = $1`,
        [b.id, user],
      );
    }
    const { rows: [finished] } = await client.query(
      `UPDATE import_migrations SET status = 'rolled_back', rolled_back_at = NOW(), rolled_back_by = $2
        WHERE id = $1 RETURNING *, (demo_report IS NOT NULL) AS has_demo_report`,
      [id, user],
    );
    await client.query("COMMIT");

    // Post-commit verification per file, aggregated.
    const perBatch: Array<{ module: string; verification: Awaited<ReturnType<typeof verifyAfterRollback>> }> = [];
    for (const b of batches) {
      perBatch.push({
        module: String(b.module),
        verification: await verifyAfterRollback(Number(b.id), invoicesByBatch.get(Number(b.id)) ?? []),
      });
    }
    const verification = {
      ok: perBatch.every((p) => p.verification.ok),
      perBatch,
    };

    logActivity({
      action: "DELETE", module: "imports", entityType: "import_migration", entityId: id,
      description: `Rolled back migration ${migrationDisplayId(id)} — removed ${describeCounts(removedCounts)} across ${batches.length} file${batches.length === 1 ? "" : "s"}; verification ${verification.ok ? "passed" : "FAILED"}`,
      user,
      metadata: { displayId: migrationDisplayId(id), removedCounts, verification },
    }).catch(() => {});

    res.json({ migration: migrationJson(finished), removed, removedCounts, verification });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

export default router;
