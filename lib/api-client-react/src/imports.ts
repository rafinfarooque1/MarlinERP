/**
 * ERP Migration Wizard (Company › Import Data).
 *
 * Two flows share one page:
 *  - MASTER imports (customers, vendors, ledgers, items): upload → validate →
 *    commit directly. Rows become real records at commit.
 *  - TRANSACTION imports (sales, purchases, receipts, payments, day book,
 *    opening stock): upload → validate → MAPPING (every old-ERP name is linked
 *    to an existing record or created, remembered forever) → DEMO run (the
 *    real import inside a never-committed transaction; a full report pack is
 *    computed from that state) → compare vs the old ERP → APPROVE (the real,
 *    all-or-nothing import) or DISCARD.
 *
 * All verdicts and figures are computed server-side; the client displays them.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ──────────────────────────────────────────────────────────────────

export type ImportModule =
  | "customers" | "vendors" | "ledgers" | "items"
  | "sales" | "purchases" | "receipts" | "payments"
  | "daybook" | "opening_stock";

export const IMPORT_MASTER_MODULES: ImportModule[] = ["customers", "vendors", "ledgers", "items"];
export const IMPORT_TXN_MODULES: ImportModule[] = ["sales", "purchases", "receipts", "payments", "daybook", "opening_stock"];

export type ImportBatchStatus =
  | "validated" | "demo_ready" | "committing" | "committed" | "rolled_back" | "discarded";

export type ImportRowStatus =
  | "valid" | "warning" | "error" | "needs_party" | "needs_mapping"
  | "imported" | "updated" | "skipped" | "failed" | "rolled_back";

export interface ImportBatch {
  id: number;
  /** Human-facing batch id, e.g. "IMP000023". */
  displayId: string;
  module: ImportModule;
  filename: string;
  status: ImportBatchStatus;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  importedRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  /** Target location — where imported documents are stamped. */
  locationType: string | null;
  locationId: number | null;
  /** Display name of the target location (resolved server-side). */
  locationName?: string | null;
  createdBy: string;
  createdAt: string;
  committedAt: string | null;
  committedBy: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  // ── Wizard state ──
  demoAt: string | null;
  demoBy: string | null;
  /** Counts + failures of the last demo run (small; the full report pack is fetched separately). */
  demoSummary: ImportDemoSummary | null;
  hasDemoReport: boolean;
  discardedAt: string | null;
  discardedBy: string | null;
  /** Old-ERP voucher number range covered by this batch. */
  legacyRange: { min: string | null; max: string | null } | null;
  canDemo: boolean;
  canApprove: boolean;
  canDiscard: boolean;
  canCommit: boolean;
  rollbackAvailable: boolean;
  /** Present when the upload was recognised as an old-software report and
   *  converted before validation. */
  conversion?: ImportLegacyConversion | null;
}

/** Conversion summary for a recognised old-software report file. */
export interface ImportLegacyConversion {
  detected: true;
  /** Human label of the recognised report, e.g. "Item-wise Sales report". */
  report: string;
  /** Spreadsheet row the real header was found on. */
  headerRow: number;
  /** Converted data rows fed into validation. */
  keptRows: number;
  /** Separator/total/blank-ish rows dropped by the converter. */
  droppedRows: number;
  /** Plain-language notes about what the conversion did. */
  notes: string[];
  /** Day book only: voucher types excluded because their own files cover them. */
  excluded?: Array<{ type: string; vouchers: number }>;
}

export interface ImportDemoSummary {
  imported: number;
  skipped: number;
  failed: number;
  failures: Array<{ rowNumber: number; name: string; reason: string }>;
  legacyMin: string | null;
  legacyMax: string | null;
  timeTakenMs?: number;
}

