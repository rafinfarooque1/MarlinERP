/**
 * Import Data (Company).
 *
 * Tally/Zoho-style migration of old-ERP masters: pick a module, download the
 * pre-filled sample, upload the filled file, review the validation preview
 * (per-row reason + suggestion), then commit. Every verdict is computed on the
 * server; this page displays it. History lists every batch with rollback,
 * whose real eligibility is decided server-side at click time — a batch whose
 * records have since been used refuses with per-record reasons.
 */
import { useMemo, useRef, useState } from 'react';
import {
  useImportBatches, useImportBatch, useParseImportFile, useCommitImportBatch,
  useRollbackImportBatch, useResolveImportParties, downloadImportTemplate,
  downloadImportErrorFile, useListWarehouses, useListOutlets,
  type ImportModule, type ImportBatch, type ImportRow, type ImportRollbackBlocked,
  type ImportPartyInput, type ImportTxnSummary, type ImportCommitResponse,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { toast } from 'sonner';
import {
  ShieldOff, Upload, Download, FileSpreadsheet, Users, Truck, BookOpen,
  CheckCircle2, AlertTriangle, XCircle, RotateCcw, Loader2, History, Eye,
  ShoppingCart, Package, MapPin, UserPlus, Receipt, Banknote,
} from 'lucide-react';

// ── Module metadata ─────────────────────────────────────────────────────────

const MODULE_META: Record<ImportModule, { label: string; icon: typeof Users; blurb: string }> = {
  customers: {
    label: 'Customers', icon: Users,
    blurb: 'Creates customers with their debtor ledgers, credit limits and opening balances.',
  },
  vendors: {
    label: 'Vendors', icon: Truck,
    blurb: 'Creates vendors with their creditor ledgers and opening balances.',
  },
  ledgers: {
    label: 'Ledgers', icon: BookOpen,
    blurb: 'Creates chart-of-accounts ledgers under a valid group, with opening balances.',
  },
  sales: {
    label: 'Sales', icon: ShoppingCart,
    blurb: 'Records old-ERP sales invoices with full stock, GST and settlement effects at a chosen location.',
  },
  purchases: {
    label: 'Purchases', icon: Package,
    blurb: 'Records old-ERP purchase bills with stock, average cost, GST and vendor settlement effects.',
  },
  receipts: {
    label: 'Receipts', icon: Receipt,
    blurb: 'Records money received from customers — allocated against outstanding invoices, excess parked as advances.',
  },
  payments: {
    label: 'Payments', icon: Banknote,
    blurb: 'Records money paid to vendors — allocated against outstanding bills, excess parked as advances.',
  },
};

/** Transaction imports: whole documents with stock effects. */
const isTxn = (m: ImportModule) => m === 'sales' || m === 'purchases';
/** Voucher imports: receipts & payments with invoice allocation. */
const isVoucher = (m: ImportModule) => m === 'receipts' || m === 'payments';
/** Which imports need a target location and a party-resolution step. */
const needsLocation = (m: ImportModule) => isTxn(m) || isVoucher(m);
/** Whose party master the import references. */
const partyIsCustomer = (m: ImportModule) => m === 'sales' || m === 'receipts';

/** What to show in the "Name" column — masters have a name, documents don't. */
const rowLabel = (m: ImportModule, r: ImportRow) =>
  isVoucher(m)
    ? [r.values.voucherNo, r.values.party, r.values.amount && `₹${r.values.amount}`].filter(Boolean).join(' · ') || '—'
    : isTxn(m)
      ? [r.values.invoiceNo, r.values.party, r.values.item].filter(Boolean).join(' · ') || '—'
      : r.values.name ?? '—';

/** Planned (preview) or recorded (post-commit) allocation for a voucher row. */
function AllocationCell({ r }: { r: ImportRow }) {
  const allocations = r.created?.allocations ?? r.plan?.allocations ?? null;
  const advance = r.created?.advanceAmount ?? r.plan?.advance ?? 0;
  if (!allocations) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5 text-xs">
      {allocations.map((a) => (
        <div key={a.id} className="whitespace-nowrap">
          {a.invoiceNumber ?? `#${a.id}`} — ₹{a.amount.toFixed(2)}
        </div>
      ))}
      {advance > 0 && (
        <div className="whitespace-nowrap font-medium text-amber-700">Advance ₹{advance.toFixed(2)}</div>
      )}
      {allocations.length === 0 && advance <= 0 && <span className="text-muted-foreground">—</span>}
    </div>
  );
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

const MODULE_LABEL = (m: string) => MODULE_META[m as ImportModule]?.label ?? m;

// ── Status badges ───────────────────────────────────────────────────────────

function RowStatusBadge({ status }: { status: ImportRow['status'] }) {
  switch (status) {
    case 'valid':       return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Valid</Badge>;
    case 'warning':     return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Warning</Badge>;
    case 'needs_party': return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Needs party</Badge>;
    case 'error':       return <Badge variant="destructive">Error</Badge>;
    case 'imported':    return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Imported</Badge>;
    case 'updated':     return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Updated</Badge>;
    case 'skipped':     return <Badge variant="secondary">Skipped</Badge>;
    case 'failed':      return <Badge variant="destructive">Failed</Badge>;
    case 'rolled_back': return <Badge variant="outline">Rolled back</Badge>;
    default:            return <Badge variant="outline">{status}</Badge>;
  }
}

function BatchStatusBadge({ b }: { b: ImportBatch }) {
  switch (b.status) {
    case 'validated':   return <Badge variant="secondary">Awaiting commit</Badge>;
    case 'committing':  return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Committing…</Badge>;
    case 'committed':   return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Committed</Badge>;
    case 'rolled_back': return <Badge variant="outline">Rolled back</Badge>;
    default:            return <Badge variant="outline">{b.status}</Badge>;
  }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ImportData() {
  const perm = usePermission('page:/company/import');

  const [module, setModule] = useState<ImportModule>('customers');
  const [preview, setPreview] = useState<{ batch: ImportBatch; rows: ImportRow[]; summary?: ImportTxnSummary } | null>(null);
  /** Result panel shown after a commit finishes. */
  const [commitResult, setCommitResult] = useState<ImportCommitResponse | null>(null);
  const [skippedRowIds, setSkippedRowIds] = useState<Set<number>>(new Set());
  const [duplicateAction, setDuplicateAction] = useState<'skip' | 'update'>('skip');
  const [commitOpen, setCommitOpen] = useState(false);
  const [detailBatchId, setDetailBatchId] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ImportBatch | null>(null);
  const [rollbackBlocked, setRollbackBlocked] = useState<ImportRollbackBlocked | null>(null);
  /** Target location for sales/purchase imports, as "type|id". */
  const [location, setLocation] = useState<string>('');
  /** Editable mini-forms for the resolve-missing-parties step, keyed by name. */
  const [partyForms, setPartyForms] = useState<Record<string, ImportPartyInput>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: historyData, isLoading: loadingHistory } = useImportBatches();
  const { data: detailData } = useImportBatch(detailBatchId);
  const { data: warehouses } = useListWarehouses();
  const { data: outlets } = useListOutlets();
  const parseFile = useParseImportFile();
  const commitBatch = useCommitImportBatch();
  const rollbackBatch = useRollbackImportBatch();
  const resolveParties = useResolveImportParties();

  const batches = historyData?.batches ?? [];

  const { sorted: sortedBatches, sort: batchSort } = useTableSort(batches, {
    batchId: b => b.displayId ?? `IMP${String(b.id).padStart(6, '0')}`,
    when: b => b.createdAt,
    module: b => MODULE_LABEL(b.module),
    file: b => b.filename,
    location: b => b.locationName,
    by: b => b.createdBy,
    rows: b => Number(b.totalRows),
    imported: b => b.status === 'validated' ? null : Number(b.importedRows),
    failed: b => b.status === 'validated' ? null : Number(b.failedRows),
    status: b => b.status,
  });

  const txn = isTxn(module);
  const voucher = isVoucher(module);
  const locationRequired = needsLocation(module);
  const partyWord = partyIsCustomer(module) ? 'customer' : 'vendor';

  /** Unique missing parties in the current preview, with prefills from the file. */
  const missingParties = useMemo(() => {
    if (!preview) return [] as Array<{ name: string; gstNumber: string }>;
    const seen = new Map<string, { name: string; gstNumber: string }>();
    for (const r of preview.rows) {
      if (r.status !== 'needs_party' || !r.missingParty) continue;
      const key = r.missingParty.toLowerCase();
      const existing = seen.get(key);
      if (!existing) seen.set(key, { name: r.missingParty, gstNumber: (r.values.gstNumber ?? '').trim() });
      else if (!existing.gstNumber && (r.values.gstNumber ?? '').trim()) existing.gstNumber = r.values.gstNumber.trim();
    }
    return [...seen.values()];
  }, [preview]);

  const partyForm = (name: string, gst: string): ImportPartyInput =>
    partyForms[name] ?? { name, gstNumber: gst };
  const setPartyField = (name: string, gst: string, field: keyof ImportPartyInput, value: string) => {
    setPartyForms((prev) => ({
      ...prev,
      [name]: {
        ...partyForm(name, gst),
        [field]: field === 'creditLimit' ? (value === '' ? undefined : Number(value)) : value,
      },
    }));
  };

  const handleResolveParties = async () => {
    if (!preview || missingParties.length === 0) return;
    try {
      const r = await resolveParties.mutateAsync({
        id: preview.batch.id,
        parties: missingParties.map((p) => partyForm(p.name, p.gstNumber)),
      });
      setPreview({ batch: r.batch, rows: r.rows, summary: r.summary });
      setPartyForms({});
      if (r.errors.length > 0) {
        toast.warning(`${r.created.length} created, ${r.errors.length} failed: ${r.errors.map((e) => `${e.name} — ${e.reason}`).join('; ')}`);
      } else {
        toast.success(`${r.created.length} ${partyWord}${r.created.length === 1 ? '' : 's'} created with ledgers${r.skipped.length ? ` (${r.skipped.length} already existed)` : ''} — rows re-validated.`);
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'The parties could not be created.');
    }
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
        ...(locationRequired ? { locationType: locType, locationId: Number(locId) } : {}),
      });
      setPreview(r);
      setCommitResult(null);
      setSkippedRowIds(new Set());
      setDuplicateAction('skip');
      setPartyForms({});
      const { validRows, warningRows, errorRows } = r.batch;
      const needsParty = r.rows.filter((row) => row.status === 'needs_party').length;
      if (needsParty > 0) toast.info(`${needsParty} row${needsParty === 1 ? '' : 's'} reference ${partyWord}s that don't exist yet — create them in the resolve step below.`);
      else if (errorRows > 0) toast.warning(`${errorRows} row${errorRows === 1 ? '' : 's'} have errors and will not be imported. Fix and re-upload, or commit the rest.`);
      else toast.success(`File validated — ${validRows} valid, ${warningRows} warning${warningRows === 1 ? '' : 's'}.`);
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

  const committableRows = preview
    ? preview.rows.filter((r) => r.status !== 'error' && r.status !== 'needs_party' && !skippedRowIds.has(r.id))
    : [];
  const hasDuplicates = !txn && preview ? preview.rows.some((r) => r.duplicateOfId != null && r.status !== 'error') : false;
  const needsPartyCount = preview ? preview.rows.filter((r) => r.status === 'needs_party').length : 0;

  const handleCommit = async () => {
    if (!preview) return;
    try {
      const r = await commitBatch.mutateAsync({
        id: preview.batch.id,
        skipRowIds: [...skippedRowIds],
        duplicateAction,
      });
      setCommitOpen(false);
      setPreview(null);
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

  return (
    <AppLayout>
      <div className="space-y-6 font-sans">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileSpreadsheet className="w-6 h-6 text-primary" />
            Import Data
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Migrate masters from your old ERP: download a sample, fill it in, upload, review, commit.
          </p>
        </div>

        <Tabs defaultValue="import">
          <TabsList>
            <TabsTrigger value="import"><Upload className="w-4 h-4 mr-1.5" />Import</TabsTrigger>
            <TabsTrigger value="history"><History className="w-4 h-4 mr-1.5" />Import History</TabsTrigger>
          </TabsList>

          {/* ── Import tab ─────────────────────────────────────────────── */}
          <TabsContent value="import" className="space-y-4 mt-4">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
              {(Object.keys(MODULE_META) as ImportModule[]).map((m) => {
                const meta = MODULE_META[m];
                const Icon = meta.icon;
                const active = module === m;
                return (
                  <Card
                    key={m}
                    className={`cursor-pointer transition-colors ${active ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'}`}
                    onClick={() => { setModule(m); setPreview(null); setCommitResult(null); setPartyForms({}); }}
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Icon className={`w-4 h-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
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

            {locationRequired && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-primary" />
                    Target location
                  </CardTitle>
                  <CardDescription>
                    {voucher
                      ? `Every voucher in the file is stamped to this location and its cash/bank ledgers — collections allocate against ${partyWord} ${module === 'receipts' ? 'invoices' : 'bills'} raised here (Head Office sees all locations). Pick it before uploading.`
                      : `Every ${module === 'sales' ? 'invoice' : 'bill'} in the file is recorded at this location — its stock, ledgers and reports carry the effects. Pick it before uploading.`}
                    {' '}Location determines which branch/warehouse owns the imported record.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Select value={location} onValueChange={(v) => { setLocation(v); setPreview(null); }}>
                    <SelectTrigger className="w-72"><SelectValue placeholder="Choose a location…" /></SelectTrigger>
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
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{locationRequired ? 'Get the sample, fill it, upload it' : 'Step 1 — Get the sample, fill it, upload it'}</CardTitle>
                <CardDescription>
                  {voucher
                    ? `Columns marked * are required. One row per voucher. ${module === 'receipts' ? 'Against Invoice' : 'Against Bill'} settles only that ${module === 'receipts' ? 'invoice' : 'bill'}; blank auto-allocates oldest-first, excess becomes a ${partyWord} advance. ${module === 'receipts' ? 'Received In' : 'Paid From'} is Cash, Bank or an exact bank ledger name.`
                    : txn
                      ? `Columns marked * are required. One row per invoice line — rows of one invoice must sit together with the same invoice number, date and ${partyWord}. ${module === 'sales' ? 'Prices INCLUDE GST (the selling price), and Discount is ₹ per unit — exactly like manual sale entry.' : 'Purchase rates are GST-exclusive, like manual purchase entry.'} GST is worked out from the product master — you never enter tax amounts.`
                      : 'Columns marked * are required. Location determines which branch/warehouse owns the imported record — use "Head Office" or an exact warehouse/outlet name. Duplicate names are flagged — you decide at commit whether to skip or update them.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={handleDownloadSample} disabled={!perm.canDownload}>
                  <Download className="w-4 h-4 mr-1.5" />
                  Download {MODULE_META[module].label} sample
                </Button>
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!perm.canAdd || parseFile.isPending || (locationRequired && !location)}
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

            {commitResult && !preview && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    Import summary — {commitResult.batch.filename}
                  </CardTitle>
                  <CardDescription>
                    Counted from the records this batch actually created in the books.
                    {commitResult.details ? ` Finished in ${(commitResult.details.timeTakenMs / 1000).toFixed(1)}s.` : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {commitResult.details ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                      {([
                        ...(isTxn(commitResult.batch.module) ? [
                          [commitResult.batch.module === 'sales' ? 'Invoices imported' : 'Bills imported', commitResult.details.invoicesImported],
                          [commitResult.batch.module === 'sales' ? 'Invoices failed' : 'Bills failed', commitResult.details.invoicesFailed],
                          ['Stock movements', commitResult.details.stockMovements],
                          ['Invoices with GST', commitResult.details.gstInvoices],
                        ] : [
                          ['Records imported', commitResult.summary.imported],
                          ['Failed', commitResult.summary.failed],
                        ]),
                        ['Customers created', commitResult.details.customersCreated],
                        ['Vendors created', commitResult.details.vendorsCreated],
                        ['Ledgers created', commitResult.details.ledgersCreated],
                        ['Receipt entries', commitResult.details.receiptsCreated],
                        ['Payment entries', commitResult.details.paymentsCreated],
                      ] as Array<[string, number]>).map(([label, value]) => (
                        <div key={label} className="rounded-lg border p-3">
                          <div className={`text-xl font-bold ${label.includes('failed') || label === 'Failed' ? (value > 0 ? 'text-destructive' : 'text-muted-foreground') : ''}`}>{value}</div>
                          <div className="text-xs text-muted-foreground">{label}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {commitResult.summary.imported} imported, {commitResult.summary.skipped} skipped, {commitResult.summary.failed} failed.
                    </p>
                  )}
                  {(commitResult.partiesCreated?.length ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Created automatically: {commitResult.partiesCreated!.map((p) => p.name).join(', ')}
                    </p>
                  )}
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

            {preview && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Step 2 — Review &amp; commit ({preview.batch.filename})</CardTitle>
                  <CardDescription>
                    Rows with errors are never imported — fix them in the file and re-upload, or commit the rest.
                    Untick a row to leave it out.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className={`grid grid-cols-2 gap-3 ${locationRequired ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}>
                    <div className="rounded-lg border p-3">
                      <div className="text-2xl font-bold">{preview.batch.totalRows}</div>
                      <div className="text-xs text-muted-foreground">Total rows</div>
                    </div>
                    <div className="rounded-lg border p-3">
                      <div className="text-2xl font-bold text-emerald-600 flex items-center gap-1"><CheckCircle2 className="w-5 h-5" />{preview.batch.validRows}</div>
                      <div className="text-xs text-muted-foreground">Valid</div>
                    </div>
                    <div className="rounded-lg border p-3">
                      <div className="text-2xl font-bold text-amber-600 flex items-center gap-1"><AlertTriangle className="w-5 h-5" />{preview.batch.warningRows}</div>
                      <div className="text-xs text-muted-foreground">Warnings</div>
                    </div>
                    {locationRequired && (
                      <div className="rounded-lg border p-3">
                        <div className="text-2xl font-bold text-blue-600 flex items-center gap-1"><UserPlus className="w-5 h-5" />{needsPartyCount}</div>
                        <div className="text-xs text-muted-foreground">Need {partyWord}</div>
                      </div>
                    )}
                    <div className="rounded-lg border p-3">
                      <div className="text-2xl font-bold text-destructive flex items-center gap-1"><XCircle className="w-5 h-5" />{locationRequired ? preview.batch.errorRows - needsPartyCount : preview.batch.errorRows}</div>
                      <div className="text-xs text-muted-foreground">Errors</div>
                    </div>
                  </div>

                  {preview.summary && (
                    <div className="rounded-lg border bg-muted/40 p-3">
                      <div className="text-xs font-medium text-muted-foreground mb-2">
                        What will be recorded — computed by the ERP exactly as manual entry would:
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                        <div>
                          <div className="text-lg font-bold">{preview.summary.invoices}</div>
                          <div className="text-xs text-muted-foreground">{module === 'sales' ? 'Invoices' : 'Bills'}</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold">{preview.summary.totalQuantity}</div>
                          <div className="text-xs text-muted-foreground">Total quantity</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold">₹{preview.summary.totalTaxable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                          <div className="text-xs text-muted-foreground">Taxable value</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold">₹{preview.summary.totalGst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                          <div className="text-xs text-muted-foreground">Total GST</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold">₹{preview.summary.totalDiscount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                          <div className="text-xs text-muted-foreground">Total discount</div>
                        </div>
                        <div>
                          <div className="text-lg font-bold text-primary">₹{preview.summary.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                          <div className="text-xs text-muted-foreground">Total amount</div>
                        </div>
                      </div>
                      {((preview.summary.distinctParties ?? 0) > 0 || (preview.summary.distinctItems ?? 0) > 0 || (preview.summary.walkInInvoices ?? 0) > 0) && (
                        <div className="mt-2 pt-2 border-t text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                          <span><span className="font-semibold text-foreground">{preview.summary.distinctItems ?? 0}</span> different item{(preview.summary.distinctItems ?? 0) === 1 ? '' : 's'}</span>
                          <span><span className="font-semibold text-foreground">{preview.summary.distinctParties ?? 0}</span> {module === 'sales' ? 'customer' : 'vendor'}{(preview.summary.distinctParties ?? 0) === 1 ? '' : 's'}</span>
                          {(preview.summary.walkInInvoices ?? 0) > 0 && (
                            <span><span className="font-semibold text-foreground">{preview.summary.walkInInvoices}</span> walk-in sale{preview.summary.walkInInvoices === 1 ? '' : 's'} (no customer on the bill)</span>
                          )}
                        </div>
                      )}
                      {(preview.summary.partiesToCreate?.length ?? 0) > 0 && (
                        <div className="mt-2 pt-2 border-t text-xs">
                          <span className="text-muted-foreground">Will be created automatically (with ledgers) at commit: </span>
                          <span className="font-medium">{preview.summary.partiesToCreate.join(', ')}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {preview.batch.errorRows > 0 && (
                    <div className="flex items-center gap-2 text-sm">
                      <Button variant="outline" size="sm" disabled={!perm.canDownload}
                        onClick={() => downloadImportErrorFile(preview.batch.id, module).catch((e: any) => toast.error(e?.message ?? 'The error file could not be downloaded.'))}>
                        <Download className="w-4 h-4 mr-1.5" />
                        Download failed rows (Excel)
                      </Button>
                      <span className="text-muted-foreground text-xs">Only the problem rows, with the reason on each — fix in Excel and re-upload just those.</span>
                    </div>
                  )}

                  {locationRequired && missingParties.length > 0 && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <UserPlus className="w-4 h-4 text-blue-600" />
                        {missingParties.length} {partyWord}{missingParties.length === 1 ? '' : 's'} in the file
                        {missingParties.length === 1 ? ' does' : ' do'} not exist yet
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Fill in what you know and create them — each gets its {partyIsCustomer(module) ? 'debtor' : 'creditor'} ledger automatically,
                        exactly like manual creation, and the rows re-validate without re-uploading. Or fix the spelling in the file and upload again.
                      </p>
                      <div className="space-y-2 max-h-[22rem] overflow-y-auto pr-1">
                        {missingParties.map((p) => {
                          const f = partyForm(p.name, p.gstNumber);
                          return (
                            <div key={p.name} className="grid gap-2 sm:grid-cols-6 items-center rounded-md border bg-white p-2">
                              <div className="sm:col-span-1 text-sm font-medium truncate" title={p.name}>{p.name}</div>
                              <Input className="h-8 text-xs" placeholder="GSTIN (optional)" value={f.gstNumber ?? ''}
                                onChange={(e) => setPartyField(p.name, p.gstNumber, 'gstNumber', e.target.value)} />
                              <Input className="h-8 text-xs" placeholder="Phone" value={f.phone ?? ''}
                                onChange={(e) => setPartyField(p.name, p.gstNumber, 'phone', e.target.value)} />
                              <Input className="h-8 text-xs" placeholder="State" value={f.state ?? ''}
                                onChange={(e) => setPartyField(p.name, p.gstNumber, 'state', e.target.value)} />
                              <Input className="h-8 text-xs" placeholder="Address" value={f.address ?? ''}
                                onChange={(e) => setPartyField(p.name, p.gstNumber, 'address', e.target.value)} />
                              {partyIsCustomer(module) ? (
                                <Input className="h-8 text-xs" type="number" placeholder="Credit limit" value={f.creditLimit ?? ''}
                                  onChange={(e) => setPartyField(p.name, p.gstNumber, 'creditLimit', e.target.value)} />
                              ) : <div />}
                            </div>
                          );
                        })}
                      </div>
                      <Button size="sm" onClick={handleResolveParties} disabled={!perm.canAdd || resolveParties.isPending}>
                        {resolveParties.isPending
                          ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                          : <UserPlus className="w-4 h-4 mr-1.5" />}
                        Create {missingParties.length === 1 ? 'this' : `all ${missingParties.length}`} &amp; re-validate
                      </Button>
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
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10">Import</TableHead>
                          <TableHead className="w-14">Row</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead className="w-24">Status</TableHead>
                          {voucher && <TableHead>Will settle</TableHead>}
                          <TableHead>Reason</TableHead>
                          <TableHead>Suggestion</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.rows.map((r) => (
                          <TableRow key={r.id} className={r.status === 'error' ? 'opacity-60' : ''}>
                            <TableCell>
                              <Checkbox
                                checked={r.status !== 'error' && r.status !== 'needs_party' && !skippedRowIds.has(r.id)}
                                disabled={r.status === 'error' || r.status === 'needs_party'}
                                onCheckedChange={() => toggleSkip(r.id)}
                              />
                            </TableCell>
                            <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
                            <TableCell className="font-medium">
                              {rowLabel(module, r)}
                              {r.walkIn && <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 align-middle">Walk-in</Badge>}
                              {r.willCreateParty && <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 align-middle text-blue-700 border-blue-300">New {partyWord}</Badge>}
                            </TableCell>
                            <TableCell><RowStatusBadge status={r.status} /></TableCell>
                            {voucher && <TableCell><AllocationCell r={r} /></TableCell>}
                            <TableCell className="text-sm text-muted-foreground max-w-[22rem]">{r.reason ?? '—'}</TableCell>
                            <TableCell className="text-sm text-muted-foreground max-w-[22rem]">{r.suggestion ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      {committableRows.length} of {preview.batch.totalRows} row{preview.batch.totalRows === 1 ? '' : 's'} will be committed.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setPreview(null)}>Discard</Button>
                      <Button onClick={() => setCommitOpen(true)} disabled={!perm.canAdd || committableRows.length === 0}>
                        Commit import
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── History tab ────────────────────────────────────────────── */}
          <TabsContent value="history" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Import History</CardTitle>
                <CardDescription>
                  Rollback removes only the records that batch created — it refuses when any of them has since been used.
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
                          <SortableHead k="failed" sort={batchSort} className="text-right">Failed</SortableHead>
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
                            <TableCell className="max-w-[14rem] truncate" title={b.filename}>{b.filename}</TableCell>
                            <TableCell className="whitespace-nowrap">{b.locationName ?? '—'}</TableCell>
                            <TableCell>{b.createdBy}</TableCell>
                            <TableCell className="text-right">{b.totalRows}</TableCell>
                            <TableCell className="text-right">
                              {b.status === 'validated' ? '—' : `${b.importedRows}${b.updatedRows ? ` (+${b.updatedRows} upd)` : ''}`}
                            </TableCell>
                            <TableCell className="text-right">{b.status === 'validated' ? '—' : b.failedRows}</TableCell>
                            <TableCell><BatchStatusBadge b={b} /></TableCell>
                            <TableCell className="text-right whitespace-nowrap">
                              <Button variant="ghost" size="sm" onClick={() => setDetailBatchId(b.id)}>
                                <Eye className="w-4 h-4" />
                              </Button>
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

      {/* Commit confirmation */}
      <Dialog open={commitOpen} onOpenChange={setCommitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit this import?</DialogTitle>
            <DialogDescription>
              {voucher ? (
                <>
                  {committableRows.length} row{committableRows.length === 1 ? '' : 's'} will be recorded as {module === 'receipts' ? 'receipt' : 'payment'} vouchers —
                  allocated against outstanding {module === 'receipts' ? 'invoices' : 'bills'} exactly as previewed (re-checked against live balances at commit),
                  with any excess parked as {partyWord} advances. Cash, bank and all books update immediately.
                  {needsPartyCount > 0 && ` ${needsPartyCount} row${needsPartyCount === 1 ? '' : 's'} with unresolved ${partyWord}s will be SKIPPED.`}
                  {' '}The whole batch can be rolled back from Import History while its vouchers and advances are untouched.
                </>
              ) : txn ? (
                <>
                  {committableRows.length} row{committableRows.length === 1 ? '' : 's'} will be recorded as {module === 'sales' ? 'sales invoices' : 'purchase bills'} —
                  with real stock, GST, ledger and settlement effects, exactly as if entered manually.
                  {needsPartyCount > 0 && ` ${needsPartyCount} row${needsPartyCount === 1 ? '' : 's'} with unresolved ${partyWord}s will be SKIPPED.`}
                  {' '}The whole batch can be rolled back from Import History while its documents have no later activity.
                </>
              ) : (
                <>
                  {committableRows.length} {MODULE_LABEL(module).toLowerCase()} row{committableRows.length === 1 ? '' : 's'} will be created
                  {hasDuplicates ? ` — duplicates will be ${duplicateAction === 'skip' ? 'skipped' : 'updated'}` : ''}.
                  Records are created exactly as if entered manually (ledgers auto-provisioned, opening balances recorded),
                  and the whole batch can be rolled back from Import History while its records are unused.
                </>
              )}
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

      {/* Batch detail (error log) */}
      <Dialog open={detailBatchId != null} onOpenChange={(open) => { if (!open) setDetailBatchId(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {detailData ? `${MODULE_LABEL(detailData.batch.module)} — ${detailData.batch.filename}` : 'Batch details'}
            </DialogTitle>
            <DialogDescription>
              {detailData
                ? `${fmtTime(detailData.batch.createdAt)} by ${detailData.batch.createdBy}`
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
                      <TableCell className="font-medium">{detailData ? rowLabel(detailData.batch.module, r) : '—'}</TableCell>
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
                <>Every voucher created by "{rollbackTarget.filename}" ({rollbackTarget.importedRows} voucher{rollbackTarget.importedRows === 1 ? '' : 's'}) will be
                removed — allocations unwound so {rollbackTarget.module === 'receipts' ? 'invoice' : 'bill'} dues are restored, and any advances they created withdrawn.
                A voucher whose advance has since been adjusted against other documents blocks the whole rollback with per-voucher reasons.</>
              ) : isTxn(rollbackTarget.module) ? (
                <>Every document created by "{rollbackTarget.filename}" ({rollbackTarget.importedRows} row{rollbackTarget.importedRows === 1 ? '' : 's'}) will be
                reversed — stock restored, settlements unwound{rollbackTarget.module === 'purchases' ? ', average cost unwound' : ''}, books cleaned.
                Documents that have since gained payments, returns or other activity block the whole rollback with per-document reasons.</>
              ) : (
                <>Every record created by "{rollbackTarget.filename}" ({rollbackTarget.importedRows} record{rollbackTarget.importedRows === 1 ? '' : 's'}) will be
                deleted — opening balances first, then ledgers, then parties. Records that have since been used block the
                rollback with a per-record explanation. Updates made to pre-existing records are not reverted.</>
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
