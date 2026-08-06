/**
 * ERP Migration Wizard — ONE guided migration across many files.
 *
 * Step 1  Upload every old-ERP file (sales, purchases, receipts, payments,
 *         day book, opening stock) — one file per type, replace any time.
 * Step 2  Combined check: totals, problem rows, and old names to match.
 * Step 3  Trial run — the REAL import inside a rehearsal that is thrown away;
 *         builds the full report pack from all files together.
 * Step 4  Compare the reports against the old ERP; loop back if needed.
 * Step 5  Approve — pick the location NOW (not earlier), and everything
 *         imports in one all-or-nothing pass. Rollback removes the ENTIRE
 *         migration from History, never part of it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useImportMigrations, useImportMigration, useCreateImportMigration,
  useUploadMigrationFile, useRemoveMigrationFile, useRunMigrationDemo,
  useApproveMigration, useDiscardMigration, useRollbackMigration,
  downloadImportTemplate, downloadImportErrorFile,
  useListWarehouses, useListOutlets,
  type ImportModule, type ImportMigrationListItem, type ImportMigrationFile,
  type ImportMigrationApproveResponse,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { toast } from 'sonner';
import {
  Upload, Download, CheckCircle2, AlertTriangle, XCircle, RotateCcw, Loader2,
  Eye, MapPin, Link2, FlaskConical, FileBarChart2, ThumbsUp, Trash2,
  PlayCircle, Replace, FileSpreadsheet, ArrowRight, Sparkles,
} from 'lucide-react';
import { MODULE_META, MODULE_LABEL, WIZARD_MODULES, fmtTime, fmtMoney } from './shared';
import { MappingStep } from './MappingStep';
import { DemoReportView } from './DemoReportView';

// ── Small pieces ────────────────────────────────────────────────────────────

const STEPS = ['Upload files', 'Check & match', 'Trial run', 'Compare reports', 'Approve'] as const;

function Stepper({ current }: { current: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'now' : 'later';
        return (
          <div key={label} className="flex items-center gap-1">
            <div className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              state === 'now' ? 'bg-primary text-primary-foreground'
                : state === 'done' ? 'bg-emerald-100 text-emerald-800'
                : 'bg-muted text-muted-foreground'}`}>
              {state === 'done' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <span>{n}</span>}
              {label}
            </div>
            {n < STEPS.length && <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/60" />}
          </div>
        );
      })}
    </div>
  );
}

function MigrationStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'draft':       return <Badge variant="secondary">In progress</Badge>;
    case 'demo_ready':  return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Trial done</Badge>;
    case 'committing':  return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Importing…</Badge>;
    case 'committed':   return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Imported</Badge>;
    case 'rolled_back': return <Badge variant="outline">Rolled back</Badge>;
    case 'discarded':   return <Badge variant="outline">Discarded</Badge>;
    default:            return <Badge variant="outline">{status}</Badge>;
  }
}

const ISSUE_LABEL: Record<string, string> = {
  duplicates: 'Already in your books (duplicates)',
  invalidGst: 'Invalid GST numbers',
  invalidDates: 'Invalid dates',
  invalidAmounts: 'Invalid amounts / quantities',
  other: 'Other problems',
};
const MASTER_LABEL: Record<string, [string, string]> = {
  customer: ['Customers', 'customers'],
  vendor: ['Vendors', 'vendors'],
  product: ['Items', 'items'],
  ledger: ['Ledgers', 'ledgers'],
};

// ── The wizard ──────────────────────────────────────────────────────────────

export function MigrationWizard({ canAdd, canDelete, canDownload, resumeId = null }: {
  canAdd: boolean; canDelete: boolean; canDownload: boolean;
  /** Migration the user picked via History → Resume — honoured while still open. */
  resumeId?: number | null;
}) {
  const { data: listData, isLoading: loadingList } = useImportMigrations();
  const migrations = useMemo(() => listData?.migrations ?? [], [listData]);
  /** The one migration being worked on — the resumed one if still open, else the newest open one. */
  const activeId = useMemo(() => {
    const isOpen = (m: ImportMigrationListItem) =>
      m.status === 'draft' || m.status === 'demo_ready' || m.status === 'committing';
    if (resumeId != null) {
      const chosen = migrations.find((m) => m.id === resumeId && isOpen(m));
      if (chosen) return chosen.id;
    }
    const open = migrations.find(isOpen);
    return open?.id ?? null;
  }, [migrations, resumeId]);
  const { data: detail } = useImportMigration(activeId);

  const createMigration = useCreateImportMigration();
  const uploadFile = useUploadMigrationFile();
  const removeFile = useRemoveMigrationFile();
  const runDemo = useRunMigrationDemo();
  const approveMigration = useApproveMigration();
  const discardMigration = useDiscardMigration();
  const { data: warehouses } = useListWarehouses();
  const { data: outlets } = useListOutlets();

  const [pendingModule, setPendingModule] = useState<ImportModule | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [location, setLocation] = useState('');
  const [approveResult, setApproveResult] = useState<ImportMigrationApproveResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A different migration (or none) became active — transient choices from the
  // previous one must never carry over, especially the approval location.
  useEffect(() => {
    setLocation('');
    setApproveOpen(false);
    setDiscardOpen(false);
    setReportOpen(false);
    setPendingModule(null);
  }, [activeId]);

  // The native file chooser fires 'cancel' (never 'change') when dismissed —
  // clear the routing state so a later upload can't target a stale module.
  // Re-attach whenever the input mounts (it only renders with an open migration).
  useEffect(() => {
    const el = fileInputRef.current;
    if (!el) return;
    const onCancel = () => setPendingModule(null);
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [activeId]);

  const mig = detail?.migration ?? null;
  const files = useMemo(() => detail?.files ?? [], [detail]);
  const analysis = detail?.analysis;
  const unmappedTotal = detail?.unmappedTotal ?? 0;
  const byModule = useMemo(() => new Map(files.map((f) => [f.module, f])), [files]);

  const hardErrorFiles = files.filter((f) => f.hardErrorRows > 0);
  const hardErrors = hardErrorFiles.reduce((s, f) => s + f.hardErrorRows, 0);
  const totalDocs = files.reduce((s, f) => s + f.docCount, 0);
  const totalMoney = files.reduce((s, f) => s + f.moneyTotal, 0);

  const step = !mig || files.length === 0 ? 1
    : hardErrors > 0 || unmappedTotal > 0 ? 2
    : mig.status === 'draft' ? 3
    : mig.status === 'demo_ready' ? 4
    : 5;

  const handleStart = async () => {
    try {
      await createMigration.mutateAsync();
      setApproveResult(null);
      toast.success('Migration started — upload your old-ERP files below.');
    } catch (e: any) {
      toast.error(e?.message ?? 'The migration could not be started.');
    }
  };

  const pickFile = (m: ImportModule) => {
    setPendingModule(m);
    fileInputRef.current?.click();
  };

  const handleFilePicked = async (file: File) => {
    const m = pendingModule;
    if (!m || activeId == null) { setPendingModule(null); return; }
    try {
      const r = await uploadFile.mutateAsync({ id: activeId, module: m, file });
      const f = (r.files ?? []).find((x) => x.module === m);
      if (!f) { toast.success('File analysed.'); return; }
      if (f.needsMappingRows > 0) toast.info(`${MODULE_LABEL(m)}: ${f.needsMappingRows} row${f.needsMappingRows === 1 ? '' : 's'} carry old names not seen before — match them in the step below.`);
      else if (f.hardErrorRows > 0) toast.warning(`${MODULE_LABEL(m)}: ${f.hardErrorRows} row${f.hardErrorRows === 1 ? '' : 's'} have problems — download them below, fix in Excel and upload the file again.`);
      else toast.success(`${MODULE_LABEL(m)} file analysed — ${f.validRows} valid, ${f.warningRows} warning${f.warningRows === 1 ? '' : 's'}. Nothing has been recorded.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'That file could not be read.');
    } finally {
      setPendingModule(null);
    }
  };

  const handleRemove = async (m: ImportModule) => {
    if (activeId == null) return;
    try {
      await removeFile.mutateAsync({ id: activeId, module: m });
      toast.success(`${MODULE_LABEL(m)} file removed.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'The file could not be removed.');
    }
  };

  const handleSample = async (m: ImportModule) => {
    try {
      await downloadImportTemplate(m);
      toast.success(`${MODULE_LABEL(m)} sample downloaded — fill it in and upload it here.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'The sample could not be downloaded.');
    }
  };

  const handleDemo = async () => {
    if (activeId == null) return;
    try {
      const r = await runDemo.mutateAsync({ id: activeId });
      if (r.summary.failed > 0) toast.warning(`Trial finished — ${r.summary.imported} would import, ${r.summary.failed} FAILED. Fix the causes below and run the trial again; approval needs a clean trial.`);
      else toast.success(`Trial finished — ${r.summary.imported} document${r.summary.imported === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'} would import. Nothing was recorded. Compare the reports next.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'The trial run failed.');
    }
  };

  const handleApprove = async () => {
    if (activeId == null || !location) return;
    const [locType, locId] = location.split('|');
    try {
      const r = await approveMigration.mutateAsync({ id: activeId, locationType: locType, locationId: Number(locId) });
      setApproveOpen(false);
      setApproveResult(r);
      toast.success(`Migration imported — ${r.summary.imported} document${r.summary.imported === 1 ? '' : 's'} recorded in your books.`);
    } catch (e: any) {
      setApproveOpen(false);
      toast.error(e?.message ?? 'The import could not be completed — nothing was recorded.');
    }
  };

  const handleDiscard = async () => {
    if (activeId == null) return;
    try {
      await discardMigration.mutateAsync({ id: activeId });
      setDiscardOpen(false);
      toast.success('Migration discarded — nothing was ever recorded in your books.');
    } catch (e: any) {
      setDiscardOpen(false);
      toast.error(e?.message ?? 'The migration could not be discarded.');
    }
  };

  if (loadingList) {
    return <div className="py-10 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  }

  // ── No open migration: start card (+ last result panel) ──
  if (activeId == null) {
    return (
      <div className="space-y-4">
        {approveResult && <ApproveResultCard result={approveResult} onDismiss={() => setApproveResult(null)} />}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-primary" />
              Move your old ERP into this one
            </CardTitle>
            <CardDescription>
              One guided migration: upload all your old-ERP files, match the old names once, run a
              trial that shows the full reports (trial balance, P&amp;L, balance sheet, dues, stock,
              cash &amp; bank) — and only after the figures match do you pick the location and approve.
              Nothing touches your books until then, and the whole migration can be removed in one go
              afterwards.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleStart} disabled={!canAdd || createMigration.isPending}>
              {createMigration.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-1.5" />}
              Start migration
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef} type="file" accept=".xlsx" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFilePicked(f);
          e.target.value = '';
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Stepper current={step} />
        {mig && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{mig.displayId}</span>
            <MigrationStatusBadge status={mig.status} />
          </div>
        )}
      </div>

      {/* ── Step 1: files ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Step 1 — Upload your old-ERP files</CardTitle>
          <CardDescription>
            One file per type; upload the ones you have — replacing a file re-checks everything.
            Leave any “Location” column in the files blank: you pick the location at the very end,
            after the trial reports match your old ERP.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {WIZARD_MODULES.map((m) => {
              const meta = MODULE_META[m];
              const Icon = meta.icon;
              const f = byModule.get(m);
              return (
                <div key={m} className={`rounded-lg border p-3 space-y-2 ${f ? 'border-primary/40 bg-primary/[0.03]' : ''}`}>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Icon className={`w-4 h-4 ${f ? 'text-primary' : 'text-muted-foreground'}`} />
                    {meta.label}
                    {m === 'opening_stock' && <span className="text-[10px] text-muted-foreground font-normal">(optional)</span>}
                  </div>
                  {f ? (
                    <>
                      <div className="text-xs text-muted-foreground truncate" title={f.filename}>{f.filename}</div>
                      {f.conversion && (
                        <div className="rounded-md border border-blue-200 bg-blue-50 p-2 space-y-0.5">
                          <div className="text-[11px] font-medium text-blue-900 flex items-center gap-1">
                            <Sparkles className="w-3 h-3" />
                            Old software report detected — converted automatically
                          </div>
                          <div className="text-[11px] text-blue-800">
                            {f.conversion.report}: {f.conversion.keptRows} row{f.conversion.keptRows === 1 ? '' : 's'} kept
                            {f.conversion.droppedRows > 0 ? `, ${f.conversion.droppedRows} banner/total row${f.conversion.droppedRows === 1 ? '' : 's'} dropped` : ''}
                          </div>
                          {(f.conversion.notes ?? []).length > 0 && (
                            <ul className="text-[10px] text-blue-800/90 list-disc pl-4 max-h-24 overflow-y-auto">
                              {f.conversion.notes.map((n, i) => <li key={i}>{n}</li>)}
                            </ul>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1 text-[11px]">
                        <Badge variant="outline" className="px-1 py-0">{f.docCount} doc{f.docCount === 1 ? '' : 's'}</Badge>
                        {f.moneyTotal > 0 && <Badge variant="outline" className="px-1 py-0">{fmtMoney(f.moneyTotal)}</Badge>}
                        {f.validRows > 0 && <Badge className="px-1 py-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">{f.validRows} ok</Badge>}
                        {f.warningRows > 0 && <Badge className="px-1 py-0 bg-amber-100 text-amber-800 hover:bg-amber-100">{f.warningRows} warning{f.warningRows === 1 ? '' : 's'}</Badge>}
                        {f.needsMappingRows > 0 && <Badge className="px-1 py-0 bg-blue-100 text-blue-800 hover:bg-blue-100">{f.needsMappingRows} to match</Badge>}
                        {f.hardErrorRows > 0 && <Badge variant="destructive" className="px-1 py-0">{f.hardErrorRows} problem{f.hardErrorRows === 1 ? '' : 's'}</Badge>}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!canAdd || !mig?.canEdit || uploadFile.isPending}
                          onClick={() => pickFile(m)}>
                          <Replace className="w-3 h-3 mr-1" />Replace
                        </Button>
                        {f.hardErrorRows > 0 && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!canDownload}
                            onClick={() => downloadImportErrorFile(f.id, m).catch((e: any) => toast.error(e?.message ?? 'The error file could not be downloaded.'))}>
                            <Download className="w-3 h-3 mr-1" />Problem rows
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive"
                          disabled={!canDelete || !mig?.canEdit || removeFile.isPending} onClick={() => handleRemove(m)}>
                          <Trash2 className="w-3 h-3 mr-1" />Remove
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">{meta.blurb}</p>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" className="h-7 text-xs" disabled={!canAdd || !mig?.canEdit || uploadFile.isPending}
                          onClick={() => pickFile(m)}>
                          {uploadFile.isPending && pendingModule === m
                            ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            : <Upload className="w-3 h-3 mr-1" />}
                          Upload
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!canDownload} onClick={() => handleSample(m)}>
                          <Download className="w-3 h-3 mr-1" />Sample
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── Step 2: combined check ── */}
      {files.length > 0 && analysis && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Step 2 — What the files contain</CardTitle>
            <CardDescription>
              Checked together, nothing recorded. Problem rows must be fixed in the file and
              re-uploaded; old names are matched once in the step below and remembered forever.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border p-3">
                <div className="text-2xl font-bold">{files.length}</div>
                <div className="text-xs text-muted-foreground">Files</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-2xl font-bold">{totalDocs}</div>
                <div className="text-xs text-muted-foreground">Documents</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-2xl font-bold tabular-nums">{fmtMoney(totalMoney)}</div>
                <div className="text-xs text-muted-foreground">Money value</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className={`text-2xl font-bold flex items-center gap-1 ${hardErrors + unmappedTotal > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {hardErrors + unmappedTotal > 0 ? <AlertTriangle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
                  {hardErrors + unmappedTotal}
                </div>
                <div className="text-xs text-muted-foreground">To sort out ({hardErrors} problem row{hardErrors === 1 ? '' : 's'}, {unmappedTotal} name{unmappedTotal === 1 ? '' : 's'} to match)</div>
              </div>
            </div>

            {Object.entries(analysis.masters).length > 0 && (
              <div className="flex flex-wrap gap-2">
                {Object.entries(analysis.masters).map(([kind, v]) => (
                  <Badge key={kind} variant="outline" className="font-normal">
                    {MASTER_LABEL[kind]?.[0] ?? kind}: {v.found} matched{v.missing > 0 ? `, ${v.missing} new to match` : ''}
                  </Badge>
                ))}
              </div>
            )}

            {Object.entries(analysis.issues).filter(([, n]) => n > 0).length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <XCircle className="w-4 h-4 text-destructive" />Problem rows — fix the file in Excel and upload it again
                </div>
                <ul className="text-xs text-muted-foreground list-disc pl-5">
                  {Object.entries(analysis.issues).filter(([, n]) => n > 0).map(([k, n]) => (
                    <li key={k}>{ISSUE_LABEL[k] ?? k}: {n} row{n === 1 ? '' : 's'}</li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {hardErrorFiles.map((f) => (
                    <Button key={f.id} size="sm" variant="outline" className="h-7 text-xs" disabled={!canDownload}
                      onClick={() => downloadImportErrorFile(f.id, f.module).catch((e: any) => toast.error(e?.message ?? 'The error file could not be downloaded.'))}>
                      <Download className="w-3 h-3 mr-1" />{MODULE_LABEL(f.module)} problem rows
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Step 2b: match names ── */}
      {files.length > 0 && unmappedTotal > 0 && mig?.canEdit && (
        <MappingStep key={`mig-${activeId}`} migrationId={activeId} canEdit={canAdd} />
      )}

      {/* ── Step 3: trial run ── */}
      {files.length > 0 && mig?.status === 'draft' && unmappedTotal === 0 && hardErrors === 0 && (
        <Card className="border-primary/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-primary" />
              Step 3 — Trial run (nothing is recorded)
            </CardTitle>
            <CardDescription>
              All files run through the REAL import together — full accounting, stock, GST and new
              ERP voucher numbers, with your old numbers kept alongside — inside a rehearsal that is
              thrown away. You get the complete report pack to put beside your old ERP.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={handleDemo} disabled={!canAdd || runDemo.isPending}>
              {runDemo.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <PlayCircle className="w-4 h-4 mr-1.5" />}
              Run the trial
            </Button>
            <Button variant="outline" className="text-destructive hover:text-destructive"
              onClick={() => setDiscardOpen(true)} disabled={!canDelete || !mig?.canDiscard}>
              <Trash2 className="w-4 h-4 mr-1.5" />Discard migration
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Step 4: compare & approve ── */}
      {mig?.status === 'demo_ready' && (
        <Card className="border-blue-300">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileBarChart2 className="w-4 h-4 text-blue-600" />
              Step 4 — Compare with your old ERP, then approve
            </CardTitle>
            <CardDescription>
              Trial run {mig.demoAt ? fmtTime(mig.demoAt) : ''} by {mig.demoBy ?? ''}. Nothing has
              been recorded. Open the reports and put your old ERP beside them. If a figure
              disagrees, fix the file or the matches — the trial re-runs in seconds.
              {mig.legacyRange?.min ? ` Covers old voucher numbers ${mig.legacyRange.min} – ${mig.legacyRange.max}.` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {mig.demoSummary && (
              <div className="rounded-lg border overflow-x-auto">
                <Table className="no-sticky-col">
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead className="text-right">Would import</TableHead>
                      <TableHead className="text-right">Skipped</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                      <TableHead>Old voucher numbers</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(mig.demoSummary.perModule ?? {}).map(([m, s]) => (
                      <TableRow key={m}>
                        <TableCell className="text-sm">{MODULE_LABEL(m)}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{s.imported}</TableCell>
                        <TableCell className={`text-right tabular-nums text-sm ${(s.skipped ?? 0) > 0 ? 'text-amber-700' : 'text-muted-foreground'}`}>{s.skipped ?? 0}</TableCell>
                        <TableCell className={`text-right tabular-nums text-sm ${s.failed > 0 ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>{s.failed}</TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {s.legacyMin ? (s.legacyMin === s.legacyMax ? s.legacyMin : `${s.legacyMin} – ${s.legacyMax}`) : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold bg-muted/40">
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right tabular-nums">{mig.demoSummary.imported}</TableCell>
                      <TableCell className="text-right tabular-nums">{mig.demoSummary.skipped ?? 0}</TableCell>
                      <TableCell className={`text-right tabular-nums ${mig.demoSummary.failed > 0 ? 'text-destructive' : ''}`}>{mig.demoSummary.failed}</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}

            {(mig.demoSummary?.failures?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  {mig.demoSummary!.failures.length} document{mig.demoSummary!.failures.length === 1 ? '' : 's'} failed in the trial — approval needs a clean trial
                </div>
                <ul className="text-xs text-muted-foreground list-disc pl-5 max-h-40 overflow-y-auto">
                  {mig.demoSummary!.failures.map((f, i) => (
                    <li key={i}><span className="font-medium text-foreground">{MODULE_LABEL(f.module)} · {f.name}</span> — {f.reason}</li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">Fix the file (or the matches) and run the trial again.</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setReportOpen(true)}>
                <FileBarChart2 className="w-4 h-4 mr-1.5" />View comparison reports
              </Button>
              <Button variant="outline" onClick={handleDemo} disabled={!canAdd || runDemo.isPending}>
                {runDemo.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RotateCcw className="w-4 h-4 mr-1.5" />}
                Re-run trial
              </Button>
              <Button onClick={() => setApproveOpen(true)} disabled={!canAdd || !mig.canApprove}>
                <ThumbsUp className="w-4 h-4 mr-1.5" />Approve — pick location &amp; import
              </Button>
              <Button variant="outline" className="text-destructive hover:text-destructive"
                onClick={() => setDiscardOpen(true)} disabled={!canDelete || !mig.canDiscard}>
                <Trash2 className="w-4 h-4 mr-1.5" />Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {mig?.status === 'committing' && (
        <Card>
          <CardContent className="py-4 flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            The migration is being imported — this can take a moment.
          </CardContent>
        </Card>
      )}

      {/* Report pack viewer */}
      <DemoReportView migrationId={activeId} open={reportOpen} onOpenChange={setReportOpen} />

      {/* Approve dialog — the location is chosen HERE, last. */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve the migration?</DialogTitle>
            <DialogDescription>
              The {mig?.demoSummary?.imported ?? 0} document{(mig?.demoSummary?.imported ?? 0) === 1 ? '' : 's'} the
              trial showed will be recorded in your REAL books — stock, GST, ledgers and dues, exactly
              as the reports showed. Everything imports in one pass: if anything goes wrong midway,
              nothing at all is recorded. Afterwards the whole migration can still be removed in one
              go from History.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <div className="text-sm font-medium flex items-center gap-1.5"><MapPin className="w-4 h-4 text-primary" />Where do these documents belong?</div>
            <Select value={location} onValueChange={setLocation}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose the location…" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="headoffice|1">Head Office</SelectItem>
                {(warehouses ?? []).map((w: any) => (
                  <SelectItem key={`w${w.id}`} value={`warehouse|${w.id}`}>{w.name} (Warehouse)</SelectItem>
                ))}
                {(outlets ?? []).map((o: any) => (
                  <SelectItem key={`o${o.id}`} value={`outlet|${o.id}`}>{o.name} (Outlet)</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Every document, its stock and its ledger effects are recorded at this location.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(false)}>Cancel</Button>
            <Button onClick={handleApprove} disabled={!location || approveMigration.isPending}>
              {approveMigration.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Approve &amp; import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discard dialog */}
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard this migration?</DialogTitle>
            <DialogDescription>
              All uploaded files and their checks are closed permanently. Nothing was ever recorded
              in your books, and any name matches you saved are kept for next time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDiscard} disabled={!canDelete || discardMigration.isPending}>
              {discardMigration.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ApproveResultCard({ result, onDismiss }: { result: ImportMigrationApproveResponse; onDismiss: () => void }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          Migration imported — {result.migration.displayId}
        </CardTitle>
        <CardDescription>
          Counted from the records actually created in your books.
          {result.details ? ` Finished in ${(result.details.timeTakenMs / 1000).toFixed(1)}s.` : ''}
          {result.migration.legacyRange?.min ? ` Old voucher numbers ${result.migration.legacyRange.min} – ${result.migration.legacyRange.max} are searchable on every screen.` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(result.details?.recordCounts ?? {})
            .filter(([, v]) => Number(v) > 0)
            .map(([label, value]) => (
              <div key={label} className="rounded-lg border p-3">
                <div className="text-xl font-bold">{value}</div>
                <div className="text-xs text-muted-foreground capitalize">{label.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
              </div>
            ))}
        </div>
        <p className="text-xs text-muted-foreground">
          The whole migration can be removed in one go from History while its records are untouched.
        </p>
        <div><Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button></div>
      </CardContent>
    </Card>
  );
}

// ── Migration history (for the History tab) ─────────────────────────────────

export function MigrationHistory({ canDelete, onResume }: { canDelete: boolean; onResume: (id: number) => void }) {
  const { data, isLoading } = useImportMigrations();
  const rollbackMigration = useRollbackMigration();
  const [rollbackTarget, setRollbackTarget] = useState<ImportMigrationListItem | null>(null);
  const [blocked, setBlocked] = useState<{ error: string; blocked: Array<{ module: string; name: string; reason: string }> } | null>(null);
  const [reportId, setReportId] = useState<number | null>(null);

  const migrations = data?.migrations ?? [];
  const { sorted, sort } = useTableSort(migrations, {
    migId: (m) => m.displayId,
    when: (m) => m.createdAt,
    by: (m) => m.createdBy,
    files: (m) => m.files.length,
    location: (m) => m.locationName,
    status: (m) => m.status,
  });

  const handleRollback = async () => {
    if (!rollbackTarget) return;
    try {
      const r = await rollbackMigration.mutateAsync({ id: rollbackTarget.id });
      setRollbackTarget(null);
      if (r.verification && !r.verification.ok) {
        toast.warning(`Removed ${r.removed} record${r.removed === 1 ? '' : 's'}, but the automatic post-deletion check flagged an issue — check the audit log.`);
      } else {
        toast.success(`Migration removed — ${r.removed} record${r.removed === 1 ? '' : 's'} deleted. Books verified: balanced, nothing left behind.`);
      }
    } catch (e: any) {
      setRollbackTarget(null);
      const body = e?.data as { error: string; blocked?: Array<{ module: string; name: string; reason: string }> } | undefined;
      if (body?.blocked?.length) setBlocked({ error: body.error, blocked: body.blocked });
      else toast.error(e?.message ?? 'The rollback failed.');
    }
  };

  if (isLoading) {
    return <div className="py-6 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  }
  if (migrations.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No migrations yet.</p>;
  }

  return (
    <>
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead k="migId" sort={sort}>Migration</SortableHead>
              <SortableHead k="when" sort={sort}>When</SortableHead>
              <SortableHead k="by" sort={sort}>By</SortableHead>
              <SortableHead k="files" sort={sort}>Files</SortableHead>
              <SortableHead k="location" sort={sort}>Location</SortableHead>
              <TableHead>Old voucher nos</TableHead>
              <SortableHead k="status" sort={sort}>Status</SortableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-mono text-xs whitespace-nowrap">{m.displayId}</TableCell>
                <TableCell className="whitespace-nowrap">{fmtTime(m.createdAt)}</TableCell>
                <TableCell>{m.createdBy}</TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[16rem]">
                  {m.files.length === 0 ? '—' : m.files.map((f) => `${MODULE_LABEL(f.module)} (${f.importedRows ?? f.totalRows})`).join(', ')}
                </TableCell>
                <TableCell className="whitespace-nowrap">{m.locationName ?? '—'}</TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                  {m.legacyRange?.min ? (m.legacyRange.min === m.legacyRange.max ? m.legacyRange.min : `${m.legacyRange.min} – ${m.legacyRange.max}`) : '—'}
                </TableCell>
                <TableCell><MigrationStatusBadge status={m.status} /></TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {(m.status === 'draft' || m.status === 'demo_ready') && (
                    <Button variant="ghost" size="sm" title="Continue this migration" onClick={() => onResume(m.id)}>
                      <PlayCircle className="w-4 h-4 mr-1" />Resume
                    </Button>
                  )}
                  {m.hasDemoReport && (
                    <Button variant="ghost" size="sm" title="View trial reports" onClick={() => setReportId(m.id)}>
                      <FileBarChart2 className="w-4 h-4" />
                    </Button>
                  )}
                  {m.rollbackAvailable && (
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                      disabled={!canDelete || rollbackMigration.isPending} onClick={() => setRollbackTarget(m)}>
                      <RotateCcw className="w-4 h-4 mr-1" />Remove
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <DemoReportView migrationId={reportId} open={reportId != null} onOpenChange={(open) => { if (!open) setReportId(null); }} />

      {/* Rollback confirmation */}
      <Dialog open={rollbackTarget != null} onOpenChange={(open) => { if (!open) setRollbackTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this whole migration?</DialogTitle>
            <DialogDescription>
              <span className="block font-medium text-foreground mb-2">
                Every record migration {rollbackTarget?.displayId} created — across ALL its files — will be
                permanently removed in one pass. This cannot be undone.
              </span>
              Stock is restored, settlements unwound and the books cleaned. If any imported record has
              since gained payments, returns or other activity, NOTHING is removed and you get the
              per-record reasons. A migration is never removed in part.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRollback} disabled={rollbackMigration.isPending}>
              {rollbackMigration.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Remove everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rollback blocked */}
      <Dialog open={blocked != null} onOpenChange={(open) => { if (!open) setBlocked(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600" />Nothing was removed
            </DialogTitle>
            <DialogDescription>{blocked?.error}</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border overflow-y-auto max-h-[20rem]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Why it blocks</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(blocked?.blocked ?? []).map((b, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{MODULE_LABEL(b.module)}</TableCell>
                    <TableCell className="text-sm font-medium">{b.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{b.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlocked(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