export interface ImportRow {
  id: number;
  rowNumber: number;
  status: ImportRowStatus;
  reason: string | null;
  suggestion: string | null;
  duplicateOfId: number | null;
  values: Record<string, string>;
  /** Old-ERP names this row still needs mapped (needs_mapping rows). */
  missingMappings: Array<{ kind: ImportMappingKind; name: string }>;
  /** Document group index — rows of one invoice/voucher share it. */
  docIndex: number | null;
  /** Txn imports: walk-in counter sale (no customer on the bill). */
  walkIn: boolean;
  /** Voucher imports: planned allocation shown in the preview. */
  plan: ImportVoucherPlan | null;
  /** What commit/approve actually recorded. */
  created: ImportVoucherCreated | null;
  /** This row's outcome in the last demo run. */
  demo: {
    status: "imported" | "skipped" | "failed";
    reason: string | null;
    createdType: string | null;
    created: Record<string, unknown> | null;
  } | null;
  createdRecordType: string | null;
  createdRecordId: number | null;
  createdLedgerId: number | null;
}

export interface ImportVoucherAllocation {
  id: number;
  invoiceNumber: string | null;
  amount: number;
}

/** Planned allocation for a receipt/payment voucher row (preview). */
export interface ImportVoucherPlan {
  allocations: ImportVoucherAllocation[];
  advance: number;
  accountName: string;
}

/** What commit actually recorded for a voucher row. */
export interface ImportVoucherCreated {
  voucherNumber: string;
  allocations?: ImportVoucherAllocation[];
  advanceAmount?: number;
  [k: string]: unknown;
}

/** Batch-level money totals for a sales/purchase preview — computed by the
 *  same server-side pricing pass the import uses. */
export interface ImportTxnSummary {
  invoices: number;
  totalQuantity: number;
  totalTaxable: number;
  totalGst: number;
  totalDiscount: number;
  totalAmount: number;
  distinctParties: number;
  distinctItems: number;
  walkInInvoices: number;
  /** Old-ERP names not yet linked — resolved in the mapping step. */
  unmappedNames: Array<{ kind: ImportMappingKind; name: string }>;
}

export interface ImportParseResponse {
  batch: ImportBatch;
  rows: ImportRow[];
  /** Present for sales/purchase imports. */
  summary?: ImportTxnSummary;
}

// ── Mappings (old-ERP name → this ERP's record; permanent memory) ──────────

export type ImportMappingKind = "customer" | "vendor" | "ledger" | "product";

export interface ImportUnmappedName {
  kind: ImportMappingKind;
  name: string;
  /** How many file rows carry this name. */
  rows: number;
  /** Exact-name match found in this ERP (prefill). */
  suggestion: { targetId: number; targetKind: string | null; name: string } | null;
  /** Receipt/payment party names only: may also be routed to a ledger
   *  (journal entry) or explicitly skipped — for non-party accounts. */
  routable?: boolean;
}

export interface ImportMappingCandidate {
  id: number;
  name: string;
  /** product candidates only: item | material | raw_material */
  targetKind?: string;
}

export interface ImportLedgerGroup {
  id: number;
  name: string;
  type: string;
  section: string | null;
}

export interface ImportBatchMappingsResponse {
  batch: ImportBatch;
  unmapped: ImportUnmappedName[];
  /** Pick-lists for "choose existing", keyed by kind. */
  candidates: Partial<Record<ImportMappingKind, ImportMappingCandidate[]>>;
  /** Ledgers a routable (non-party) name may be routed to as a journal entry. */
  routeLedgers?: Array<{ id: number; name: string }>;
  /** Groups a NEW ledger may be created under. */
  ledgerGroups: ImportLedgerGroup[];
}

