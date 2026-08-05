/**
 * Data Import module — Tally/Zoho-style migration of old-ERP masters.
 *
 * Pipeline per module (customers / vendors / ledgers):
 *   1. GET  /imports/templates/:module      → pre-filled sample .xlsx
 *   2. POST /imports/parse                  → upload + validate → batch preview
 *   3. POST /imports/batches/:id/commit     → create records (same code paths
 *                                             as manual creation), row by row
 *   4. GET  /imports/batches                → history
 *   5. POST /imports/batches/:id/rollback   → delete ONLY that batch's records
 *
 * Commit goes through lib/partyCreate.ts, lib/chartGroups.insertChartAccount
 * and lib/openingBalances.ts — the exact code manual creation uses — so ledger
 * auto-provisioning, location stamping and audit stamps behave identically.
 *
 * Rollback eligibility is decided from ACTUAL state at rollback time (ledger
 * postings, sales/purchases, child ledgers), never from the history flag: a
 * batch that looks rollback-able in the list can still refuse with per-record
 * reasons if its records have since been used.
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
  importAccountOptions, resolveAccountValue,
  importReceiptVoucher, importPaymentVoucher,
  rollbackImportedReceiptVoucher, rollbackImportedPaymentVoucher,
} from "../lib/importVouchers";
import { type ProdLocation } from "../lib/productionCosting";
import { outstandingExpr } from "../lib/salePaymentPosition";
import { purchaseSettlementIndex } from "../lib/vendorBillSettlement";

const router: IRouter = Router();

const PERM = "page:/company/import";

type ImportModule = "customers" | "vendors" | "ledgers" | "sales" | "purchases" | "receipts" | "payments";
const MODULES: ImportModule[] = ["customers", "vendors", "ledgers", "sales", "purchases", "receipts", "payments"];

/** Sales & purchases import whole DOCUMENTS (with stock + books effects), not
 *  master records — they get their own validation, commit and rollback paths. */
type TxnModule = "sales" | "purchases";
const isTxnModule = (m: ImportModule): m is TxnModule => m === "sales" || m === "purchases";

/** Receipt & payment VOUCHERS: one row = one voucher, allocated against the
 *  party's outstanding invoices with any excess parked as an advance. */
type VoucherModule = "receipts" | "payments";
const isVoucherModule = (m: ImportModule): m is VoucherModule => m === "receipts" || m === "payments";

function asModule(v: unknown): ImportModule | null {
  const s = String(v ?? "").toLowerCase();
  return (MODULES as string[]).includes(s) ? (s as ImportModule) : null;
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
      { key: "voucherNo", header: "Voucher No", example: "RV/25-26/0087", hint: "Old ERP voucher number — kept exactly as supplied and must be unique; blank rows draw the next number from the voucher sequence", aliases: ["voucherno", "vouchernumber", "vchno", "vchnumber", "receiptno", "receiptnumber", "rcptno", "no", "number"] },
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
      { key: "voucherNo", header: "Voucher No", example: "PV/25-26/0042", hint: "Old ERP voucher number — kept exactly as supplied and must be unique; blank rows draw the next number from the voucher sequence", aliases: ["voucherno", "vouchernumber", "vchno", "vchnumber", "paymentno", "paymentnumber", "no", "number"] },
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
  /** needs_party: valid row whose customer/vendor doesn't exist yet — resolved
   *  via POST /imports/batches/:id/resolve-parties before commit. */
  status: "valid" | "warning" | "error" | "needs_party";
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
  /** Purchases: postable expense ledgers an "Other Charge Ledger" cell may
   *  name (lower(name) → ledger) — the same set the manual bill form offers,
   *  and the same rules importPurchaseDoc re-validates at commit. */
  expenseLedgers: Map<string, { id: number; name: string }>;
  settings: ImportSettings;
}

/** Expense ledgers valid for Other Purchase Charges: postable, active,
 *  expense-type, not internal, and not inside the Purchase (SYS-PUR) subtree —
 *  mirrors lib/otherCharges.ts. Unknown names are ERRORS, not a resolve step:
 *  auto-creating a ledger from a typo would scatter the chart of accounts. */
