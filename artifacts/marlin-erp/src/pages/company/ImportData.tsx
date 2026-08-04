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
import { useRef, useState } from 'react';
import {
  useImportBatches, useImportBatch, useParseImportFile, useCommitImportBatch,
  useRollbackImportBatch, downloadImportTemplate,
  type ImportModule, type ImportBatch, type ImportRow, type ImportRollbackBlocked,
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
import { toast } from 'sonner';
import {
  ShieldOff, Upload, Download, FileSpreadsheet, Users, Truck, BookOpen,
  CheckCircle2, AlertTriangle, XCircle, RotateCcw, Loader2, History, Eye,
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
};

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
  const [preview, setPreview] = useState<{ batch: ImportBatch; rows: ImportRow[] } | null>(null);
  const [skippedRowIds, setSkippedRowIds] = useState<Set<number>>(new Set());
  const [duplicateAction, setDuplicateAction] = useState<'skip' | 'update'>('skip');
  const [commitOpen, setCommitOpen] = useState(false);
  const [detailBatchId, setDetailBatchId] = useState<number | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<ImportBatch | null>(null);
  const [rollbackBlocked, setRollbackBlocked] = useState<ImportRollbackBlocked | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: historyData, isLoading: loadingHistory } = useImportBatches();
  const { data: detailData } = useImportBatch(detailBatchId);
  const parseFile = useParseImportFile();
  const commitBatch = useCommitImportBatch();
  const rollbackBatch = useRollbackImportBatch();

  const batches = historyData?.batches ?? [];

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
      const r = await parseFile.mutateAsync({ module, file });
      setPreview(r);
      setSkippedRowIds(new Set());
      setDuplicateAction('skip');
      const { validRows, warningRows, errorRows } = r.batch;
      if (errorRows > 0) toast.warning(`${errorRows} row${errorRows === 1 ? '' : 's'} have errors and will not be imported. Fix and re-upload, or commit the rest.`);
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
    ? preview.rows.filter((r) => r.status !== 'error' && !skippedRowIds.has(r.id))
    : [];
  const hasDuplicates = preview ? preview.rows.some((r) => r.duplicateOfId != null && r.status !== 'error') : false;

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
      toast.success(`Rolled back — ${r.removed} record${r.removed === 1 ? '' : 's'} removed.`);
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
            <div className="grid gap-3 sm:grid-cols-3">
              {(Object.keys(MODULE_META) as ImportModule[]).map((m) => {
                const meta = MODULE_META[m];
                const Icon = meta.icon;
                const active = module === m;
                return (
                  <Card
                    key={m}
                    className={`cursor-pointer transition-colors ${active ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'}`}
                    onClick={() => { setModule(m); setPreview(null); }}
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

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Step 1 — Get the sample, fill it, upload it</CardTitle>
                <CardDescription>
                  Columns marked * are required. Duplicate names are flagged — you decide at commit whether to skip or update them.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={handleDownloadSample} disabled={!perm.canDownload}>
                  <Download className="w-4 h-4 mr-1.5" />
                  Download {MODULE_META[module].label} sample
                </Button>
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!perm.canAdd || parseFile.isPending}
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
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
                    <div className="rounded-lg border p-3">
                      <div className="text-2xl font-bold text-destructive flex items-center gap-1"><XCircle className="w-5 h-5" />{preview.batch.errorRows}</div>
                      <div className="text-xs text-muted-foreground">Errors</div>
                    </div>
                  </div>

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
                          <TableHead>Reason</TableHead>
                          <TableHead>Suggestion</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.rows.map((r) => (
                          <TableRow key={r.id} className={r.status === 'error' ? 'opacity-60' : ''}>
                            <TableCell>
                              <Checkbox
                                checked={r.status !== 'error' && !skippedRowIds.has(r.id)}
                                disabled={r.status === 'error'}
                                onCheckedChange={() => toggleSkip(r.id)}
                              />
                            </TableCell>
                            <TableCell className="text-muted-foreground">{r.rowNumber}</TableCell>
                            <TableCell className="font-medium">{r.values.name ?? '—'}</TableCell>
                            <TableCell><RowStatusBadge status={r.status} /></TableCell>
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
                          <TableHead>When</TableHead>
                          <TableHead>Module</TableHead>
                          <TableHead>File</TableHead>
                          <TableHead>By</TableHead>
                          <TableHead className="text-right">Rows</TableHead>
                          <TableHead className="text-right">Imported</TableHead>
                          <TableHead className="text-right">Failed</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {batches.map((b) => (
                          <TableRow key={b.id}>
                            <TableCell className="whitespace-nowrap">{fmtTime(b.createdAt)}</TableCell>
                            <TableCell>{MODULE_LABEL(b.module)}</TableCell>
                            <TableCell className="max-w-[14rem] truncate" title={b.filename}>{b.filename}</TableCell>
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
                                  <RotateCcw className="w-4 h-4 mr-1" />Rollback
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
              {committableRows.length} {MODULE_LABEL(module).toLowerCase()} row{committableRows.length === 1 ? '' : 's'} will be created
              {hasDuplicates ? ` — duplicates will be ${duplicateAction === 'skip' ? 'skipped' : 'updated'}` : ''}.
              Records are created exactly as if entered manually (ledgers auto-provisioned, opening balances recorded),
              and the whole batch can be rolled back from Import History while its records are unused.
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
                      <TableCell className="font-medium">{r.values.name ?? '—'}</TableCell>
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
            <DialogTitle>Roll back this import?</DialogTitle>
            <DialogDescription>
              {rollbackTarget && (
                <>Every record created by "{rollbackTarget.filename}" ({rollbackTarget.importedRows} record{rollbackTarget.importedRows === 1 ? '' : 's'}) will be
                deleted — opening balances first, then ledgers, then parties. Records that have since been used block the
                rollback with a per-record explanation. Updates made to pre-existing records are not reverted.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRollbackTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRollback} disabled={rollbackBatch.isPending}>
              {rollbackBatch.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Roll back
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