/** One mapping decision: link to an existing record OR create a new one. */
export interface ImportMappingInput {
  kind: ImportMappingKind;
  /** The old-ERP name being mapped (exactly as reported in `unmapped`). */
  name: string;
  /** Choose existing … (targetKind "ledger" routes a non-party name to a
   *  ledger as a journal entry; "skip" excludes its rows, visibly — both
   *  for receipt/payment party names only, no targetId needed for skip) */
  targetId?: number;
  targetKind?: string | null;
  /** … or create new (fields depend on kind). */
  create?: {
    name?: string;
    // customer/vendor
    gstNumber?: string;
    phone?: string;
    state?: string;
    address?: string;
    // product (created as a finished item)
    unit?: string;
    hsnCode?: string;
    taxRate?: number;
    mrp?: number;
    cost?: number;
    // ledger
    parentId?: number;
  };
}

export interface ImportSaveMappingsResponse {
  batch: ImportBatch;
  rows: ImportRow[];
  saved: Array<{ kind: ImportMappingKind; name: string; targetName: string }>;
  created: Array<{ kind: ImportMappingKind; name: string; targetName: string }>;
  errors: Array<{ kind: ImportMappingKind; name: string; reason: string }>;
  summary?: ImportTxnSummary;
}

export interface ImportSavedMapping {
  id: number;
  kind: ImportMappingKind;
  sourceName: string;
  targetId: number;
  targetKind: string | null;
  /** Resolved current name of the target record (null if since deleted). */
  targetName: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ── Demo report pack ────────────────────────────────────────────────────────

export interface ImportDemoReportResponse {
  /** The full report pack computed from the demo state (TB, P&L, BS, books, dues, stock, KPIs). */
  report: {
    generatedAt: string;
    trialBalance: unknown;
    profitAndLoss: unknown;
    balanceSheet: unknown;
    cashBook: unknown;
    bankBook: unknown;
    receivables: { rows: Array<{ customerId: number; name: string; outstanding: number }>; total: number };
    payables: { rows: Array<{ vendorId: number; name: string; outstanding: number }>; total: number };
    stockValuation: unknown;
    kpis: { totalReceivables: number; totalPayables: number; stockValue: number };
  };
  summary: ImportDemoSummary | null;
  demoAt: string | null;
  demoBy: string | null;
  status: ImportBatchStatus;
}

// ── Commit / approve / rollback responses ───────────────────────────────────

/** What the commit actually put into the books (counted from provenance stamps). */
export interface ImportCommitDetails {
  invoicesImported: number;
  invoicesFailed: number;
  customersCreated: number;
  vendorsCreated: number;
  ledgersCreated: number;
  stockMovements: number;
  journalEntriesCreated: number;
  receiptsCreated: number;
  paymentsCreated: number;
  gstInvoices: number;
  timeTakenMs: number;
}

export interface ImportCommitResponse {
  batch: ImportBatch;
  summary: { imported: number; updated: number; skipped: number; failed: number };
  failures: Array<{ rowNumber: number; name: string; reason: string }>;
  details?: ImportCommitDetails;
}

export interface ImportApproveResponse {
  batch: ImportBatch;
  summary: { imported: number; skipped: number; failed: number };
  failures: Array<{ rowNumber: number; name: string; reason: string }>;
  details?: { recordCounts: Record<string, number>; timeTakenMs: number };
}

export interface ImportDemoRunResponse {
  batch: ImportBatch;
  summary: { imported: number; skipped: number; failed: number };
  failures: Array<{ rowNumber: number; name: string; reason: string }>;
}

export interface ImportRollbackResponse {
  batch: ImportBatch;
  removed: number;
  /** Per-type breakdown of records deleted (customers, vendors, ledgers, …). */
  removedCounts?: Record<string, number>;
  /** Automatic post-deletion checks (books balanced, nothing left behind). */
  verification?: {
    ok: boolean;
    leftoverStamps: number;
    booksBalanced: boolean;
    orphanSaleReceipts: number;
  };
}

/** 409 payload when rollback refuses because records have since been used. */
export interface ImportRollbackBlocked {
  error: string;
  blocked: Array<{ rowNumber: number; name: string; reason: string }>;
}

// ── Query keys ─────────────────────────────────────────────────────────────

export const importKeys = {
  batches: ["imports", "batches"] as const,
  batch: (id: number) => ["imports", "batches", id] as const,
  batchMappings: (id: number) => ["imports", "batches", id, "mappings"] as const,
  demoReport: (id: number) => ["imports", "batches", id, "demo-report"] as const,
  mappings: (kind?: string, q?: string) => ["imports", "mappings", kind ?? "all", q ?? ""] as const,
};

// ── Hooks ──────────────────────────────────────────────────────────────────

export const useImportBatches = () =>
  useQuery<{ batches: ImportBatch[] }, Error>({
    queryKey: importKeys.batches,
    queryFn: () => customFetch<{ batches: ImportBatch[] }>("/api/imports/batches", { method: "GET" }),
  });

export const useImportBatch = (id: number | null) =>
  useQuery<{ batch: ImportBatch; rows: ImportRow[]; summary?: ImportTxnSummary }, Error>({
    queryKey: importKeys.batch(id ?? 0),
    queryFn: () => customFetch<{ batch: ImportBatch; rows: ImportRow[]; summary?: ImportTxnSummary }>(`/api/imports/batches/${id}`, { method: "GET" }),
    enabled: id != null,
  });

/**
 * Upload a filled template for validation. Sent as a raw body — the server
 * parses the workbook and answers with the batch preview.
 */
export const useParseImportFile = () => {
  const qc = useQueryClient();
  return useMutation<ImportParseResponse, Error, {
    module: ImportModule; file: File;
    /** Required for transaction imports: where the documents land. */
    locationType?: string; locationId?: number;
  }>({
    mutationFn: ({ module, file, locationType, locationId }) => {
      let url = `/api/imports/parse?module=${module}&filename=${encodeURIComponent(file.name)}`;
      if (locationType) url += `&locationType=${encodeURIComponent(locationType)}&locationId=${locationId ?? 0}`;
      return customFetch<ImportParseResponse>(
        url,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      );
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: importKeys.batches }); },
  });
};

