/**
 * Legacy ERP Import (Company → Data Migration).
 *
 * One-time migration of an old ERP backup (ZIP of DBF tables) into this ERP.
 * Flow: upload the backup → (password if the ZIP asks for one) → server-side
 * analysis of what's inside (company, backup date, tables, record counts) →
 * import into a chosen location.
 *
 * This page currently covers upload + analysis. The import step itself runs
 * through the same batch machinery as Company → Import Data, so imported
 * documents get identical business-rule treatment, history and rollback; it is
 * wired per legacy-ERP format once a real backup's table structure is
 * confirmed against this analysis.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useUploadLegacyBackup, useUnlockLegacyUpload, useAddLegacyFile, useDiscardLegacyUpload,
  useLegacyTableRows,
  type LegacyUploadSession, type LegacyTableInfo, type LegacyTableGuess,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { toast } from 'sonner';
import {
  ShieldOff, Upload, Loader2, Database, Building2, CalendarDays, Table2, Eye,
  Users, Truck, BookOpen, Package, ShoppingCart, Receipt, Banknote, FileQuestion,
  Boxes, Scale, ArchiveRestore, Undo2, Lock, Plus, RotateCcw,
} from 'lucide-react';

// ── Guess metadata ───────────────────────────────────────────────────────────

const GUESS_META: Record<LegacyTableGuess, { label: string; icon: typeof Users; tone: string }> = {
  company:           { label: 'Company Info',      icon: Building2,      tone: 'bg-slate-100 text-slate-800 hover:bg-slate-100' },
  customers:         { label: 'Customers',         icon: Users,          tone: 'bg-blue-100 text-blue-800 hover:bg-blue-100' },
  vendors:           { label: 'Vendors',           icon: Truck,          tone: 'bg-indigo-100 text-indigo-800 hover:bg-indigo-100' },
  items:             { label: 'Items',             icon: Package,        tone: 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100' },
  ledgers:           { label: 'Ledgers',           icon: BookOpen,       tone: 'bg-violet-100 text-violet-800 hover:bg-violet-100' },
  stock:             { label: 'Stock',             icon: Boxes,          tone: 'bg-teal-100 text-teal-800 hover:bg-teal-100' },
  sales:             { label: 'Sales',             icon: ShoppingCart,   tone: 'bg-amber-100 text-amber-800 hover:bg-amber-100' },
  purchases:         { label: 'Purchases',         icon: Package,        tone: 'bg-orange-100 text-orange-800 hover:bg-orange-100' },
  sales_returns:     { label: 'Sales Returns',     icon: Undo2,          tone: 'bg-rose-100 text-rose-800 hover:bg-rose-100' },
  purchase_returns:  { label: 'Purchase Returns',  icon: Undo2,          tone: 'bg-pink-100 text-pink-800 hover:bg-pink-100' },
  receipts:          { label: 'Receipts',          icon: Receipt,        tone: 'bg-cyan-100 text-cyan-800 hover:bg-cyan-100' },
  payments:          { label: 'Payments',          icon: Banknote,       tone: 'bg-sky-100 text-sky-800 hover:bg-sky-100' },
  journal:           { label: 'Journal / Vouchers',icon: Scale,          tone: 'bg-purple-100 text-purple-800 hover:bg-purple-100' },
  opening_balances:  { label: 'Opening Balances',  icon: ArchiveRestore, tone: 'bg-lime-100 text-lime-800 hover:bg-lime-100' },
  unknown:           { label: 'Unrecognized',      icon: FileQuestion,   tone: 'bg-gray-100 text-gray-600 hover:bg-gray-100' },
};

/** Spec §5 summary tiles, in display order. */
const SUMMARY_ORDER: Array<Exclude<LegacyTableGuess, 'unknown' | 'company'>> = [
  'sales', 'purchases', 'customers', 'vendors', 'items', 'ledgers', 'stock',
  'receipts', 'payments', 'journal', 'sales_returns', 'purchase_returns', 'opening_balances',
];

const fmtDate = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// ── Sample-rows dialog ───────────────────────────────────────────────────────