async function importExpenseLedgerOptions(): Promise<Map<string, { id: number; name: string }>> {
  const { rows } = await pool.query<any>(`
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

/** Legacy-migration behaviour toggles (Company Settings → Data Import).
 *  Everything defaults ON — a fresh company gets the forgiving behaviour;
 *  each can be switched off to force strict review instead. */
interface ImportSettings {
  /** Sales/receipts: unknown customer names are created automatically at commit. */
  autoCreateCustomers: boolean;
  /** Purchases/payments: unknown vendor names are created automatically at commit. */
  autoCreateVendors: boolean;
  /** Sales: a blank Customer on a cash/bank/UPI sale = walk-in counter sale (no customer). */
  autoWalkInCustomer: boolean;
  /** Sales: a price below the Item Master MRP is folded into a per-unit discount (POS rule). */
  mrpToDiscount: boolean;
  /** A "Line Total" column can stand in for a blank Price/Rate (unit = total ÷ qty). */
  detectLineTotal: boolean;
}

async function loadImportSettings(): Promise<ImportSettings> {
  const { rows: [r] } = await pool.query<any>(`SELECT general_settings FROM company_settings LIMIT 1`);
  const gs = (r?.general_settings ?? {}) as Record<string, any>;
  return {
    autoCreateCustomers: gs.importAutoCreateCustomers !== false,
    autoCreateVendors: gs.importAutoCreateVendors !== false,
    autoWalkInCustomer: gs.importAutoWalkInCustomer !== false,
    mrpToDiscount: gs.importMrpToDiscount !== false,
    detectLineTotal: gs.importDetectLineTotal !== false,
  };
}

async function loadTxnContext(module: TxnModule, loc: { type: string; id: number }): Promise<TxnContext> {
  const products = new Map<string, TxnProduct[]>();
  const push = (kind: TxnProduct["kind"]) => (r: any) => {
    const key = String(r.name ?? "").trim().toLowerCase();
    if (!key) return;
    const list = products.get(key) ?? [];
    list.push({ kind, id: Number(r.id), name: String(r.name), taxRate: Number(r.tax_rate ?? 0), unit: String(r.unit ?? ""), mrp: Number(r.mrp ?? 0) });
    products.set(key, list);
  };
  const { rows: items } = await pool.query(
    `SELECT id, name, COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(unit, '') AS unit, COALESCE(mrp, 0)::float8 AS mrp FROM items`,
  );
  items.forEach(push("item"));
  if (module === "purchases") {
    const { rows: mats } = await pool.query(
      `SELECT id, name, COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(unit, '') AS unit, 0 AS mrp FROM materials`,
    );
    mats.forEach(push("material"));
    const { rows: raws } = await pool.query(
      `SELECT id, name, COALESCE(tax_rate, 0)::float8 AS tax_rate, COALESCE(unit, '') AS unit, 0 AS mrp FROM raw_materials`,
    );
    raws.forEach(push("raw_material"));
  }

  const parties = new Map<string, TxnParty>();
  const partyTable = module === "sales" ? "customers" : "vendors";
  const { rows: partyRows } = await pool.query(
    `SELECT id, name, COALESCE(gst_number, '') AS gst, COALESCE(state, '') AS state FROM ${partyTable}`,
  );
  for (const r of partyRows) {
    const key = String(r.name ?? "").trim().toLowerCase();
    if (key && !parties.has(key)) parties.set(key, { id: Number(r.id), name: String(r.name), gst: String(r.gst), state: String(r.state) });
  }

  const existingInvoices = new Set<string>();
  if (module === "sales") {
    // Both numbers guard against re-importing the same file: bills renumbered
    // into the SB2B/SB2C series keep their original number in
    // legacy_invoice_number, and the import source still carries the original.
    const { rows } = await pool.query(
      `SELECT lower(invoice_number) AS inv, lower(legacy_invoice_number) AS legacy_inv
         FROM sales WHERE invoice_number IS NOT NULL`
    );
    for (const r of rows) {
      existingInvoices.add(String(r.inv));
      if (r.legacy_inv) existingInvoices.add(String(r.legacy_inv));
    }
  } else {
    const { rows } = await pool.query(`SELECT vendor_id, lower(invoice_number) AS inv FROM purchases WHERE invoice_number IS NOT NULL`);
    for (const r of rows) existingInvoices.add(`${Number(r.vendor_id)}|${String(r.inv)}`);
  }

  const { rows: [comp] } = await pool.query(`SELECT COALESCE(state, '') AS state FROM company_settings LIMIT 1`);

  const stockAvail = new Map<number, number>();
  if (module === "sales") {
    const branchId = loc.type === "headoffice" ? 1 : loc.id;
    const { rows } = await pool.query(
      `SELECT item_id, quantity::float8 AS qty FROM stock_entries
        WHERE material_type = 'item' AND branch_type = $1 AND branch_id = $2`,
      [loc.type, branchId],
    );
    for (const r of rows) stockAvail.set(Number(r.item_id), Number(r.qty));
  }

  return {
    products,
    nameMaps: module === "purchases" ? await buildNameMaps() : ({ material: new Map(), raw_material: new Map(), item: new Map() } as unknown as NameMaps),
    parties, existingInvoices,
    companyState: String(comp?.state ?? "").trim().toLowerCase(),
    stockAvail,
    accounts: module === "purchases"
      ? await importAccountOptions(pool, loc as ProdLocation)
      : [],
    expenseLedgers: module === "purchases" ? await importExpenseLedgerOptions() : new Map(),
    settings: await loadImportSettings(),
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
  /** Unknown party name to be created automatically at commit (toggle). */
  createParty?: { name: string; gst: string } | null;
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
async function loadRowLocationCheck(loc: { type: string; id: number }): Promise<(locRaw: string) => string | null> {
  const [{ rows: whs }, { rows: outs }] = await Promise.all([
    pool.query<any>(`SELECT id, name FROM warehouses`),
    pool.query<any>(`SELECT id, name FROM outlets`),
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
  loc: { type: string; id: number },
): Promise<{
  results: RowVerdict[];
  counts: { valid: number; warning: number; error: number; needsParty: number };
}> {
  const ctx = await loadTxnContext(module, loc);
  const checkRowLoc = await loadRowLocationCheck(loc);
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
    doc.party = doc.partyName ? ctx.parties.get(doc.partyName.toLowerCase()) ?? null : null;

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
      // Unknown named party → created automatically at commit (toggle ON,
      // same create-with-ledger path as the resolve step) or flagged for the
      // resolve step (toggle OFF).
      const auto = module === "sales" ? ctx.settings.autoCreateCustomers : ctx.settings.autoCreateVendors;
      if (auto) {
        let gst = "";
        for (const i of doc.rowIdxs) {
          const g = (rowsIn[i].values.gstNumber ?? "").trim().toUpperCase();
          if (g && GSTIN_RE.test(g)) { gst = g; break; }
        }
        doc.createParty = { name: doc.partyName, gst };
        head.warnings.push(`${partyLabel} "${doc.partyName}" is not in the masters — it will be created automatically (with its ledger) when you press Import. Switch off auto-create under Company Settings → Data Import to review such names instead`);
      } else {
        for (const i of doc.rowIdxs) slots[i].norm.missingParty = doc.partyName;
        head.suggestions.push(`Create "${doc.partyName}" in the resolve step below, or fix the spelling to match an existing ${partyLabel.toLowerCase()}`);
      }
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

    // Product
    const itemName = (values.item ?? "").trim();
    let product: TxnProduct | null = null;
    if (!itemName) {
      s.errors.push("Item is required");
    } else {
      const candidates = ctx.products.get(itemName.toLowerCase()) ?? [];
      if (candidates.length === 0) {
        s.errors.push(`Item "${itemName}" not found in the ${module === "sales" ? "Item Master" : "product masters"}`);
        s.suggestions.push("Create the item first — this import never creates items");
      } else if (candidates.length > 1) {
        s.errors.push(`"${itemName}" exists as ${candidates.map((c) => KIND_LABEL[c.kind]).join(" AND ")} — the name is ambiguous`);
        s.suggestions.push("Rename one of the products so the name is unique, then re-upload");
      } else {
        product = candidates[0];
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
    const anyMissingLine = doc.rowIdxs.some((i) => !slots[i].norm.line);
    if (anyError || anyMissingLine || !doc.dateIso) continue;
    // Walk-in and to-be-created parties still get priced — the preview totals
    // must cover every document that will actually commit. Only unresolved
    // names (auto-create OFF → resolve step) stay unpriced here.
    if (!doc.party && !doc.walkIn && !doc.createParty) continue;

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
        supply = cached ?? await resolveSupplyTaxType(doc.party.id, { type: loc.type, id: loc.id });
        if (!supplyCache.has(doc.party.id)) supplyCache.set(doc.party.id, supply);
      } else {
        // Vendor doesn't exist yet (created at commit) — price intra-state.
        // Inter vs intra only changes the CGST/SGST↔IGST split, never the
        // bill total, so the preview total still matches what commit records.
        supply = { taxType: "intra", why: "new vendor — priced intra-state" };
      }
      const priced = priceBill(
        doc.rowIdxs.map((i) => {
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
      for (const i of doc.rowIdxs) computedQty += Number(slots[i].norm.line.quantity ?? 0);
      // Other Purchase Charges gathered across the bill's rows — they add to
      // what the vendor is owed (and what "Paid" may settle), never to the
      // goods total, the GST cross-check or stock cost.
      const ocs = doc.rowIdxs.map((i) => slots[i].norm.otherCharge).filter(Boolean);
      if (ocs.length > 0) {
        head.norm.otherCharges = ocs.map((c: any) => ({ ledgerId: c.ledgerId, amount: c.amount }));
        otherChargesTot = Math.round(ocs.reduce((t: number, c: any) => t + Number(c.amount), 0) * 100) / 100;
        head.norm.otherChargesTotal = otherChargesTot;
      }
      if (doc.dateIso < todayIso) {
        head.warnings.push("Backdated bill — average cost updates in the ORDER bills are entered, not by bill date; import oldest bills first");
      }
    }

    // File-GST cross-check (sum of CGST/SGST/IGST cells vs computed tax)
    const fileTax = doc.rowIdxs.reduce((t, i) => {
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
        const acct = resolveAccountValue(doc.accountRaw, ctx.accounts);
        if (!acct.ok) head.errors.push(`Payment Account: ${acct.error}`);
        else paidFromLedgerId = acct.account.id;
      }
    }

    head.norm.invoiceNumber = doc.inv;
    head.norm.dateIso = doc.dateIso;
    head.norm.partyName = doc.party ? doc.party.name : doc.walkIn ? "Walk-in customer" : doc.partyName;
    if (doc.party) head.norm.partyId = doc.party.id;
    if (doc.walkIn) head.norm.walkIn = true;
    if (doc.createParty) head.norm.createParty = doc.createParty;
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
  const counts = { valid: 0, warning: 0, error: 0, needsParty: 0 };
  const results: RowVerdict[] = slots.map((s) => {
    const status: RowVerdict["status"] =
      s.errors.length > 0 ? "error"
      : s.norm.missingParty ? "needs_party"
      : s.warnings.length > 0 ? "warning" : "valid";
    if (status === "valid") counts.valid++;
    else if (status === "warning") counts.warning++;
    else if (status === "needs_party") counts.needsParty++;
    else counts.error++;
    const reason = status === "needs_party"
      ? [`${partyLabel} "${s.norm.missingParty}" not found — create it below or fix the name`, ...s.warnings].join("; ")
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
  /** party id → open, in-scope docs in FIFO (oldest-first) order */
  docsByParty: Map<number, VoucherOpenDoc[]>;
  /** `${partyId}|${lower(invoiceNumber)}` → doc (ALL docs, incl. settled/cancelled — for explicit-reference errors) */
  docByRef: Map<string, VoucherOpenDoc>;
}

async function loadVoucherContext(module: VoucherModule, loc: { type: string; id: number }): Promise<VoucherContext> {
  const parties = new Map<string, { id: number; name: string }>();
  const partyTable = module === "receipts" ? "customers" : "vendors";
  const { rows: partyRows } = await pool.query(`SELECT id, name FROM ${partyTable}`);
  for (const r of partyRows) {
    const key = String(r.name ?? "").trim().toLowerCase();
    if (key && !parties.has(key)) parties.set(key, { id: Number(r.id), name: String(r.name) });
  }

  const existingVoucherNos = new Set<string>();
  const vTable = module === "receipts" ? "receipts" : "payments";
  const { rows: vnos } = await pool.query(`SELECT lower(voucher_number) AS v FROM ${vTable} WHERE voucher_number IS NOT NULL`);
  for (const r of vnos) existingVoucherNos.add(String(r.v));

  const accounts = await importAccountOptions(pool, loc as any);

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
    const { rows } = await pool.query(
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
    const { rows } = await pool.query(
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

  return { parties, existingVoucherNos, accounts, docsByParty, docByRef };
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
  loc: { type: string; id: number },
): Promise<{
  results: RowVerdict[];
  counts: { valid: number; warning: number; error: number; needsParty: number };
}> {
  const ctx = await loadVoucherContext(module, loc);
  const checkRowLoc = await loadRowLocationCheck(loc);
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
          s.errors.push(`Voucher number "${vno}" is already recorded in this system`);
          s.suggestions.push("Already migrated or manually entered — remove the row, or renumber if it is genuinely a different voucher");
        }
      }
      s.norm.voucherNo = vno;
    } else {
      s.warnings.push("No voucher number — the next number from the voucher sequence will be assigned at commit");
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

    // Party
    const partyName = (values.party ?? "").trim();
    if (!partyName) s.errors.push(`${partyLabel} is required`);
    const party = partyName ? ctx.parties.get(partyName.toLowerCase()) ?? null : null;
    if (partyName && !party) {
      s.norm.missingParty = partyName;
      s.suggestions.push(`Create "${partyName}" in the resolve step below, or fix the spelling to match an existing ${partyLabel.toLowerCase()}`);
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
    const acc = resolveAccountValue(values.account ?? "", ctx.accounts);
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

    // Planned allocation — explicit-first, else FIFO oldest-first; excess → advance.
    const amountOk = amt !== null && Number.isFinite(amt) && amt > 0;
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
  const counts = { valid: 0, warning: 0, error: 0, needsParty: 0 };
  const results: RowVerdict[] = slots.map((s) => {
    const status: RowVerdict["status"] =
      s.errors.length > 0 ? "error"
      : s.norm.missingParty ? "needs_party"
      : s.warnings.length > 0 ? "warning" : "valid";
    if (status === "valid") counts.valid++;
    else if (status === "warning") counts.warning++;
    else if (status === "needs_party") counts.needsParty++;
    else counts.error++;
    const reason = status === "needs_party"
      ? [`${partyLabel} "${s.norm.missingParty}" not found — create it below or fix the name`, ...s.warnings].join("; ")
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
    missingParty: raw.norm?.missingParty ?? null,
    docIndex: raw.norm?.doc ?? null,
    /** txn imports: this document's party will be auto-created at commit */
    willCreateParty: raw.norm?.createParty?.name ?? null,
    /** txn imports: walk-in counter sale (no customer on the bill) */
    walkIn: raw.norm?.walkIn === true,
    /** voucher imports: planned allocation shown in the preview */
    plan: raw.norm?.plan ?? null,
    /** voucher imports: what commit actually recorded */
    created: raw.created ?? null,
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
  walkInInvoices: number; partiesToCreate: string[];
} {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let invoices = 0, qty = 0, taxable = 0, gst = 0, discount = 0, amount = 0, walkIns = 0;
  const partyKeys = new Set<string>();
  const itemKeys = new Set<string>();
  const toCreate = new Map<string, string>(); // lower(name) → display name
  for (const r of dbRows) {
    const n = r.raw?.norm ?? {};
    if (n.line?.name) itemKeys.add(String(n.line.name).toLowerCase());
    if (!n.head || n.computedTotal == null) continue;
    invoices++;
    amount += Number(n.computedTotal ?? 0);
    gst += Number(n.computedTax ?? 0);
    taxable += Number(n.computedTaxable ?? 0);
    qty += Number(n.computedQty ?? 0);
    discount += Number(n.computedDiscount ?? 0);
    if (n.walkIn === true) walkIns++;
    else if (n.partyId != null) partyKeys.add(`#${n.partyId}`);
    if (n.createParty?.name) {
      const nm = String(n.createParty.name);
      partyKeys.add(nm.toLowerCase());
      toCreate.set(nm.toLowerCase(), nm);
    }
  }
  return {
    invoices, totalQuantity: Math.round(qty * 1000) / 1000,
    totalTaxable: r2(taxable), totalGst: r2(gst),
    totalDiscount: r2(discount), totalAmount: r2(amount),
    distinctParties: partyKeys.size, distinctItems: itemKeys.size,
    walkInInvoices: walkIns, partiesToCreate: [...toCreate.values()].sort((a, b) => a.localeCompare(b)),
  };
}