/** The unmapped old-ERP names of a batch, with pick-lists and prefill suggestions. */
export const useImportBatchMappings = (id: number | null) =>
  useQuery<ImportBatchMappingsResponse, Error>({
    queryKey: importKeys.batchMappings(id ?? 0),
    queryFn: () => customFetch<ImportBatchMappingsResponse>(`/api/imports/batches/${id}/mappings`, { method: "GET" }),
    enabled: id != null,
  });

/**
 * Save mapping decisions (choose-existing or create-new per name), upserting
 * the permanent mapping memory and re-validating the whole batch server-side.
 */
export const useSaveImportMappings = () => {
  const qc = useQueryClient();
  return useMutation<ImportSaveMappingsResponse, Error, { id: number; mappings: ImportMappingInput[] }>({
    mutationFn: ({ id, mappings }) =>
      customFetch<ImportSaveMappingsResponse>(`/api/imports/batches/${id}/mappings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
      qc.invalidateQueries({ queryKey: importKeys.batchMappings(vars.id) });
      qc.invalidateQueries({ queryKey: ["imports", "mappings"] });
    },
  });
};

/**
 * DEMO run — the real import inside a transaction that is never committed.
 * Nothing lands in the books; the batch stores the report pack for comparison.
 */
export const useRunImportDemo = () => {
  const qc = useQueryClient();
  return useMutation<ImportDemoRunResponse, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<ImportDemoRunResponse>(`/api/imports/batches/${id}/demo`, { method: "POST" }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
      qc.invalidateQueries({ queryKey: importKeys.demoReport(vars.id) });
    },
  });
};

/** The stored demo report pack (large — fetched only when viewed). */
export const useImportDemoReport = (id: number | null, enabled = true) =>
  useQuery<ImportDemoReportResponse, Error>({
    queryKey: importKeys.demoReport(id ?? 0),
    queryFn: () => customFetch<ImportDemoReportResponse>(`/api/imports/batches/${id}/demo-report`, { method: "GET" }),
    enabled: id != null && enabled,
  });

/**
 * APPROVE — the production import. Runs the same code the demo ran, in one
 * all-or-nothing transaction: any new failure rolls the whole import back.
 */
export const useApproveImportBatch = () => {
  const qc = useQueryClient();
  return useMutation<ImportApproveResponse, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<ImportApproveResponse>(`/api/imports/batches/${id}/approve`, { method: "POST" }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
    },
  });
};

/** Discard an un-imported batch (nothing was ever written to the books). */
export const useDiscardImportBatch = () => {
  const qc = useQueryClient();
  return useMutation<{ batch: ImportBatch }, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<{ batch: ImportBatch }>(`/api/imports/batches/${id}/discard`, { method: "POST" }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
    },
  });
};

/** Direct commit — MASTER imports only (customers, vendors, ledgers, items). */
export const useCommitImportBatch = () => {
  const qc = useQueryClient();
  return useMutation<ImportCommitResponse, Error, { id: number; skipRowIds?: number[]; duplicateAction?: "skip" | "update" }>({
    mutationFn: ({ id, skipRowIds, duplicateAction }) =>
      customFetch<ImportCommitResponse>(`/api/imports/batches/${id}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipRowIds: skipRowIds ?? [], duplicateAction: duplicateAction ?? "skip" }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
    },
  });
};