function TablePreviewDialog({ uploadId, table, onClose, onExpired }: {
  uploadId: string; table: LegacyTableInfo | null; onClose: () => void; onExpired: (e: Error) => void;
}) {
  const { data, isLoading, error } = useLegacyTableRows(uploadId, table?.fileName ?? null, 20);
  // A 410 mid-preview means the server restarted — reset the whole flow.
  useEffect(() => { if (error) onExpired(error); }, [error, onExpired]);
  return (
    <Dialog open={table != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{table?.name}</DialogTitle>
          <DialogDescription>
            First rows exactly as stored in the old ERP — {table?.recordCount.toLocaleString('en-IN')} record(s), {table?.fields.length} column(s).
          </DialogDescription>
        </DialogHeader>
        {isLoading && <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Reading table…</div>}
        {error && <p className="text-sm text-destructive py-4">{error.message}</p>}
        {data && (
          <div className="overflow-auto max-h-[55vh] border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  {data.fields.map((f) => <TableHead key={f.name} className="whitespace-nowrap text-xs">{f.name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r, i) => (
                  <TableRow key={i}>
                    {data.fields.map((f) => (
                      <TableCell key={f.name} className="whitespace-nowrap text-xs">
                        {r[f.name] == null ? '' : String(r[f.name] instanceof Date ? (r[f.name] as Date).toISOString().slice(0, 10) : r[f.name])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {data.rows.length === 0 && (
                  <TableRow><TableCell colSpan={data.fields.length} className="text-center text-muted-foreground">This table is empty.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function LegacyImport() {
  const perm = usePermission('page:/company/legacy-import');

  const [session, setSession] = useState<LegacyUploadSession | null>(null);
  const [password, setPassword] = useState('');
  const [previewTable, setPreviewTable] = useState<LegacyTableInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFileRef = useRef<HTMLInputElement>(null);

  const upload = useUploadLegacyBackup();
  const unlock = useUnlockLegacyUpload();
  const addFile = useAddLegacyFile();
  const discard = useDiscardLegacyUpload();

  const analysis = session?.status === 'ready' ? session.analysis : null;

  const tables = useMemo(() => analysis?.tables ?? [], [analysis]);
  const { sorted: sortedTables, sort: tableSort } = useTableSort(tables, {
    name: (t) => t.name,
    type: (t) => GUESS_META[t.guess].label,
    records: (t) => t.recordCount,
    fields: (t) => t.fields.length,
    updated: (t) => t.lastUpdate ?? '',
  });

  /** A 410 means the /tmp session vanished (server restart) — start over. */
  const handleGone = useCallback((e: Error) => {
    if (/expired|restarted/i.test(e.message)) {
      setSession(null);
      setPreviewTable(null);
      toast.error(e.message);
      return true;
    }
    return false;
  }, []);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    try {
      // First file opens the session; any further .dbf files are appended.
      const first = await upload.mutateAsync({ file: list[0] });
      setSession(first);
      if (first.status === 'password_required') {
        if (list.length > 1) toast.info('Unlock the ZIP first — the other files were not added.');
        return;
      }
      let latest = first;
      for (const extra of list.slice(1)) {
        latest = await addFile.mutateAsync({ uploadId: first.uploadId, file: extra });
      }
      setSession(latest);
      toast.success('Backup read successfully.');
    } catch (e) {
      // A later add-file in the loop can hit an expired session too.
      if (!handleGone(e as Error)) toast.error((e as Error).message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleUnlock = async () => {
    if (!session) return;
    try {
      const next = await unlock.mutateAsync({ uploadId: session.uploadId, password });
      setSession(next);
      setPassword('');
      toast.success('Backup unlocked and read successfully.');
    } catch (e) {
      if (!handleGone(e as Error)) toast.error((e as Error).message);
    }
  };

  const handleAddFiles = async (files: FileList | null) => {
    if (!session || !files || files.length === 0) return;
    try {
      let latest = session;
      for (const f of Array.from(files)) {
        latest = await addFile.mutateAsync({ uploadId: session.uploadId, file: f });
      }
      setSession(latest);
      toast.success(files.length > 1 ? `${files.length} files added.` : 'File added.');
    } catch (e) {
      if (!handleGone(e as Error)) toast.error((e as Error).message);
    } finally {
      if (addFileRef.current) addFileRef.current.value = '';
    }
  };

  const handleStartOver = async () => {
    if (session) discard.mutate({ uploadId: session.uploadId });
    setSession(null);
    setPassword('');
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
              Legacy ERP Import is limited to Management and Admin users.<br />Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Legacy ERP Import</h1>
          <p className="text-muted-foreground text-sm mt-1">
            One-time migration: upload your old ERP's backup (ZIP of DBF tables), check what's inside, then import it into a chosen location.
          </p>
        </div>

        {/* ── Step 1: Upload ── */}
        {!session && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Upload className="w-5 h-5" /> Upload backup</CardTitle>
              <CardDescription>
                Accepts a ZIP backup, or one or more DBF files directly. Password-protected ZIPs are supported — you'll be asked for the password only if it's needed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <input
                ref={fileInputRef} type="file" multiple accept=".zip,.dbf,.DBF,.ZIP"
                className="hidden" onChange={(e) => handleUpload(e.target.files)}
              />
              <Button onClick={() => fileInputRef.current?.click()} disabled={!perm.canAdd || upload.isPending}>
                {upload.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                {upload.isPending ? 'Reading backup…' : 'Choose backup file'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Nothing is imported at this step — the backup is only read and summarized. Everything stays reviewable before any record is created.
              </p>
            </CardContent>
          </Card>
        )}

        {/* ── Step 1b: Password ── */}
        {session?.status === 'password_required' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Lock className="w-5 h-5" /> This backup is password-protected</CardTitle>
              <CardDescription>“{session.fileName}” needs its password before it can be read.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2 max-w-md">
                <Input
                  type="password" value={password} placeholder="Backup password"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && password && !unlock.isPending) void handleUnlock(); }}
                />
                <Button onClick={handleUnlock} disabled={!password || unlock.isPending}>
                  {unlock.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Unlock'}
                </Button>
              </div>
              <Button variant="ghost" size="sm" onClick={handleStartOver}><RotateCcw className="w-4 h-4 mr-2" />Choose a different file</Button>
            </CardContent>
          </Card>
        )}

        {/* ── Step 2: Analysis ── */}
        {analysis && session && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="pt-6 flex items-center gap-3">
                  <Building2 className="w-8 h-8 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Company in backup</p>
                    <p className="font-semibold truncate">{analysis.companyName ?? 'Not detected'}</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6 flex items-center gap-3">
                  <CalendarDays className="w-8 h-8 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Backup date</p>
                    <p className="font-semibold">{fmtDate(analysis.backupDate)}</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6 flex items-center gap-3">
                  <Database className="w-8 h-8 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Tables found</p>
                    <p className="font-semibold">{analysis.tables.length}{analysis.unknownTables > 0 && <span className="text-muted-foreground font-normal"> · {analysis.unknownTables} unrecognized</span>}</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>What's inside</CardTitle>
                <CardDescription>Record counts by detected data type. Tap a table below to see its actual rows.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                  {SUMMARY_ORDER.filter((k) => analysis.summary[k] != null).map((k) => {
                    const Meta = GUESS_META[k];
                    return (
                      <div key={k} className="border rounded-lg p-3 flex items-center gap-2.5">
                        <Meta.icon className="w-5 h-5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs text-muted-foreground truncate">{Meta.label}</p>
                          <p className="font-semibold tabular-nums">{(analysis.summary[k] ?? 0).toLocaleString('en-IN')}</p>
                        </div>
                      </div>
                    );
                  })}
                  {SUMMARY_ORDER.every((k) => analysis.summary[k] == null) && (
                    <p className="col-span-full text-sm text-muted-foreground">
                      No tables were recognized automatically. Open the tables below — their contents will tell us how this backup is organized.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2"><Table2 className="w-5 h-5" /> Tables in “{session.fileName}”</CardTitle>
                  <CardDescription>Every DBF table found in the backup, with the type it looks like.</CardDescription>
                </div>
                <div className="flex gap-2 shrink-0">
                  <input ref={addFileRef} type="file" multiple accept=".dbf,.DBF,.zip,.ZIP" className="hidden" onChange={(e) => handleAddFiles(e.target.files)} />
                  <Button variant="outline" size="sm" onClick={() => addFileRef.current?.click()} disabled={!perm.canAdd || addFile.isPending}>
                    {addFile.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}Add files
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleStartOver}><RotateCcw className="w-4 h-4 mr-2" />Start over</Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="hidden md:block overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHead k="name" sort={tableSort}>Table</SortableHead>
                        <SortableHead k="type" sort={tableSort}>Looks like</SortableHead>
                        <SortableHead k="records" sort={tableSort} className="text-right">Records</SortableHead>
                        <SortableHead k="fields" sort={tableSort} className="text-right">Columns</SortableHead>
                        <SortableHead k="updated" sort={tableSort}>Last updated</SortableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedTables.map((t) => {
                        const Meta = GUESS_META[t.guess];
                        return (
                          <TableRow key={t.fileName}>
                            <TableCell className="font-mono text-xs font-medium">{t.name}</TableCell>
                            <TableCell>
                              {t.parseError
                                ? <Badge variant="destructive">Unreadable</Badge>
                                : <Badge className={Meta.tone}>{Meta.label}</Badge>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{t.recordCount.toLocaleString('en-IN')}</TableCell>
                            <TableCell className="text-right tabular-nums">{t.fields.length}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{fmtDate(t.lastUpdate)}</TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" disabled={!!t.parseError} onClick={() => setPreviewTable(t)}>
                                <Eye className="w-4 h-4 mr-1" />View
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {/* Mobile: card list beside the hidden table (responsive convention) */}
                <div className="md:hidden space-y-2">
                  {sortedTables.map((t) => {
                    const Meta = GUESS_META[t.guess];
                    return (
                      <button
                        key={t.fileName} type="button" disabled={!!t.parseError}
                        onClick={() => setPreviewTable(t)}
                        className="w-full border rounded-lg p-3 text-left flex items-center justify-between gap-2 disabled:opacity-60"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-xs font-medium truncate">{t.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {t.recordCount.toLocaleString('en-IN')} records · {t.fields.length} columns
                          </p>
                        </div>
                        {t.parseError
                          ? <Badge variant="destructive" className="shrink-0">Unreadable</Badge>
                          : <Badge className={`${Meta.tone} shrink-0`}>{Meta.label}</Badge>}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card className="border-dashed">
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">Next step — import into a location.</span>{' '}
                  Once this summary matches what you expect, the import step records everything into the location you choose
                  (Head Office, a warehouse or an outlet) using the same rules as manual entry — with a preview first, full
                  history, and rollback. It is switched on after your backup's exact table format is confirmed against this analysis.
                </p>
              </CardContent>
            </Card>
          </>
        )}

        {session && (
          <TablePreviewDialog
            uploadId={session.uploadId} table={previewTable}
            onClose={() => setPreviewTable(null)} onExpired={handleGone}
          />
        )}
      </div>
    </AppLayout>
  );
}