// ── 1. Sample templates ──────────────────────────────────────────────────────

router.get("/imports/templates/:module", requireModuleAction(PERM, "download"), async (req: Request, res: Response): Promise<void> => {
  const module = asModule(req.params.module);
  if (!module) { res.status(400).json({ error: `Unknown import module — use one of: ${MODULES.join(", ")}` }); return; }
  const spec = TEMPLATES[module];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(spec.title);

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
    help.addRow([`• Items must already exist in the masters — unknown items are errors. Unknown ${party.toLowerCase()}s are created automatically at import (with their ledgers), or via the resolve step when auto-create is switched off in Company Settings → Data Import.`]);
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
    help.addRow(["• Voucher numbers are kept exactly as supplied and must be unique; blank rows draw the next number from the voucher sequence."]);
    help.addRow(["• Dates: YYYY-MM-DD or DD/MM/YYYY."]);
    help.addRow([`• Unknown ${party.toLowerCase()}s can be created during the import (resolve step). Import the ${docWord}s FIRST so allocation finds them.`]);
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

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(body as any);
    } catch {
      res.status(400).json({ error: "That file could not be read as an Excel (.xlsx) workbook. Download the sample and fill it in." });
      return;
    }
    const ws = wb.worksheets[0];
    if (!ws || ws.rowCount < 2) {
      res.status(400).json({ error: "The first sheet has no data rows below the header." }); return;
    }

    // Map headers → column keys via the alias table.
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
      res.status(400).json({
        error: `Required column${missingRequired.length > 1 ? "s" : ""} not found: ${missingRequired.map((c) => c.header).join(", ")}. Keep the sample's header row unchanged.`,
      });
      return;
    }

    // Transaction AND voucher imports must know WHERE the documents land
    // before anything is validated — stock checks, ledgers, allocation scope
    // and duplicates are all per-location. The location is a request,
    // resolveActingLocation is the authority.
    let txnLoc: { type: string; id: number } | null = null;
    if (isTxnModule(module) || isVoucherModule(module)) {
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
    };

    // Walk data rows. Row numbers reported to the user are SPREADSHEET rows.
    const parsed: Array<{ rowNumber: number; values: Record<string, string>; verdict: RowVerdict }> = [];
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
        res.status(400).json({ error: `That file has more than ${MAX_ROWS} rows — split it into smaller files.` });
        return;
      }
      parsed.push({
        rowNumber: rn, values,
        // Txn/voucher rows are validated as a whole file below (grouping and
        // running allocation both need order).
        verdict: isTxnModule(module) || isVoucherModule(module)
          ? { status: "valid", reason: null, suggestion: null, duplicateOfId: null, norm: {} }
          : validateRow(module, rn, values, ctx),
      });
    }
    if (parsed.length === 0) {
      res.status(400).json({ error: "No data rows found below the header." }); return;
    }

    if (isTxnModule(module) && txnLoc) {
      const { results } = await validateTransactionRows(
        module, parsed.map((p) => ({ rowNumber: p.rowNumber, values: p.values })), txnLoc,
      );
      parsed.forEach((p, i) => { p.verdict = results[i]; });
    }
    if (isVoucherModule(module) && txnLoc) {
      const { results } = await validateVoucherRows(
        module, parsed.map((p) => ({ rowNumber: p.rowNumber, values: p.values })), txnLoc,
      );
      parsed.forEach((p, i) => { p.verdict = results[i]; });
    }

    const counts = { valid: 0, warning: 0, error: 0 };
    for (const p of parsed) counts[p.verdict.status === "needs_party" ? "error" : p.verdict.status]++;

    const emp = (req as any).employee as { branchType?: string; branchId?: number } | undefined;
    const { rows: [batch] } = await pool.query(
      `INSERT INTO import_batches (module, filename, status, total_rows, valid_rows, warning_rows, error_rows, created_by, location_type, location_id)
       VALUES ($1, $2, 'validated', $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [module, filename, parsed.length, counts.valid, counts.warning, counts.error,
       username(req),
       txnLoc?.type ?? emp?.branchType ?? "headoffice",
       txnLoc?.id ?? emp?.branchId ?? 0],
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

// ── 2b. Resolve missing parties (sales & purchases) ─────────────────────────
// Creates the missing customers/vendors through the SAME code path as manual
// creation (ledgers auto-provisioned, location stamped), then re-validates the
// whole batch from the stored raw values — no re-upload needed.

router.post("/imports/batches/:id/resolve-parties", requireModuleAction(PERM, "add"), async (req: Request, res: Response): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { rows: [batch] } = await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
  if (!batch) { res.status(404).json({ error: "Import batch not found" }); return; }
  const module = asModule(batch.module);
  if (!module || (!isTxnModule(module) && !isVoucherModule(module))) {
    res.status(400).json({ error: "Only sales, purchase, receipt and payment imports have a party-resolution step." }); return;
  }
  if (batch.status !== "validated") {
    res.status(409).json({ error: "Parties can only be created while the batch is awaiting commit." }); return;
  }

  const body = (req.body ?? {}) as { parties?: unknown };
  const partiesIn = Array.isArray(body.parties) ? body.parties : [];
  if (partiesIn.length === 0) { res.status(400).json({ error: "Pass parties: [{ name, gstNumber?, phone?, state?, address?, creditLimit? }]" }); return; }
  if (partiesIn.length > 500) { res.status(400).json({ error: "Too many parties in one request." }); return; }

  const stamp = { type: String(batch.location_type ?? "headoffice"), id: Number(batch.location_id ?? 0) };
  const user = username(req);
  const partyIsCustomer = module === "sales" || module === "receipts";
  const table = partyIsCustomer ? "customers" : "vendors";
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ name: string; reason: string }> = [];

  for (const p of partiesIn as any[]) {
    const name = String(p?.name ?? "").trim();
    if (!name || name.length < 2) { errors.push({ name: name || "(blank)", reason: "Name must be at least 2 characters" }); continue; }
    const gst = String(p?.gstNumber ?? "").trim().toUpperCase();
    if (gst && !GSTIN_RE.test(gst)) { errors.push({ name, reason: `GSTIN "${gst}" is not a valid 15-character GSTIN` }); continue; }
    const phone = parsePhone(String(p?.phone ?? "").trim());
    if (phone === "invalid") { errors.push({ name, reason: `Phone "${p?.phone}" is not a 10-digit number` }); continue; }
    const state = String(p?.state ?? "").trim();
    const address = String(p?.address ?? "").trim();

    // Someone may have created it since the preview rendered — that is fine,
    // the re-validation below will pick the existing record up.
    const { rows: [dupe] } = await pool.query(`SELECT id FROM ${table} WHERE lower(name) = lower($1) LIMIT 1`, [name]);
    if (dupe) { skipped.push(name); continue; }

    try {
      const input: any = {
        name,
        ...(gst ? { gstNumber: gst } : {}),
        ...(phone ? { phone } : {}),
        ...(state ? { state } : {}),
        ...(address ? { address } : {}),
        notes: `Created during import batch #${id}`,
      };
      const { row } = partyIsCustomer
        ? await createCustomerWithLedger(input, stamp)
        : await createVendorWithLedger(input, stamp);
      const cl = Number(p?.creditLimit ?? NaN);
      if (partyIsCustomer && Number.isFinite(cl) && cl > 0) {
        await pool.query(`UPDATE customers SET credit_limit = $1 WHERE id = $2`, [Math.round(cl * 100) / 100, row.id]);
      }
      created.push(name);
    } catch (e: any) {
      errors.push({ name, reason: String(e?.message ?? e).slice(0, 300) });
    }
  }

  // Full re-validation from the stored raw values — grouping, duplicates and
  // totals are all order-dependent, so the whole file runs again.
  const { rows: importRows } = await pool.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id]);
  const rowsIn = importRows.map((r: any) => ({ rowNumber: Number(r.row_number), values: (r.raw?.values ?? {}) as Record<string, string> }));
  const { results, counts } = isVoucherModule(module)
    ? await validateVoucherRows(module, rowsIn, stamp)
    : await validateTransactionRows(module, rowsIn, stamp);
  for (let i = 0; i < importRows.length; i++) {
    const v = results[i];
    await pool.query(
      `UPDATE import_rows SET status = $2, reason = $3, suggestion = $4, raw = $5 WHERE id = $1`,
      [importRows[i].id, v.status, v.reason, v.suggestion,
       JSON.stringify({ values: rowsIn[i].values, norm: v.norm })],
    );
  }
  const { rows: [updated] } = await pool.query(
    `UPDATE import_batches SET valid_rows = $2, warning_rows = $3, error_rows = $4 WHERE id = $1 RETURNING *`,
    [id, counts.valid, counts.warning, counts.error + counts.needsParty],
  );
  const { rows: outRows } = await pool.query(`SELECT * FROM import_rows WHERE batch_id = $1 ORDER BY row_number`, [id]);

  logActivity({
    action: "CREATE", module: "imports", entityType: "import_batch", entityId: id,
    description: `Resolved parties for ${module} import "${batch.filename}" — ${created.length} created, ${skipped.length} already existed${errors.length ? `, ${errors.length} failed` : ""}`,
    user,
  }).catch(() => {});

  res.json({
    batch: batchJson(updated), rows: outRows.map(rowJson), created, skipped, errors,
    ...(isTxnModule(module) ? { summary: txnBatchSummary(outRows) } : {}),
  });
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
  const [{ rows }, nameOf] = await Promise.all([
    pool.query(`SELECT * FROM import_batches ORDER BY id DESC LIMIT 200`),
    locationNameResolver(),
  ]);
  res.json({ batches: rows.map((b: any) => ({ ...batchJson(b), locationName: nameOf(b) })) });
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
    `SELECT * FROM import_rows WHERE batch_id = $1 AND status IN ('error', 'needs_party', 'failed') ORDER BY row_number`,
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
  // Parties auto-created during a txn commit (auto-create toggle) — reported
  // back so the UI can say exactly which masters appeared.
  const partiesCreated: Array<{ id: number; name: string }> = [];

  const setRow = (rowId: number, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    return pool.query(`UPDATE import_rows SET ${sets} WHERE id = $1`, [rowId, ...keys.map((k) => fields[k])]);
  };

  if (isTxnModule(module)) {
    // ── Transaction commit: whole DOCUMENTS, not rows ──
    // Each document commits in its own transaction through the same logic as
    // manual entry (lib/importTransactions). A failed document marks only its
    // own rows failed; the rest of the batch continues — same per-record
    // semantics as the masters loop.
    const loc = {
      type: String(batch.location_type ?? "headoffice"),
      id: Number(batch.location_id ?? 0) || (String(batch.location_type ?? "headoffice") === "headoffice" ? 1 : 0),
    };

    const docsMap = new Map<number, any[]>();
    for (const r of importRows) {
      const d = Number(r.raw?.norm?.doc ?? -1);
      if (!docsMap.has(d)) docsMap.set(d, []);
      docsMap.get(d)!.push(r);
    }

    // Parties stamped `createParty` at validation (auto-create toggle) are
    // created here, once per distinct name, through the SAME create-with-
    // ledger path as the resolve step. Existence is re-checked at commit —
    // someone may have created the party since validation.
    const partyTable = module === "sales" ? "customers" : "vendors";
    const createdPartyIds = new Map<string, number>(); // lower(name) → id
    const ensureParty = async (cp: { name?: string; gst?: string }): Promise<number> => {
      const name = String(cp?.name ?? "").trim();
      if (name.length < 2) throw new Error(`Cannot create ${module === "sales" ? "customer" : "vendor"} "${name || "(blank)"}" — name too short`);
      const key = name.toLowerCase();
      const cached = createdPartyIds.get(key);
      if (cached !== undefined) return cached;
      // Advisory lock on the normalised name: two batches committing the
      // same unknown party concurrently would both pass a bare check-then-
      // create and make duplicate masters. The lock serialises the check.
      const lockClient = await pool.connect();
      try {
        await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [`import-party:${partyTable}:${key}`]);
        const { rows: [dupe] } = await pool.query(`SELECT id FROM ${partyTable} WHERE lower(name) = lower($1) LIMIT 1`, [name]);
        if (dupe) { createdPartyIds.set(key, Number(dupe.id)); return Number(dupe.id); }
        const gst = String(cp?.gst ?? "").trim().toUpperCase();
        const input: any = {
          name,
          ...(gst && GSTIN_RE.test(gst) ? { gstNumber: gst } : {}),
          notes: `Created automatically during import batch #${id}`,
        };
        const { row } = module === "sales"
          ? await createCustomerWithLedger(input, stamp)
          : await createVendorWithLedger(input, stamp);
        createdPartyIds.set(key, Number(row.id));
        partiesCreated.push({ id: Number(row.id), name });
        return Number(row.id);
      } finally {
        await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`import-party:${partyTable}:${key}`]).catch(() => {});
        lockClient.release();
      }
    };

    // FILE ORDER, deliberately: average cost and stock consequences follow
    // entry order, and the preview warned about backdating. Never re-sort.
    for (const dIdx of [...docsMap.keys()].sort((a, b) => a - b)) {
      const docRows = docsMap.get(dIdx)!;
      const head = docRows.find((r) => r.raw?.norm?.head) ?? docRows[0];
      const hn = (head.raw?.norm ?? {}) as Record<string, any>;
      const label = String(hn.invoiceNumber || "") || `rows ${docRows[0].row_number}–${docRows[docRows.length - 1].row_number}`;

      // A document may commit with: a resolved party id, a walk-in flag
      // (sales, no customer), or a validation-stamped party to create now.
      const walkIn = module === "sales" && hn.walkIn === true;
      const willCreate = hn.partyId == null && !walkIn && !!hn.createParty?.name;
      const hasBad = docRows.some((r) => r.status === "error" || r.status === "needs_party");
      const userSkip = docRows.some((r) => skipSet.has(Number(r.id)));
      if (dIdx < 0 || hasBad || userSkip || (hn.partyId == null && !walkIn && !willCreate)) {
        counts.skipped += docRows.length;
        for (const r of docRows) {
          if (r.status === "error" || r.status === "needs_party") continue; // keep the verdict text
          await setRow(r.id, {
            status: "skipped",
            reason: userSkip ? "Skipped by user at commit"
              : (hn.partyId == null && !walkIn && !willCreate) ? "Skipped — the document's party was never resolved"
              : "Skipped — another row of this invoice has errors",
          });
        }
        continue;
      }

      try {
        // Auto-create the party first (throws → the whole document fails,
        // same per-document semantics as any other commit error).
        const resolvedPartyId: number | null = hn.partyId != null
          ? Number(hn.partyId)
          : willCreate ? await ensureParty(hn.createParty) : null;

        if (module === "sales") {
          const invoiceNumber = String(hn.invoiceNumber || "") || `IMP-${id}-${dIdx + 1}`;
          const result = await importSaleDoc({
            invoiceNumber,
            saleDate: String(hn.dateIso),
            customerId: resolvedPartyId, // null = walk-in counter sale
            lines: docRows.map((r) => {
              const l = r.raw?.norm?.line ?? {};
              // New batches carry `unitDiscount` (per-unit ₹, GST-inclusive
              // price). Batches validated before that convention carry the
              // legacy `discount` (line-total ₹, GST-exclusive price) — they
              // must commit with the math their preview showed.
              return l.unitDiscount !== undefined
                ? { itemId: Number(l.id), quantity: Number(l.quantity), unitPrice: Number(l.price ?? 0), unitDiscount: Number(l.unitDiscount ?? 0), priceMode: "inclusive" as const }
                : { itemId: Number(l.id), quantity: Number(l.quantity), unitPrice: Number(l.price ?? 0), discount: Number(l.discount ?? 0), priceMode: "exclusive" as const };
            }),
            billDiscount: Number(hn.billDiscount ?? 0),
            paymentMode: (hn.paymentMode ?? "credit") as "cash" | "bank" | "upi" | "credit",
            paidAmount: Number(hn.paidAmount ?? 0),
            reference: hn.reference ?? null,
            loc, user,
          });
          // Batch provenance stamps — the bill, its sale-trail receipt (named
          // after the NEW invoice number) and any clearing receipts.
          await pool.query(`UPDATE sales SET import_batch_id = $1 WHERE id = $2`, [id, result.saleId]);
          await pool.query(
            `UPDATE receipts SET import_batch_id = $1
              WHERE (voucher_number = $2 OR id = ANY($3::int[])) AND import_batch_id IS NULL`,
            [id, result.invoiceNumber, result.clearingReceiptIds ?? []],
          );
          counts.imported += docRows.length;
          for (const r of docRows) {
            await setRow(r.id, { status: "imported", reason: null, created_record_type: "sale", created_record_id: result.saleId });
          }
          // Settlement ids ride on the head row so rollback can tell OUR
          // payments/receipts from any collected later.
          await pool.query(`UPDATE import_rows SET raw = raw || $2::jsonb WHERE id = $1`, [head.id, JSON.stringify({
            created: {
              invoiceNumber: result.invoiceNumber, totalAmount: result.totalAmount,
              salePaymentIds: result.salePaymentIds, clearingReceiptIds: result.clearingReceiptIds,
            },
          })]);
        } else {
          if (resolvedPartyId == null) throw new Error("Purchase bills always need a vendor"); // unreachable — validation guarantees it
          const result = await importPurchaseDoc({
            invoiceNumber: String(hn.invoiceNumber || "") || null,
            purchaseDate: String(hn.dateIso),
            vendorId: resolvedPartyId,
            lines: docRows.map((r) => {
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
          });
          // Batch provenance stamps — the bill and its settlement payment.
          await pool.query(`UPDATE purchases SET import_batch_id = $1 WHERE id = $2`, [id, result.purchaseId]);
          if (result.paymentId) {
            await pool.query(`UPDATE payments SET import_batch_id = $1 WHERE id = $2`, [id, result.paymentId]);
          }
          counts.imported += docRows.length;
          for (const r of docRows) {
            await setRow(r.id, { status: "imported", reason: null, created_record_type: "purchase", created_record_id: result.purchaseId });
          }
          await pool.query(`UPDATE import_rows SET raw = raw || $2::jsonb WHERE id = $1`, [head.id, JSON.stringify({
            created: { totalAmount: result.totalAmount, paymentId: result.paymentId },
          })]);
        }
      } catch (e: any) {
        counts.failed += docRows.length;
        const reason = String(e?.message ?? e).slice(0, 400);
        failures.push({ rowNumber: Number(head.row_number), name: label, reason });
        for (const r of docRows) await setRow(r.id, { status: "failed", reason }).catch(() => {});
      }
    }
  } else if (isVoucherModule(module)) {
    // ── Voucher commit: one row = one voucher ──
    // Each voucher commits in its own transaction through the same settlement
    // primitives as the manual allocation routes (lib/importVouchers).
    // Allocation is RECOMPUTED on locked rows at commit time with the same
    // explicit-first / FIFO rules — the preview's plan was a snapshot, and
    // outstanding figures may have moved since validation.
    const loc = {
      type: String(batch.location_type ?? "headoffice"),
      id: Number(batch.location_id ?? 0),
    };

    for (const r of importRows) {
      const norm = (r.raw?.norm ?? {}) as Record<string, any>;
      const label = String(norm.voucherNo || "") || `row ${r.row_number}`;
      if (r.status === "error" || r.status === "needs_party") {
        counts.skipped++; // keep the verdict text
        continue;
      }
      if (skipSet.has(Number(r.id))) {
        counts.skipped++;
        await setRow(r.id, { status: "skipped", reason: "Skipped by user at commit" });
        continue;
      }
      if (norm.partyId == null || norm.accountLedgerId == null || !norm.dateIso || !(Number(norm.amount) > 0)) {
        counts.skipped++;
        await setRow(r.id, { status: "skipped", reason: "Skipped — the row was never fully validated" });
        continue;
      }
      try {
        const common = {
          voucherNumber: norm.voucherNo ? String(norm.voucherNo) : null,
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
            })
          : await importPaymentVoucher({
              ...common,
              vendorId: Number(norm.partyId), vendorName: String(norm.partyName ?? ""),
              explicitPurchaseId: norm.explicitPurchaseId != null ? Number(norm.explicitPurchaseId) : null,
            });
        counts.imported++;
        // Batch provenance stamp (module name === table name here).
        await pool.query(`UPDATE ${module} SET import_batch_id = $1 WHERE id = $2`, [id, result.id]);
        await setRow(r.id, {
          status: "imported", reason: null,
          created_record_type: module === "receipts" ? "receipt" : "payment",
          created_record_id: result.id,
        });
        // What commit ACTUALLY recorded — the preview plan stays in norm.plan
        // for comparison; rollback needs only created_record_id.
        await pool.query(`UPDATE import_rows SET raw = raw || $2::jsonb WHERE id = $1`, [r.id, JSON.stringify({
          created: {
            voucherNumber: result.voucherNumber,
            allocations: result.allocations,
            advanceAmount: result.advanceAmount,
          },
        })]);
      } catch (e: any) {
        counts.failed++;
        const reason = String(e?.message ?? e).slice(0, 400);
        failures.push({ rowNumber: Number(r.row_number), name: label, reason });
        await setRow(r.id, { status: "failed", reason }).catch(() => {});
      }
    }
  } else {
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
    // One stock movement per imported invoice LINE (sales/purchase imports).
    stockMovements: isTxnModule(module) ? counts.imported : 0,
    // Books are DERIVED from the documents themselves — imports create no
    // separate journal vouchers. Reported explicitly so the figure is honest.
    journalEntriesCreated: 0,
    receiptsCreated: rc.receipts,
    paymentsCreated: rc.payments,
    gstInvoices: Number(gstRow?.n ?? 0),
    timeTakenMs: Date.now() - commitStartedAt,
  };

  res.json({ batch: batchJson(finished), summary: counts, failures, details, partiesCreated });
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
       (SELECT COUNT(*) FROM payments         WHERE import_batch_id = $1)::int AS "payments"`,
    [batchId],
  );
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r ?? {})) out[k] = Number(v);
  return out;
}

const COUNT_LABELS: Array<[string, string]> = [
  ["customers", "customers"], ["vendors", "vendors"], ["ledgers", "ledgers"],
  ["openingBalances", "opening balances"], ["sales", "sales invoices"],
  ["purchases", "purchase bills"], ["receipts", "receipts"], ["payments", "payments"],
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

export default router;