export const useRollbackImportBatch = () => {
  const qc = useQueryClient();
  return useMutation<ImportRollbackResponse, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<ImportRollbackResponse>(`/api/imports/batches/${id}/rollback`, { method: "POST" }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: importKeys.batches });
      qc.invalidateQueries({ queryKey: importKeys.batch(vars.id) });
    },
  });
};

// ── Manage Mappings (permanent memory, independent of any batch) ───────────

export const useImportMappings = (kind?: ImportMappingKind, search?: string) =>
  useQuery<{ mappings: ImportSavedMapping[] }, Error>({
    queryKey: importKeys.mappings(kind, search),
    queryFn: () => {
      const params = new URLSearchParams();
      if (kind) params.set("kind", kind);
      if (search) params.set("search", search);
      const qs = params.toString();
      return customFetch<{ mappings: ImportSavedMapping[] }>(`/api/imports/mappings${qs ? `?${qs}` : ""}`, { method: "GET" });
    },
  });

/** Pick-list for re-pointing a saved mapping (Manage Mappings screen). */
export const useImportMappingCandidates = (kind: ImportMappingKind | null) =>
  useQuery<{ candidates: ImportMappingCandidate[] }, Error>({
    queryKey: ["imports", "mapping-candidates", kind ?? ""] as const,
    queryFn: () => customFetch<{ candidates: ImportMappingCandidate[] }>(`/api/imports/mapping-candidates?kind=${kind}`, { method: "GET" }),
    enabled: kind != null,
  });

