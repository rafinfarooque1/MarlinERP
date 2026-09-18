import type { CanonicalReportRequest } from "./reportExportContract";
import { ReportExportError } from "./reportExportContract";
import type { ReportPdfInput, ReportSection } from "./reportPdf";

type Field = [key: string, label: string, numeric?: boolean];
const text = (value: unknown): string => value == null ? "" : String(value);
function amount(value: unknown): number | string {
  if (value == null) return ""; // Missing evidence is not zero.
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ReportExportError(422, "Canonical source contains a non-finite report value");
  return n;
}
function table(heading: string, rows: any[], fields: Field[], totals?: any): ReportSection {
  if (!Array.isArray(rows)) throw new ReportExportError(502, `Canonical source is missing ${heading} rows`);
  return {
    heading,
    columns: fields.map(([, label, numeric]) => ({ label, align: numeric ? "right" : "left", valueType: numeric ? "number" : "text" })),
    rows: rows.map(row => fields.map(([key, , numeric]) => numeric ? amount(row[key]) : text(row[key]))),
    ...(totals ? { totalsRow: fields.map(([key, , numeric], i) => i === 0 ? "Total" : numeric ? amount(totals[key]) : "") } : {}),
  };
}
function summary(heading: string, values: Record<string, unknown>): ReportSection {
  return {
    heading, columns: [{ label: "Particulars" }, { label: "Value", align: "right" }],
    rows: Object.entries(values).filter(([, v]) => v != null && typeof v !== "object")
      .map(([key, value]) => [key, typeof value === "number" ? amount(value) : text(value)]),
  };
}

/** Presentation of server values only. This layer never rebuilds balances,
 * computes financial totals, or reads arbitrary client-provided fields. */
