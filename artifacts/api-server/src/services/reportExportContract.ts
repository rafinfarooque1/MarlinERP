import { z } from "zod";
import { isIsoDate } from "../lib/dateInput";

const dates = { from: z.string().refine(isIsoDate), to: z.string().refine(isIsoDate) };
const location = {
  locationType: z.enum(["all", "headoffice", "warehouse", "outlet"]),
  locationId: z.number().int().nonnegative(),
};
const range = { ...dates, ...location };
const id = z.number().int().positive();
const schemas = {
  pnl: z.object(range).partial().strict(),
  trading: z.object(range).partial().strict(),
  "balance-sheet": z.object(range).partial().strict(),
  "trial-balance": z.object(range).partial().strict(),
  "day-book": z.object(range).partial().strict(),
  ledgers: z.object(range).partial().strict(),
  "ledger-statement": z.object({ ...range, ledgerId: id }).partial().required({ ledgerId: true }).strict(),
  cash: z.object({ ...range, ledgerId: id }).partial().strict(),
  bank: z.object({ ...range, ledgerId: id }).partial().strict(),
  "cash-bank": z.object({ ...range, ledgerId: id }).partial().strict(),
  "stock-valuation": z.object({
    ...location, asOf: z.string().refine(isIsoDate),
    materialType: z.enum(["item", "material", "raw_material"]),
    search: z.string().max(200),
  }).partial().strict(),
  receivables: z.object({ ...location, asOf: z.string().refine(isIsoDate) }).partial().strict(),
  payables: z.object({ ...location, asOf: z.string().refine(isIsoDate) }).partial().strict(),
  "bank-reconciliation": z.object({
    ...range, bankAccountId: id, search: z.string().max(200),
    status: z.enum(["all", "reconciled", "unreconciled"]),
  }).partial().strict(),
};
export type CanonicalReportId = keyof typeof schemas;
export type ReportFilters = Record<string, string | number>;
export interface CanonicalReportRequest {
  reportId: CanonicalReportId;
  filters: ReportFilters;
  display: { expandedKeys?: string[]; monthWise?: boolean };
}
export class ReportExportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Strictly accept filter/presentation intent; never client-authored data or URLs. */
export function parseReportRequest(body: unknown): CanonicalReportRequest {
  const envelope = z.object({
    reportId: z.string(),
    filters: z.record(z.string(), z.unknown()).default({}),
    display: z.object({
      expandedKeys: z.array(z.string().max(300)).max(3000).optional(),
      monthWise: z.boolean().optional(),
    }).strict().default({}),
  }).strict().safeParse(body);
  if (!envelope.success) throw new ReportExportError(400, "Expected reportId, validated filters and optional display state only; prepared rows are not accepted.");
  const { reportId, filters, display } = envelope.data;
  if (!Object.hasOwn(schemas, reportId)) throw new ReportExportError(400, "Unknown canonical reportId");
  const parsed = schemas[reportId as CanonicalReportId].safeParse(filters);
  if (!parsed.success) throw new ReportExportError(400, `Invalid filters: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const f = parsed.data as ReportFilters;
  if (f.from && f.to && f.from > f.to) throw new ReportExportError(400, "from must not be later than to");
  if (["warehouse", "outlet"].includes(String(f.locationType)) && (!Number.isInteger(f.locationId) || Number(f.locationId) <= 0)) {
    throw new ReportExportError(400, "A positive locationId is required for the selected location");
  }
  if (f.locationId !== undefined && !f.locationType) throw new ReportExportError(400, "locationId requires locationType");
  if (display.monthWise) throw new ReportExportError(422, "Canonical Month Wise export is not yet supported. Use the existing Month Wise statement export; it is explicitly marked client-prepared.");
  if (display.expandedKeys && !["pnl", "trading", "balance-sheet"].includes(reportId)) {
    throw new ReportExportError(422, "Expanded state is supported only for financial statements");
  }
  return { reportId: reportId as CanonicalReportId, filters: f, display };
}

export function reportDownloadPages(id: CanonicalReportId): string[] {
  if (id === "stock-valuation") return ["page:/headoffice/inventory-reports"];
  if (id === "receivables") return ["page:/outstanding", "page:/customers"];
  if (id === "payables") return ["page:/outstanding", "page:/vendors"];
  if (id === "bank-reconciliation") return ["page:/accounts/reconciliation"];
  if (["pnl", "trading", "balance-sheet"].includes(id)) return ["page:/reports/sales", "page:/accounts/chart"];
  return ["page:/reports/sales"];
}