export const useUpdateImportMapping = () => {
  const qc = useQueryClient();
  return useMutation<{ mapping: ImportSavedMapping }, Error, { id: number; targetId: number; targetKind?: string | null }>({
    mutationFn: ({ id, targetId, targetKind }) =>
      customFetch<{ mapping: ImportSavedMapping }>(`/api/imports/mappings/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, targetKind: targetKind ?? null }),
      }),
    // Mapping edits also demote in-flight batches (demo cleared server-side),
    // so refresh everything import-related, not just the mapping list.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["imports"] }); },
  });
};

export const useDeleteImportMapping = () => {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<{ ok: boolean }>(`/api/imports/mappings/${id}`, { method: "DELETE" }),
    // Mapping edits also demote in-flight batches (demo cleared server-side),
    // so refresh everything import-related, not just the mapping list.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["imports"] }); },
  });
};

// ── Migration wizard (ONE migration, many files) ────────────────────────────
//
// The umbrella over up to one file per transaction module: upload all files →
// combined analyse → mapping → ONE demo across every file (one report pack) →
// verification → pick the location LAST → approve = one all-or-nothing
// import. Rollback removes the ENTIRE migration, never part of it.

export type ImportMigrationStatus =
  | "draft" | "demo_ready" | "committing" | "committed" | "rolled_back" | "discarded";

export interface ImportMigration {
  id: number;
  /** Human-facing id, e.g. "MIG0001". */
  displayId: string;
  status: ImportMigrationStatus;
  /** Where the trial ran (and approval will import) — null until a located trial. */
  locationType: string | null;
  locationId: number | null;
  locationName?: string | null;
  createdBy: string;
  createdAt: string;
  demoAt: string | null;
  demoBy: string | null;
  demoSummary: ImportMigrationDemoSummary | null;
  hasDemoReport: boolean;
  /** Per-record-type counts of what approval actually wrote. */
  recordCounts: Record<string, number> | null;
  legacyRange: { min: string | null; max: string | null } | null;
  committedAt: string | null;
  committedBy: string | null;
  discardedAt: string | null;
  discardedBy: string | null;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  canEdit: boolean;
  canDemo: boolean;
  canApprove: boolean;
  canDiscard: boolean;
  rollbackAvailable: boolean;
}

export interface ImportMigrationDemoSummary {
  imported: number;
  skipped: number;
  failed: number;
  perModule: Record<string, { imported: number; skipped: number; failed: number; legacyMin: string | null; legacyMax: string | null }>;
  failures: Array<{ module: ImportModule; rowNumber: number; name: string; reason: string }>;
  timeTakenMs?: number;
}

/** Lightweight per-file summary on the migrations LIST. */
export interface ImportMigrationFileSummary {
  module: ImportModule;
  filename: string;
  status: ImportBatchStatus;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  importedRows: number | null;
}

export interface ImportMigrationListItem extends ImportMigration {
  files: ImportMigrationFileSummary[];
}

/** One uploaded file on the migration DETAIL — a full batch plus wizard extras. */
export interface ImportMigrationFile extends ImportBatch {
  /** Rows waiting on the mapping step. */
  needsMappingRows: number;
  /** Error rows that are NOT mapping problems — fix the file and re-upload. */
  hardErrorRows: number;
  /** Documents in the file (invoices / vouchers / JVs / lines). */
  docCount: number;
  /** Money the file carries (invoice totals / voucher amounts / debit total / stock value). */
  moneyTotal: number;
  summary?: ImportTxnSummary;
}

export interface ImportMigrationAnalysis {
  issues: { duplicates: number; invalidGst: number; invalidDates: number; invalidAmounts: number; other: number };
  masters: Partial<Record<ImportMappingKind, { found: number; missing: number }>>;
}

export interface ImportMigrationDetail {
  migration: ImportMigration;
  files: ImportMigrationFile[];
  analysis: ImportMigrationAnalysis;
  /** Distinct old-ERP names still waiting in the mapping step. */
  unmappedTotal: number;
}

export interface ImportMigrationMappingsResponse {
  unmapped: ImportUnmappedName[];
  candidates: Partial<Record<ImportMappingKind, ImportMappingCandidate[]>>;
  /** Ledgers a routable (non-party) name may be routed to as a journal entry. */
  routeLedgers?: Array<{ id: number; name: string }>;
  ledgerGroups: ImportLedgerGroup[];
}

export interface ImportMigrationSaveMappingsResponse extends ImportMigrationDetail {
  saved: Array<{ kind: ImportMappingKind; name: string; targetName: string }>;
  created: Array<{ kind: ImportMappingKind; name: string; targetName: string }>;
  errors: Array<{ kind: ImportMappingKind; name: string; reason: string }>;
}

export interface ImportMigrationDemoResponse {
  migration: ImportMigration;
  summary: ImportMigrationDemoSummary;
  failures: Array<{ module: ImportModule; rowNumber: number; name: string; reason: string }>;
}

export interface ImportMigrationApproveResponse {
  migration: ImportMigration;
  summary: { imported: number; skipped: number; failed: number };
  details: { recordCounts: Record<string, number>; timeTakenMs: number };
}

export interface ImportMigrationRollbackResponse {
  migration: ImportMigration;
  removed: number;
  removedCounts: Record<string, number>;
  verification: {
    ok: boolean;
    perBatch: Array<{ module: ImportModule; verification: { ok: boolean; leftoverStamps: number; booksBalanced: boolean; orphanSaleReceipts: number } }>;
  };
}

export const migrationKeys = {
  list: ["imports", "migrations"] as const,
  detail: (id: number) => ["imports", "migrations", id] as const,
  mappings: (id: number) => ["imports", "migrations", id, "mappings"] as const,
  demoReport: (id: number) => ["imports", "migrations", id, "demo-report"] as const,
};

export const useImportMigrations = () =>
  useQuery<{ migrations: ImportMigrationListItem[] }, Error>({
    queryKey: migrationKeys.list,
    queryFn: () => customFetch<{ migrations: ImportMigrationListItem[] }>("/api/imports/migrations", { method: "GET" }),
  });

export const useImportMigration = (id: number | null) =>
  useQuery<ImportMigrationDetail, Error>({
    queryKey: migrationKeys.detail(id ?? 0),
    queryFn: () => customFetch<ImportMigrationDetail>(`/api/imports/migrations/${id}`, { method: "GET" }),
    enabled: id != null,
  });

export const useCreateImportMigration = () => {
  const qc = useQueryClient();
  return useMutation<{ migration: ImportMigration }, Error, void>({
    mutationFn: () => customFetch<{ migration: ImportMigration }>("/api/imports/migrations", { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: migrationKeys.list }); },
  });
};

/** Upload (or replace) one module's file. Answers with the fresh detail. */
export const useUploadMigrationFile = () => {
  const qc = useQueryClient();
  return useMutation<ImportMigrationDetail, Error, { id: number; module: ImportModule; file: File }>({
    mutationFn: ({ id, module, file }) =>
      customFetch<ImportMigrationDetail>(
        `/api/imports/migrations/${id}/files?module=${module}&filename=${encodeURIComponent(file.name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file },
      ),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: migrationKeys.list });
      qc.invalidateQueries({ queryKey: migrationKeys.detail(vars.id) });
      qc.invalidateQueries({ queryKey: migrationKeys.mappings(vars.id) });
    },
  });
};

