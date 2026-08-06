/**
 * Import Data (Company) — the ERP Migration Wizard.
 *
 * Masters (customers, vendors, ledgers, items): upload → validate → commit.
 * Transactions (sales, purchases, receipts, payments, day book, opening
 * stock): upload → analyse → MAP every old-ERP name (remembered forever) →
 * DEMO import (nothing recorded; full report pack computed) → compare against
 * the old ERP → APPROVE (all-or-nothing real import) or DISCARD.
 *
 * Every verdict and figure is computed on the server; this page displays it.
 */
import { useMemo, useRef, useState } from 'react';
import {
  useImportBatches, useImportBatch, useParseImportFile, useCommitImportBatch,
  useRollbackImportBatch, useRunImportDemo, useApproveImportBatch, useDiscardImportBatch,
  downloadImportTemplate, downloadImportErrorFile, useListWarehouses, useListOutlets,
  type ImportModule, type ImportBatch, type ImportRollbackBlocked,
  type ImportCommitResponse, type ImportApproveResponse,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { toast } from 'sonner';
import {
  ShieldOff, Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle,
  XCircle, RotateCcw, Loader2, History, Eye, MapPin, Link2, FlaskConical,
  FileBarChart2, ThumbsUp, Trash2, PlayCircle,
} from 'lucide-react';
import {
  MODULE_META, MODULE_LABEL, MASTER_MODULES, WIZARD_MODULES,
  isTxn, isVoucher, isWizard, partyIsCustomer, rowLabel, fmtTime, fmtMoney,
  RowStatusBadge, BatchStatusBadge, AllocationCell,
} from './import/shared';
import { MappingStep } from './import/MappingStep';
import { DemoReportView } from './import/DemoReportView';
import { ManageMappings } from './import/ManageMappings';
import { MigrationWizard, MigrationHistory } from './import/MigrationWizard';

export default function ImportData() {
  const perm = usePermission('page:/company/import');

  const [tab, setTab] = useState('migration');
  const [module, setModule] = useState<ImportModule>('customers');
  const [resumeMigId, setResumeMigId] = useState<number | null>(null);
  /** The batch currently open in the wizard/preview area. */
  const [activeBatchId, setActiveBatchId] = useState<number | null>(null);
  /** Result panels shown after the work finishes. */
  const [commitResult, setCommitResult] = useState<ImportCommitResponse | null>(null);
  const [approveResult, setApproveResult] = useState<ImportApproveResponse | null>(null);
  const [skippedRowIds, setSkippedRowIds] = useState<Set<number>>(new Set());
  const [duplicateAction, setDuplicateAction] = useState<'skip' | 'update'>('skip');
  const [commitOpen, setCommitOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [detailBatchId, setDetailBatchId] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ImportBatch | null>(null);
  const [rollbackBlocked, setRollbackBlocked] = useState<ImportRollbackBlocked | null>(null);
  /** Which batch's demo report pack is open, if any. */
  const [reportBatchId, setReportBatchId] = useState<number | null>(null);
  /** Target location for transaction imports, as "type|id". */
  const [location, setLocation] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: historyData, isLoading: loadingHistory } = useImportBatches();
  const { data: active } = useImportBatch(activeBatchId);
  const { data: detailData } = useImportBatch(detailBatchId);
  const { data: warehouses } = useListWarehouses();
  const { data: outlets } = useListOutlets();
  const parseFile = useParseImportFile();
  const commitBatch = useCommitImportBatch();
  const rollbackBatch = useRollbackImportBatch();
  const runDemo = useRunImportDemo();
  const approveBatch = useApproveImportBatch();
  const discardBatch = useDiscardImportBatch();

  const batches = historyData?.batches ?? [];

  const { sorted: sortedBatches, sort: batchSort } = useTableSort(batches, {
    batchId: b => b.displayId ?? `IMP${String(b.id).padStart(6, '0')}`,
    when: b => b.createdAt,
    module: b => MODULE_LABEL(b.module),
    file: b => b.filename,
    location: b => b.locationName,
    by: b => b.createdBy,
    rows: b => Number(b.totalRows),
    imported: b => b.status === 'validated' || b.status === 'demo_ready' ? null : Number(b.importedRows),
    status: b => b.status,
  });

  const wizard = isWizard(module);
  const txn = isTxn(module);
  const voucher = isVoucher(module);
  const partyWord = partyIsCustomer(module) ? 'customer' : 'vendor';

  const batch = active?.batch ?? null;
  const rows = useMemo(() => active?.rows ?? [], [active]);
  const summary = active?.summary;

  const needsMappingCount = useMemo(
    () => rows.filter((r) => r.status === 'needs_mapping' || r.status === 'needs_party').length,
    [rows],
  );
  const committableRows = useMemo(
    () => rows.filter((r) => r.status !== 'error' && r.status !== 'needs_mapping' && r.status !== 'needs_party' && !skippedRowIds.has(r.id)),
    [rows, skippedRowIds],
  );
  const hasDuplicates = !wizard && rows.some((r) => r.duplicateOfId != null && r.status !== 'error');
  const pureErrorRows = batch ? Math.max(0, batch.errorRows - (wizard ? 0 : 0)) : 0;

  const openBatch = (b: ImportBatch) => {
    setModule(b.module);
    if (b.locationType) setLocation(`${b.locationType}|${b.locationId ?? 0}`);
    setActiveBatchId(b.id);
    setCommitResult(null);
    setApproveResult(null);
    setSkippedRowIds(new Set());
    setTab('import');
  };

  const resetActive = () => {
    setActiveBatchId(null);
    setSkippedRowIds(new Set());
    setDuplicateAction('skip');
  };

  const handleDownloadSample = async () => {
    try {
      await downloadImportTemplate(module);
      toast.success(`${MODULE_META[module].label} sample downloaded — fill it in and upload it here.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'The sample could not be downloaded.');
    }
  };

  const handleFilePicked = async (file: File) => {
    try {
      const [locType, locId] = location.split('|');
      const r = await parseFile.mutateAsync({
        module, file,
        ...(wizard ? { locationType: locType, locationId: Number(locId) } : {}),
      });
      setActiveBatchId(r.batch.id);
      setCommitResult(null);
      setApproveResult(null);
      setSkippedRowIds(new Set());
      setDuplicateAction('skip');
      const { validRows, warningRows, errorRows } = r.batch;
      const needsMapping = r.rows.filter((row) => row.status === 'needs_mapping' || row.status === 'needs_party').length;
      if (needsMapping > 0) toast.info(`${needsMapping} row${needsMapping === 1 ? '' : 's'} carry old-ERP names not seen before — map them below, once, and they are remembered forever.`);
      else if (errorRows > 0) toast.warning(`${errorRows} row${errorRows === 1 ? '' : 's'} have errors. Fix and re-upload, or continue without them.`);
      else toast.success(`File analysed — ${validRows} valid, ${warningRows} warning${warningRows === 1 ? '' : 's'}. Nothing has been recorded.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'That file could not be read.');
    }
  };

  const toggleSkip = (rowId: number) => {
    setSkippedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
      return next;
    });
  };

  const handleCommit = async () => {
    if (!batch) return;
    try {
      const r = await commitBatch.mutateAsync({
        id: batch.id,
        skipRowIds: [...skippedRowIds],
        duplicateAction,
      });
      setCommitOpen(false);
      resetActive();
      setCommitResult(r);
      const { imported, updated, skipped, failed } = r.summary;
      const msg = `${imported} imported${updated ? `, ${updated} updated` : ''}${skipped ? `, ${skipped} skipped` : ''}${failed ? `, ${failed} FAILED` : ''}`;
      if (failed > 0) toast.warning(`Import finished with problems — ${msg}. See the batch in History for per-row reasons.`);
      else toast.success(`Import complete — ${msg}.`);
    } catch (e: any) {
      setCommitOpen(false);
      toast.error(e?.message ?? 'The import could not be committed.');
    }
  };

  const handleDemo = async () => {
    if (!batch) return;
    try {
      const r = await runDemo.mutateAsync({ id: batch.id });
      const { imported, skipped, failed } = r.summary;
      if (failed > 0) toast.warning(`Demo finished — ${imported} would import, ${failed} FAILED. Check the failures below; failed documents are left out of the real import.`);
      else toast.success(`Demo finished — ${imported} document${imported === 1 ? '' : 's'} would import${skipped ? `, ${skipped} skipped` : ''}. Nothing was recorded. Compare the reports before approving.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'The demo run failed.');
    }
  };

  const handleApprove = async () => {
    if (!batch) return;
    try {
      const r = await approveBatch.mutateAsync({ id: batch.id });
      setApproveOpen(false);
      resetActive();
      setApproveResult(r);
      toast.success(`Import approved — ${r.summary.imported} document${r.summary.imported === 1 ? '' : 's'} recorded in your books.`);
    } catch (e: any) {
      setApproveOpen(false);
      toast.error(e?.message ?? 'The import could not be approved — nothing was recorded.');
    }
  };

  const handleDiscard = async () => {
    if (!batch) return;
    try {
      await discardBatch.mutateAsync({ id: batch.id });
      setDiscardOpen(false);
      resetActive();
      toast.success('Batch discarded — nothing was ever recorded in your books.');
    } catch (e: any) {
      setDiscardOpen(false);
      toast.error(e?.message ?? 'The batch could not be discarded.');
    }
  };

  const handleRollback = async () => {
    if (!rollbackTarget) return;
    try {
      const r = await rollbackBatch.mutateAsync({ id: rollbackTarget.id });
      setRollbackTarget(null);
      const v = r.verification;
      if (v && !v.ok) {
        toast.warning(`Deleted ${r.removed} record${r.removed === 1 ? '' : 's'}, but the automatic post-deletion check flagged an issue — check the audit log.`);
      } else {
        toast.success(`Import deleted — ${r.removed} record${r.removed === 1 ? '' : 's'} removed.${v ? ' Books verified: balanced, nothing left behind.' : ''}`);
      }
    } catch (e: any) {
      setRollbackTarget(null);
      const body = e?.data as ImportRollbackBlocked | undefined;
      if (body?.blocked?.length) {
        setRollbackBlocked(body);
      } else {
        toast.error(e?.message ?? 'The rollback failed.');
      }
    }
  };

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  const showDemoStep = batch != null && isWizard(batch.module);

  return (
    <AppLayout>
      <div className="space-y-6 font-sans">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSpreadsheet className="w-6 h-6 text-primary" />
            Import Data
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Move your old ERP into this one: upload all your files, match the old names once, run a
            trial, compare the reports, then approve. Nothing touches your books until you approve.
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="migration"><PlayCircle className="w-4 h-4 mr-1.5" />Migration</TabsTrigger>
            <TabsTrigger value="import"><Upload className="w-4 h-4 mr-1.5" />Masters</TabsTrigger>
            <TabsTrigger value="mappings"><Link2 className="w-4 h-4 mr-1.5" />Mappings</TabsTrigger>
            <TabsTrigger value="history"><History className="w-4 h-4 mr-1.5" />History</TabsTrigger>
          </TabsList>

          {/* ── Migration tab (the wizard) ─────────────────────────────── */}
          <TabsContent value="migration" className="mt-4">
            <MigrationWizard canAdd={perm.canAdd} canDelete={perm.canDelete} canDownload={perm.canDownload} resumeId={resumeMigId} />
          </TabsContent>

          {/* ── Import tab ─────────────────────────────────────────────── */}
          <TabsContent value="import" className="space-y-4 mt-4">
            <div className="space-y-3">
              <div>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Masters — created directly at commit. Sales, purchases and other transactions are imported from the Migration tab.
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {MASTER_MODULES.map((m) => {
                    const meta = MODULE_META[m];
                    const Icon = meta.icon;
                    const activeCard = module === m;
                    return (
                      <Card key={m}
                        className={`cursor-pointer transition-colors ${activeCard ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'}`}
                        onClick={() => { setModule(m); resetActive(); setCommitResult(null); setApproveResult(null); }}>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Icon className={`w-4 h-4 ${activeCard ? 'text-primary' : 'text-muted-foreground'}`} />
                            {meta.label}
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <p className="text-xs text-muted-foreground">{meta.blurb}</p>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </div>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Step 1 — Get the sample, fill it, upload it</CardTitle>
                <CardDescription>
                  {voucher
                    ? `Columns marked * are required. One row per voucher. ${module === 'receipts' ? 'Against Invoice' : 'Against Bill'} settles only that ${module === 'receipts' ? 'invoice' : 'bill'}; blank auto-allocates oldest-first, excess becomes a ${partyWord} advance.`
                    : txn
                      ? `Columns marked * are required. One row per invoice line — rows of one invoice must sit together with the same invoice number, date and ${partyWord}. ${module === 'sales' ? 'Prices INCLUDE GST; a price below the item MRP is recorded at MRP with the difference as a line discount.' : 'Purchase rates are GST-exclusive, like manual purchase entry.'}`
                      : module === 'daybook'
                        ? 'Columns marked * are required. One row per voucher line — rows sharing a voucher number become one voucher, and its debits must equal its credits.'
                        : module === 'opening_stock'
                          ? 'Columns marked * are required. One row per item with the as-on date, quantity and unit cost from your old ERP.'
                          : 'Columns marked * are required. Duplicate names are flagged — you decide at commit whether to skip or update them.'}
                  {' '}Uploading only analyses the file — nothing is recorded.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={handleDownloadSample} disabled={!perm.canDownload}>
                  <Download className="w-4 h-4 mr-1.5" />
                  Download {MODULE_META[module].label} sample
                </Button>
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!perm.canAdd || parseFile.isPending || (wizard && !location)}
                >
                  {parseFile.isPending
                    ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    : <Upload className="w-4 h-4 mr-1.5" />}
                  Upload filled file
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFilePicked(f);
                    e.target.value = '';
                  }}
                />
              </CardContent>
            </Card>

            {/* Post-approve result panel */}
            {approveResult && !batch && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    Import approved — {approveResult.batch.filename}
                  </CardTitle>
                  <CardDescription>
                    Counted from the records this batch actually created in your books.
                    {approveResult.details ? ` Finished in ${(approveResult.details.timeTakenMs / 1000).toFixed(1)}s.` : ''}
                    {approveResult.batch.legacyRange?.min ? ` Old voucher numbers ${approveResult.batch.legacyRange.min} – ${approveResult.batch.legacyRange.max} are searchable on every screen.` : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {Object.entries(approveResult.details?.recordCounts ?? {})
                      .filter(([, v]) => Number(v) > 0)
                      .map(([label, value]) => (
                        <div key={label} className="rounded-lg border p-3">
                          <div className="text-xl font-bold">{value}</div>
                          <div className="text-xs text-muted-foreground capitalize">{label.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
                        </div>
                      ))}
                    <div className="rounded-lg border p-3">
                      <div className={`text-xl font-bold ${approveResult.summary.skipped > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>{approveResult.summary.skipped}</div>
                      <div className="text-xs text-muted-foreground">Left out (failed in demo)</div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The whole batch can be deleted from History while its records are untouched.
                  </p>
                  <div>
                    <Button variant="ghost" size="sm" onClick={() => setApproveResult(null)}>Dismiss</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Post-commit result panel (masters) */}
            {commitResult && !batch && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    Import summary — {commitResult.batch.filename}
                  </CardTitle>
                  <CardDescription>
                    {commitResult.summary.imported} imported
                    {commitResult.summary.updated ? `, ${commitResult.summary.updated} updated` : ''}
                    {commitResult.summary.skipped ? `, ${commitResult.summary.skipped} skipped` : ''}
                    {commitResult.summary.failed ? `, ${commitResult.summary.failed} failed` : ''}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(commitResult.summary.failed > 0 || commitResult.batch.errorRows > 0 || commitResult.batch.failedRows > 0) && (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" disabled={!perm.canDownload}
                        onClick={() => downloadImportErrorFile(commitResult.batch.id, commitResult.batch.module).catch((e: any) => toast.error(e?.message ?? 'The error file could not be downloaded.'))}>
                        <Download className="w-4 h-4 mr-1.5" />
                        Download failed rows (Excel)
                      </Button>
                      <span className="text-muted-foreground text-xs">Each row carries the reason it failed — fix and re-upload just those.</span>
                    </div>
                  )}
                  <div>
                    <Button variant="ghost" size="sm" onClick={() => setCommitResult(null)}>Dismiss</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── Active batch area ──────────────────────────────────── */}
            {batch && (
              <>
                {/* Analyse summary */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center justify-between gap-2">
                      <span>Step 2 — Analysis ({batch.filename})</span>
                      <BatchStatusBadge b={batch} />
                    </CardTitle>
                    <CardDescription>
                      {showDemoStep
                        ? 'Nothing has been recorded. Rows with errors are left out; unmapped names must be mapped below before the demo run.'
                        : 'Rows with errors are never imported — fix them in the file and re-upload, or commit the rest. Untick a row to leave it out.'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className={`grid grid-cols-2 gap-3 ${showDemoStep ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}>
                      <div className="rounded-lg border p-3">
                        <div className="text-2xl font-bold">{batch.totalRows}</div>
                        <div className="text-xs text-muted-foreground">Total rows</div>
                      </div>
                      <div className="rounded-lg border p-3">
                        <div className="text-2xl font-bold text-emerald-600 flex items-center gap-1"><CheckCircle2 className="w-5 h-5" />{batch.validRows}</div>
                        <div className="text-xs text-muted-foreground">Valid</div>
                      </div>
                      <div className="rounded-lg border p-3">
                        <div className="text-2xl font-bold text-amber-600 flex items-center gap-1"><AlertTriangle className="w-5 h-5" />{batch.warningRows}</div>
                        <div className="text-xs text-muted-foreground">Warnings</div>
                      </div>
                      {showDemoStep && (
                        <div className="rounded-lg border p-3">
                          <div className="text-2xl font-bold text-blue-600 flex items-center gap-1"><Link2 className="w-5 h-5" />{needsMappingCount}</div>
                          <div className="text-xs text-muted-foreground">Need mapping</div>
                        </div>
                      )}
                      <div className="rounded-lg border p-3">
                        <div className="text-2xl font-bold text-destructive flex items-center gap-1"><XCircle className="w-5 h-5" />{Math.max(0, batch.errorRows - (showDemoStep ? needsMappingCount : 0))}</div>
                        <div className="text-xs text-muted-foreground">Errors</div>
                      </div>
                    </div>

                    {summary && (
                      <div className="rounded-lg border bg-muted/40 p-3">
                        <div className="text-xs font-medium text-muted-foreground mb-2">
                          What the import would record — computed by the ERP exactly as manual entry would:
                        </div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                          <div>
                            <div className="text-lg font-bold">{summary.invoices}</div>
                            <div className="text-xs text-muted-foreground">{batch.module === 'sales' ? 'Invoices' : 'Bills'}</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold">{summary.totalQuantity}</div>
                            <div className="text-xs text-muted-foreground">Total quantity</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold">{fmtMoney(summary.totalTaxable)}</div>
                            <div className="text-xs text-muted-foreground">Taxable value</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold">{fmtMoney(summary.totalGst)}</div>
                            <div className="text-xs text-muted-foreground">Total GST</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold">{fmtMoney(summary.totalDiscount)}</div>
                            <div className="text-xs text-muted-foreground">Total discount</div>
                          </div>
                          <div>
                            <div className="text-lg font-bold text-primary">{fmtMoney(summary.totalAmount)}</div>
                            <div className="text-xs text-muted-foreground">Total amount</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {batch.errorRows > 0 && (
                      <div className="flex items-center gap-2 text-sm">
                        <Button variant="outline" size="sm" disabled={!perm.canDownload}
                          onClick={() => downloadImportErrorFile(batch.id, batch.module).catch((e: any) => toast.error(e?.message ?? 'The error file could not be downloaded.'))}>
                          <Download className="w-4 h-4 mr-1.5" />
                          Download problem rows (Excel)
                        </Button>
                        <span className="text-muted-foreground text-xs">Only the problem rows, with the reason on each — fix in Excel and re-upload just those.</span>
                      </div>
                    )}

                    {hasDuplicates && (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <span>Some names already exist. When committing:</span>
                        <Select value={duplicateAction} onValueChange={(v) => setDuplicateAction(v as 'skip' | 'update')}>
                          <SelectTrigger className="w-56 h-8 bg-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="skip">Skip duplicates (keep existing)</SelectItem>
                            <SelectItem value="update">Update existing records</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <div className="rounded-lg border overflow-x-auto max-h-[28rem] overflow-y-auto">
                      <Table className="no-sticky-col">
                        <TableHeader>
                          <TableRow>
                            {!showDemoStep && <TableHead className="w-10">Import</TableHead>}
                            <TableHead className="w-14">Row</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead className="w-28">Status</TableHead>
                            {voucher && <TableHead>Will settle</TableHead>}
                            {batch.status === 'demo_ready' && <TableHead className="w-24">Demo</TableHead>}
                            <TableHead>Reason</TableHead>
                            <TableHead>Suggestion</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((r) => (
                            <TableRow key={r.id} className={r.status === 'error' ? 'opacity-60' : ''}>
                              {!showDemoStep && (
                                <TableCell>
                                  <Checkbox
                                    checked={r.status !== 'error' && !skippedRowIds.has(r.id)}
                                    disabled={r.status === 'error'}
                                    onCheckedChange={() => toggleSkip(r.id)}
                                  />
                                </TableCell>
                              )}
                              <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
                              <TableCell className="font-medium">
                                {rowLabel(batch.module, r)}
                                {r.walkIn && <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 align-middle">Walk-in</Badge>}
                              </TableCell>
                              <TableCell><RowStatusBadge status={r.status} /></TableCell>
                              {voucher && <TableCell><AllocationCell r={r} /></TableCell>}
                              {batch.status === 'demo_ready' && (
                                <TableCell>
                                  {r.demo
                                    ? r.demo.status === 'failed'
                                      ? <Badge variant="destructive" title={r.demo.reason ?? ''}>Failed</Badge>
                                      : r.demo.status === 'imported'
                                        ? <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">OK</Badge>
                                        : <Badge variant="secondary">Skipped</Badge>
                                    : <span className="text-muted-foreground text-xs">—</span>}
                                </TableCell>
                              )}
                              <TableCell className="text-sm text-muted-foreground max-w-[22rem]">{r.demo?.reason ?? r.reason ?? '—'}</TableCell>
                              <TableCell className="text-sm text-muted-foreground max-w-[22rem]">{r.suggestion ?? '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    {/* Masters: commit actions */}
                    {!showDemoStep && batch.status === 'validated' && (
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">
                          {committableRows.length} of {batch.totalRows} row{batch.totalRows === 1 ? '' : 's'} will be committed.
                        </p>
                        <div className="flex gap-2">
                          <Button variant="outline" onClick={resetActive}>Close</Button>
                          <Button onClick={() => setCommitOpen(true)} disabled={!perm.canAdd || !batch.canCommit || committableRows.length === 0}>
                            Commit import
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Wizard: mapping step */}
                {showDemoStep && batch.status === 'validated' && needsMappingCount > 0 && (
                  <MappingStep key={`batch-${batch.id}`} batchId={batch.id} canEdit={perm.canAdd} />
                )}

                {/* Wizard: demo step */}
                {showDemoStep && batch.status === 'validated' && needsMappingCount === 0 && (
                  <Card className="border-primary/40">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <FlaskConical className="w-4 h-4 text-primary" />
                        Step 3 — Demo import
                      </CardTitle>
                      <CardDescription>
                        The demo performs the REAL import — full accounting, stock, GST and voucher
                        numbering — inside a rehearsal that is thrown away. You get the complete report
                        pack (trial balance, P&amp;L, balance sheet, cash &amp; bank books, dues, stock) to
                        compare against your old ERP. Nothing is recorded until you approve.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-2">
                      <Button onClick={handleDemo} disabled={!perm.canAdd || runDemo.isPending}>
                        {runDemo.isPending
                          ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                          : <PlayCircle className="w-4 h-4 mr-1.5" />}
                        Run demo import
                      </Button>
                      <Button variant="outline" className="text-destructive hover:text-destructive"
                        onClick={() => setDiscardOpen(true)} disabled={!perm.canAdd || !batch.canDiscard}>
                        <Trash2 className="w-4 h-4 mr-1.5" />Discard batch
                      </Button>
                    </CardContent>
                  </Card>
                )}

                {/* Wizard: demo done — compare & approve */}
                {showDemoStep && batch.status === 'demo_ready' && (
                  <Card className="border-blue-300">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <FileBarChart2 className="w-4 h-4 text-blue-600" />
                        Step 4 — Compare, then approve
                      </CardTitle>
                      <CardDescription>
                        Demo run {batch.demoAt ? fmtTime(batch.demoAt) : ''} by {batch.demoBy ?? ''}.
                        {' '}Nothing has been recorded. Open the reports, put your old ERP beside them, and
                        approve only when the figures match.
                        {batch.legacyRange?.min ? ` Covers old voucher numbers ${batch.legacyRange.min} – ${batch.legacyRange.max}.` : ''}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {batch.demoSummary && (
                        <div className="grid grid-cols-3 gap-3 sm:w-96">
                          <div className="rounded-lg border p-3">
                            <div className="text-xl font-bold text-emerald-600">{batch.demoSummary.imported}</div>
                            <div className="text-xs text-muted-foreground">Would import</div>
                          </div>
                          <div className="rounded-lg border p-3">
                            <div className="text-xl font-bold text-muted-foreground">{batch.demoSummary.skipped}</div>
                            <div className="text-xs text-muted-foreground">Skipped</div>
                          </div>
                          <div className="rounded-lg border p-3">
                            <div className={`text-xl font-bold ${batch.demoSummary.failed > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{batch.demoSummary.failed}</div>
                            <div className="text-xs text-muted-foreground">Failed</div>
                          </div>
                        </div>
                      )}
                      {(batch.demoSummary?.failures?.length ?? 0) > 0 && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                          <div className="text-sm font-medium flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4 text-amber-600" />
                            {batch.demoSummary!.failures.length} document{batch.demoSummary!.failures.length === 1 ? '' : 's'} failed in the demo — they will be LEFT OUT of the real import
                          </div>
                          <ul className="text-xs text-muted-foreground list-disc pl-5 max-h-40 overflow-y-auto">
                            {batch.demoSummary!.failures.map((f, i) => (
                              <li key={i}><span className="font-medium text-foreground">{f.name}</span> — {f.reason}</li>
                            ))}
                          </ul>
                          <p className="text-xs text-muted-foreground">Fix the file and re-upload, or approve without them.</p>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={() => setReportBatchId(batch.id)}>
                          <FileBarChart2 className="w-4 h-4 mr-1.5" />View comparison reports
                        </Button>
                        <Button variant="outline" onClick={handleDemo} disabled={!perm.canAdd || runDemo.isPending}>
                          {runDemo.isPending
                            ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                            : <RotateCcw className="w-4 h-4 mr-1.5" />}
                          Re-run demo
                        </Button>
                        <Button onClick={() => setApproveOpen(true)} disabled={!perm.canAdd || !batch.canApprove}>
                          <ThumbsUp className="w-4 h-4 mr-1.5" />Approve — record in my books
                        </Button>
                        <Button variant="outline" className="text-destructive hover:text-destructive"
                          onClick={() => setDiscardOpen(true)} disabled={!perm.canAdd || !batch.canDiscard}>
                          <Trash2 className="w-4 h-4 mr-1.5" />Discard
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Terminal states when a batch is opened from history */}
                {batch.status === 'committed' && (
                  <Card>
                    <CardContent className="py-4 flex flex-wrap items-center gap-3 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      This batch has been imported into your books.
                      {batch.hasDemoReport && (
                        <Button variant="outline" size="sm" onClick={() => setReportBatchId(batch.id)}>
                          <FileBarChart2 className="w-4 h-4 mr-1.5" />View demo reports
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={resetActive}>Close</Button>
                    </CardContent>
                  </Card>
                )}
                {(batch.status === 'discarded' || batch.status === 'rolled_back') && (
                  <Card>
                    <CardContent className="py-4 flex items-center gap-3 text-sm text-muted-foreground">
                      This batch was {batch.status === 'discarded' ? 'discarded — nothing was ever recorded' : 'rolled back — its records were removed'}.
                      <Button variant="ghost" size="sm" onClick={resetActive}>Close</Button>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </TabsContent>

          {/* ── Mappings tab ───────────────────────────────────────────── */}
          <TabsContent value="mappings" className="mt-4">
            <ManageMappings canEdit={perm.canEdit} canDelete={perm.canDelete} />
          </TabsContent>

          {/* ── History tab ────────────────────────────────────────────── */}
          <TabsContent value="history" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Migrations</CardTitle>
                <CardDescription>
                  Each migration imported as ONE unit — remove deletes everything it created across all
                  its files, or nothing at all. Open migrations can be resumed from the Migration tab.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MigrationHistory canDelete={perm.canDelete} onResume={(id) => { setResumeMigId(id); setTab('migration'); }} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Master &amp; older imports</CardTitle>
                <CardDescription>
                  Delete removes only the records that batch created — it refuses when any of them has
                  since been used. Batches at the mapping or demo stage can be re-opened or discarded.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {loadingHistory ? (
                  <div className="py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
                ) : batches.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">No imports yet.</p>
                ) : (
                  <div className="rounded-lg border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <SortableHead k="batchId" sort={batchSort}>Batch ID</SortableHead>
                          <SortableHead k="when" sort={batchSort}>When</SortableHead>
                          <SortableHead k="module" sort={batchSort}>Module</SortableHead>
                          <SortableHead k="file" sort={batchSort}>File</SortableHead>
                          <SortableHead k="location" sort={batchSort}>Location</SortableHead>
                          <SortableHead k="by" sort={batchSort}>By</SortableHead>
                          <SortableHead k="rows" sort={batchSort} className="text-right">Rows</SortableHead>
                          <SortableHead k="imported" sort={batchSort} className="text-right">Imported</SortableHead>
                          <TableHead>Old voucher nos</TableHead>
                          <SortableHead k="status" sort={batchSort}>Status</SortableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedBatches.map((b) => (
                          <TableRow key={b.id}>
                            <TableCell className="font-mono text-xs whitespace-nowrap">{b.displayId ?? `IMP${String(b.id).padStart(6, '0')}`}</TableCell>
                            <TableCell className="whitespace-nowrap">{fmtTime(b.createdAt)}</TableCell>
                            <TableCell>{MODULE_LABEL(b.module)}</TableCell>
                            <TableCell className="max-w-[12rem] truncate" title={b.filename}>{b.filename}</TableCell>
                            <TableCell className="whitespace-nowrap">{b.locationName ?? '—'}</TableCell>
                            <TableCell>{b.createdBy}</TableCell>
                            <TableCell className="text-right">{b.totalRows}</TableCell>
                            <TableCell className="text-right">
                              {b.status === 'validated' || b.status === 'demo_ready' || b.status === 'discarded' ? '—' : `${b.importedRows}${b.updatedRows ? ` (+${b.updatedRows} upd)` : ''}`}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                              {b.legacyRange?.min ? (b.legacyRange.min === b.legacyRange.max ? b.legacyRange.min : `${b.legacyRange.min} – ${b.legacyRange.max}`) : '—'}
                            </TableCell>
                            <TableCell><BatchStatusBadge b={b} /></TableCell>
                            <TableCell className="text-right whitespace-nowrap">
                              {(b.status === 'validated' || b.status === 'demo_ready') && isWizard(b.module) ? (
                                <Button variant="ghost" size="sm" title="Resume this import" onClick={() => openBatch(b)}>
                                  <PlayCircle className="w-4 h-4 mr-1" />Resume
                                </Button>
                              ) : (
                                <Button variant="ghost" size="sm" title="View rows" onClick={() => setDetailBatchId(b.id)}>
                                  <Eye className="w-4 h-4" />
                                </Button>
                              )}
                              {b.hasDemoReport && (
                                <Button variant="ghost" size="sm" title="View demo reports" onClick={() => setReportBatchId(b.id)}>
                                  <FileBarChart2 className="w-4 h-4" />
                                </Button>
                              )}
                              {b.rollbackAvailable && (
                                <Button
                                  variant="ghost" size="sm"
                                  className="text-destructive hover:text-destructive"
                                  disabled={!perm.canDelete || rollbackBatch.isPending}
                                  onClick={() => setRollbackTarget(b)}
                                >
                                  <RotateCcw className="w-4 h-4 mr-1" />Delete
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Demo report pack viewer */}
      <DemoReportView batchId={reportBatchId} open={reportBatchId != null} onOpenChange={(open) => { if (!open) setReportBatchId(null); }} />

      {/* Approve confirmation */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve this import?</DialogTitle>
            <DialogDescription>
              The {batch?.demoSummary?.imported ?? 0} document{(batch?.demoSummary?.imported ?? 0) === 1 ? '' : 's'} that
              passed the demo will be recorded in your REAL books — stock, GST, ledgers and dues, exactly
              as the demo reports showed. If anything goes wrong midway, nothing at all is recorded.
              {(batch?.demoSummary?.failed ?? 0) > 0 ? ` NOTE: ${batch!.demoSummary!.failed} document${batch!.demoSummary!.failed === 1 ? '' : 's'} that FAILED in the demo will be permanently left out — approve only if you are fine importing without them. ` : ' '}
              The whole batch can still be deleted from History afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(false)}>Cancel</Button>
            <Button onClick={handleApprove} disabled={approveBatch.isPending}>
              {approveBatch.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Approve &amp; record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discard confirmation */}
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard this batch?</DialogTitle>
            <DialogDescription>
              The uploaded file and its analysis will be closed permanently. Nothing was ever recorded
              in your books, and any mappings you saved are kept for next time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDiscard} disabled={discardBatch.isPending}>
              {discardBatch.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Commit confirmation (masters) */}
      <Dialog open={commitOpen} onOpenChange={setCommitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit this import?</DialogTitle>
            <DialogDescription>
              {committableRows.length} {MODULE_LABEL(module).toLowerCase()} row{committableRows.length === 1 ? '' : 's'} will be created
              {hasDuplicates ? ` — duplicates will be ${duplicateAction === 'skip' ? 'skipped' : 'updated'}` : ''}.
              Records are created exactly as if entered manually, and the whole batch can be rolled back
              from History while its records are unused.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommitOpen(false)}>Cancel</Button>
            <Button onClick={handleCommit} disabled={commitBatch.isPending}>
              {commitBatch.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Commit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch detail (row log) */}
      <Dialog open={detailBatchId != null} onOpenChange={(open) => { if (!open) setDetailBatchId(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {detailData ? `${MODULE_LABEL(detailData.batch.module)} — ${detailData.batch.filename}` : 'Batch details'}
            </DialogTitle>
            <DialogDescription>
              {detailData
                ? `${fmtTime(detailData.batch.createdAt)} by ${detailData.batch.createdBy}` +
                  (detailData.batch.legacyRange?.min ? ` · old voucher numbers ${detailData.batch.legacyRange.min} – ${detailData.batch.legacyRange.max}` : '')
                : 'Loading…'}
            </DialogDescription>
          </DialogHeader>
          {detailData && (detailData.batch.errorRows > 0 || detailData.batch.failedRows > 0) && (
            <div>
              <Button variant="outline" size="sm" disabled={!perm.canDownload}
                onClick={() => downloadImportErrorFile(detailData.batch.id, detailData.batch.module).catch((e: any) => toast.error(e?.message ?? 'The error file could not be downloaded.'))}>
                <Download className="w-4 h-4 mr-1.5" />
                Download failed rows (Excel)
              </Button>
            </div>
          )}
          {detailData && (
            <div className="rounded-lg border overflow-x-auto max-h-[24rem] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Row</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-24">Status</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailData.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
                      <TableCell className="font-medium">{rowLabel(detailData.batch.module, r)}</TableCell>
                      <TableCell><RowStatusBadge status={r.status} /></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.reason ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Rollback confirmation */}
      <Dialog open={rollbackTarget != null} onOpenChange={(open) => { if (!open) setRollbackTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this import?</DialogTitle>
            <DialogDescription>
              {rollbackTarget && <span className="block font-medium text-foreground mb-2">
                This will permanently remove ALL records imported in batch {rollbackTarget.displayId ?? `IMP${String(rollbackTarget.id).padStart(6, '0')}`}. This action cannot be undone.
              </span>}
              {rollbackTarget && (isVoucher(rollbackTarget.module) ? (
                <>Every voucher created by "{rollbackTarget.filename}" will be removed — allocations
                unwound so dues are restored, and any advances they created withdrawn. A voucher whose
                advance has since been used blocks the whole rollback with per-voucher reasons.</>
              ) : isTxn(rollbackTarget.module) ? (
                <>Every document created by "{rollbackTarget.filename}" will be reversed — stock restored,
                settlements unwound, books cleaned. Documents that have since gained payments, returns or
                other activity block the whole rollback with per-document reasons.</>
              ) : rollbackTarget.module === 'daybook' ? (
                <>Every journal voucher created by "{rollbackTarget.filename}" will be removed and the
                books cleaned.</>
              ) : rollbackTarget.module === 'opening_stock' ? (
                <>The opening stock recorded by "{rollbackTarget.filename}" will be reversed — stock that
                has since been consumed or moved blocks the rollback with reasons.</>
              ) : (
                <>Every record created by "{rollbackTarget.filename}" will be deleted. Records that have
                since been used block the rollback with a per-record explanation. Updates made to
                pre-existing records are not reverted.</>
              ))}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRollback} disabled={rollbackBatch.isPending}>
              {rollbackBatch.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rollback blocked report */}
      <Dialog open={rollbackBlocked != null} onOpenChange={(open) => { if (!open) setRollbackBlocked(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600" />Rollback refused
            </DialogTitle>
            <DialogDescription>{rollbackBlocked?.error}</DialogDescription>
          </DialogHeader>
          {rollbackBlocked && (
            <div className="rounded-lg border overflow-y-auto max-h-[20rem]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Row</TableHead>
                    <TableHead>Record</TableHead>
                    <TableHead>Why it cannot be removed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rollbackBlocked.blocked.map((r) => (
                    <TableRow key={r.rowNumber}>
                      <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackBlocked(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