export function canonicalDocument(request: CanonicalReportRequest, payload: any): ReportPdfInput {
  const { reportId, filters, display } = request;
  if (!payload || typeof payload !== "object") throw new ReportExportError(502, "Canonical source returned an invalid payload");
  const sections: ReportSection[] = [];
  const warnings: string[] = [];
  const titles: Record<typeof reportId, string> = {
    pnl: "Profit & Loss Statement", trading: "Trading Account", "balance-sheet": "Balance Sheet",
    "trial-balance": "Trial Balance", "day-book": "Day Book", ledgers: "General Ledger",
    "ledger-statement": "Ledger Statement", cash: "Cash Book", bank: "Bank Book", "cash-bank": "Cash & Bank Book",
    "stock-valuation": "Stock Valuation", receivables: "Receivables Ageing", payables: "Payables Ageing",
    "bank-reconciliation": "Bank Reconciliation",
  };
  const groupRows = (group: any): (string | number)[][] => {
    if (!group) throw new ReportExportError(502, "Canonical statement group is missing");
    const root = `g:${group.id ?? group.code ?? group.name}`;
    const expanded = display.expandedKeys ? new Set(display.expandedKeys) : null;
    const rows: (string | number)[][] = [[text(group.name), amount(group.total)]];
    const walk = (nodes: any[], parent: string, depth: number) => {
      if (expanded && !expanded.has(parent)) return;
      for (const node of nodes ?? []) {
        if (Math.abs(Number(node.balance)) <= 0.005) continue;
        const key = `${parent}/${node.id}`;
        rows.push([`${"   ".repeat(depth)}${node.name}`, amount(node.balance)]);
        walk(node.children, key, depth + 1);
      }
    };
    walk(group.children, root, 1);
    return rows;
  };
  const statement = (heading: string, rows: (string | number)[][], total: unknown) => sections.push({
    heading, columns: [{ label: "Particulars", width: 3 }, { label: "Amount", align: "right" }],
    rows, totalsRow: ["Total", amount(total)],
  });
  if (["pnl", "trading", "balance-sheet"].includes(reportId)) {
    const pl = payload.profitAndLoss;
    if (!pl?.summary) throw new ReportExportError(502, "Canonical financial summary is missing");
    const e = pl.expenses, i = pl.incomes;
    for (const [reliable, note] of [[e.openingStockReliable, e.openingStockNote], [i.closingStockReliable, i.closingStockNote]]) {
      if (reliable === false) warnings.push(note || "Historical stock evidence is incomplete.");
    }
    if (payload.integrity?.issues) warnings.push(...payload.integrity.issues);
    if (payload.integrity?.balanced === false) warnings.push(`Books do not balance. Difference: ${payload.integrity.difference}`);
    if (reportId === "balance-sheet") {
      const b = payload.balanceSheet;
      statement("Liabilities", [
        ...groupRows(b.liabilities.capitalAccount),
        ["Reserves & Surplus (P&L)", amount(b.liabilities.pandlCarryForward)],
        ...groupRows(b.liabilities.loans), ...groupRows(b.liabilities.currentLiabilities),
      ], b.liabilities.total);
      statement("Assets", [
        ...groupRows(b.assets.fixedAssets), ["Closing Stock", amount(b.assets.closingStock)], ...groupRows(b.assets.currentAssets),
      ], b.assets.total);
    } else {
      // Read the canonical summary, not an independent export COGS/GP/NP formula.
      sections.push(summary("Authoritative financial summary", {
        "Gross Sales": i.grossSales, "Sales Returns": i.salesReturns, "Net Sales": i.sales,
        "Opening Stock": e.openingStock, "Net Purchases": e.purchases,
        "Direct Expenses": e.directExpenses.total, "Closing Stock": i.closingStock,
        "Closing Stock In Transit": i.closingStockInTransit,
        "Cost of Goods Sold (COGS)": pl.summary.costOfGoodsSold, "Gross Profit": pl.summary.grossProfit,
        ...(reportId === "pnl" ? {
          "Other Income": pl.summary.otherIncome, "Operating Expenses": pl.summary.operatingExpenses,
          "Net Profit": pl.summary.netProfit,
        } : {}),
      }));
      if (reportId === "pnl") {
        statement("Expenses", [["Opening Stock", amount(e.openingStock)], ["Purchases", amount(e.purchases)], ...groupRows(e.directExpenses), ...groupRows(e.indirectExpenses)], e.total);
        statement("Incomes", [["Sales (net of GST)", amount(i.sales)], ["Closing Stock", amount(i.closingStock)], ...groupRows(i.directIncomes), ...groupRows(i.indirectIncomes)], i.total);
      }
    }
  } else if (reportId === "trial-balance") {
    sections.push(table("Trial Balance", payload.rows, [["groupName", "Group"], ["name", "Ledger"], ["debit", "Debit", true], ["credit", "Credit", true]], { debit: payload.totalDebit, credit: payload.totalCredit }));
    sections.push(summary("Control totals", { Debit: payload.totalDebit, Credit: payload.totalCredit, Difference: payload.difference, Balanced: payload.balanced }));
  } else if (reportId === "day-book") {
    sections.push(table("Entries", payload.entries, [["date", "Date"], ["voucherNumber", "Voucher"], ["source", "Type"], ["particulars", "Particulars"], ["debit", "Debit", true], ["credit", "Credit", true], ["amount", "Amount", true]], payload.totals));
  } else if (reportId === "ledgers") {
    sections.push(table("Ledgers", payload.rows, [["name", "Ledger"], ["groupName", "Group"], ["opening", "Opening", true], ["debit", "Debit", true], ["credit", "Credit", true], ["closing", "Closing", true]], payload.totals));
  } else if (["cash", "bank", "cash-bank"].includes(reportId)) {
    sections.push(summary("Balances", { Account: payload.scope?.name, Opening: payload.openingBalance, Receipts: payload.totalReceipts, Payments: payload.totalPayments, Closing: payload.closingBalance }));
    sections.push(table("Entries", payload.entries, [["date", "Date"], ["voucherNumber", "Voucher"], ["account", "Account"], ["description", "Description"], ["receipt", "Receipt", true], ["payment", "Payment", true], ["balance", "Balance", true]]));
  } else if (reportId === "ledger-statement") {
    sections.push(summary("Balances", { Opening: payload.openingBalance, Debit: payload.totalDebit, Credit: payload.totalCredit, Closing: payload.closingBalance }));
    sections.push(table("Entries", payload.entries, [["date", "Date"], ["voucherNumber", "Voucher"], ["description", "Description"], ["debit", "Debit", true], ["credit", "Credit", true], ["balance", "Balance", true]]));
  } else if (reportId === "stock-valuation") {
    const rows = filters.search ? payload.rows.filter((r: any) => text(r.itemName).toLowerCase().includes(text(filters.search).toLowerCase())) : payload.rows;
    sections.push(table("Stock at cost", rows, [["branchName", "Location"], ["typeLabel", "Type"], ["itemName", "Product"], ["unit", "Unit"], ["quantity", "Quantity", true], ["reserved", "Reserved", true], ["available", "Available", true], ["unitCost", "Unit Cost", true], ["value", "Value", true]]));
    sections.push(summary("Scope totals (before text search)", { "On Hand": payload.onHandValue, "In Transit": payload.inTransitValue, "Grand Total": payload.grandTotal }));
    if (payload.reliability) sections.push(summary("Valuation evidence", payload.reliability));
    if (payload.warnings) warnings.push(...payload.warnings.map(text));
  } else if (reportId === "receivables" || reportId === "payables") {
    const receivable = reportId === "receivables";
    sections.push(table("Ageing", payload[receivable ? "customers" : "vendors"], [
      [receivable ? "customerName" : "vendorName", receivable ? "Customer" : "Vendor"],
      ["b0_30", "0–30 Days", true], ["b31_60", "31–60 Days", true], ["b61_90", "61–90 Days", true], ["b90p", "90+ Days", true],
      ["totalDue", "Aged Due", true], ["unallocatedCredit", "Unallocated Credit", true], ["netDue", "Net Due", true],
    ], payload.totals));
    sections.push(summary("Settlement control", { "As Of": payload.asOf, Basis: payload.basis, ...payload.totals }));
  } else if (reportId === "bank-reconciliation") {
    const rows = filters.status && filters.status !== "all"
      ? payload.transactions.filter((r: any) => r.reconciliationStatus === filters.status) : payload.transactions;
    sections.push(table("Bank transactions", rows, [
      ["date", "Date"], ["voucherNumber", "Voucher"], ["accountName", "Bank Account"], ["accountLocationName", "Location"],
      ["description", "Description"], ["debit", "Debit", true], ["credit", "Credit", true], ["amount", "Amount", true],
      ["reconciliationStatus", "Status"],
    ]));
    sections.push(summary("Eligible scope totals (all statuses)", payload.totals));
  }
  if (payload.companyLevel) sections.push(summary("Unattributed company-level entries excluded from location slice", payload.companyLevel));
  if (warnings.length) sections.push(summary("Warnings", Object.fromEntries(warnings.map((w, i) => [`Warning ${i + 1}`, w]))));
  return {
    title: titles[reportId], orientation: "landscape", sections,
    metaRows: Object.entries(filters).map(([k, v]) => [k, String(v)]),
    footerNote: "Server-fetched canonical report. Amounts and control totals are from the authorized report source."
      + (warnings.length ? " WARNING: source integrity/evidence limitations are listed above." : ""),
  };
}