export const useRemoveMigrationFile = () => {
  const qc = useQueryClient();
  return useMutation<ImportMigrationDetail, Error, { id: number; module: ImportModule }>({
    mutationFn: ({ id, module }) =>
      customFetch<ImportMigrationDetail>(`/api/imports/migrations/${id}/files/${module}`, { method: "DELETE" }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: migrationKeys.list });
      qc.invalidateQueries({ queryKey: migrationKeys.detail(vars.id) });
      qc.invalidateQueries({ queryKey: migrationKeys.mappings(vars.id) });
    },
  });
};

/** Unmapped names across ALL files of the migration, in one workspace. */
export const useImportMigrationMappings = (id: number | null) =>
  useQuery<ImportMigrationMappingsResponse, Error>({
    queryKey: migrationKeys.mappings(id ?? 0),
    queryFn: () => customFetch<ImportMigrationMappingsResponse>(`/api/imports/migrations/${id}/mappings`, { method: "GET" }),
    enabled: id != null,
  });

export const useSaveMigrationMappings = () => {
  const qc = useQueryClient();
  return useMutation<ImportMigrationSaveMappingsResponse, Error, { id: number; mappings: ImportMappingInput[] }>({
    mutationFn: ({ id, mappings }) =>
      customFetch<ImportMigrationSaveMappingsResponse>(`/api/imports/migrations/${id}/mappings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      }),
    // Mappings are global memory — refresh every import surface.
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["imports"] }); },
  });
};

/**
 * The combined demo across every file — one transaction, never committed.
 * Pass the location the migration will finally import at: the trial re-stamps
 * every file there, the compare pack is scoped to it, and approval only
 * accepts that same location.
 */
export const useRunMigrationDemo = () => {
  const qc = useQueryClient();
  return useMutation<ImportMigrationDemoResponse, Error, { id: number; locationType?: string; locationId?: number }>({
    mutationFn: ({ id, locationType, locationId }) =>
      customFetch<ImportMigrationDemoResponse>(`/api/imports/migrations/${id}/demo`, {
        method: "POST",
        ...(locationType ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locationType, locationId }),
        } : {}),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: migrationKeys.list });
      qc.invalidateQueries({ queryKey: migrationKeys.detail(vars.id) });
      qc.invalidateQueries({ queryKey: migrationKeys.demoReport(vars.id) });
    },
  });
};

/** The stored demo report pack for a migration (large — fetch when viewed). */
export const useMigrationDemoReport = (id: number | null, enabled = true) =>
  useQuery<ImportDemoReportResponse, Error>({
    queryKey: migrationKeys.demoReport(id ?? 0),
    queryFn: () => customFetch<ImportDemoReportResponse>(`/api/imports/migrations/${id}/demo-report`, { method: "GET" }),
    enabled: id != null && enabled,
  });

/**
 * APPROVE — the final import. The location is chosen HERE (after
 * verification); the server re-checks every file at it, then imports all
 * files in one all-or-nothing transaction.
 */
export const useApproveMigration = () => {
  const qc = useQueryClient();
  return useMutation<ImportMigrationApproveResponse, Error, { id: number; locationType: string; locationId: number }>({
    mutationFn: ({ id, locationType, locationId }) =>
      customFetch<ImportMigrationApproveResponse>(`/api/imports/migrations/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationType, locationId }),
      }),
    // A committed migration changed the books everywhere.
    onSuccess: () => { qc.invalidateQueries(); },
  });
};

export const useDiscardMigration = () => {
  const qc = useQueryClient();
  return useMutation<{ migration: ImportMigration }, Error, { id: number }>({
    mutationFn: ({ id }) => customFetch<{ migration: ImportMigration }>(`/api/imports/migrations/${id}/discard`, { method: "POST" }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: migrationKeys.list });
      qc.invalidateQueries({ queryKey: migrationKeys.detail(vars.id) });
    },
  });
};

/** Roll back the ENTIRE migration — every file, or nothing. */
export const useRollbackMigration = () => {
  const qc = useQueryClient();
  return useMutation<ImportMigrationRollbackResponse, Error, { id: number }>({
    mutationFn: ({ id }) => customFetch<ImportMigrationRollbackResponse>(`/api/imports/migrations/${id}/rollback`, { method: "POST" }),
    // A rollback changed the books everywhere.
    onSuccess: () => { qc.invalidateQueries(); },
  });
};

// ── Downloads ───────────────────────────────────────────────────────────────

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Download the pre-filled sample template. Fetched with the auth header and
 * saved as a blob — a bare link would arrive without a token and fail.
 */
export async function downloadImportTemplate(module: ImportModule): Promise<void> {
  const blob = await customFetch<Blob>(`/api/imports/templates/${module}`, {
    method: "GET",
    responseType: "blob",
  });
  saveBlob(blob, `${module}-import-sample.xlsx`);
}

/**
 * Download ONLY the failed rows of a batch as an Excel file, with an
 * "Error Reason" column on each row — fix in Excel and re-upload just those.
 */
export async function downloadImportErrorFile(batchId: number, module: ImportModule): Promise<void> {
  const blob = await customFetch<Blob>(`/api/imports/batches/${batchId}/error-file`, {
    method: "GET",
    responseType: "blob",
  });
  saveBlob(blob, `${module}-import-errors.xlsx`);
}
