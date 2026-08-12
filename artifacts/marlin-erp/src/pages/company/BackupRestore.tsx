/**
 * Backup & Restore.
 *
 * The page is ordered by the question an administrator actually arrives with:
 * "if this server died right now, what would I lose?" So the first thing on
 * screen is the age of the last backup and whether it has been proven to
 * restore — not a list of files. Everything destructive is further down, behind
 * more friction.
 */
import { Fragment, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useBackupDashboard, useListBackups, useRestoreHistory, useBackupSettings,
  useCreateBackup, useVerifyBackup, useDeleteBackup, useRestoreBackup,
  useUpdateBackupSettings, useUploadBackup, useValidateBackup,
  downloadBackupArchive, useGetMe,
  getBackupDashboardQueryKey, getBackupListQueryKey, getRestoreHistoryQueryKey,
  getBackupSettingsQueryKey,
  type BackupRecord, type BackupScope, type CheckResult, type RestoreOutcome, type RestoreFailure,
  type RestoreEvent, type RestoreStep,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { toast } from 'sonner';
import {
  DatabaseBackup, ShieldOff, ShieldCheck, ShieldAlert, Download, Trash2, Upload,
  RotateCcw, CheckCircle2, XCircle, AlertTriangle, Info, HardDrive, Clock,
  FlaskConical, Loader2, CloudOff, FileArchive,
} from 'lucide-react';

// ── Formatting ─────────────────────────────────────────────────────────────

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

/** "3 hours ago" — the unit that matters here is how much work is at risk. */
function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const SCOPE_LABELS: Record<string, string> = {
  complete: 'Everything',
  database: 'Database only',
  files: 'Files only',
  settings: 'Settings only',
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Manual',
  scheduled: 'Automatic',
  pre_restore: 'Safety copy',
  uploaded: 'Uploaded',
};

const FAILED_RESTORE_LABELS: Record<'unchanged' | 'partial' | 'unknown', string> = {
  unchanged: 'Failed — data unchanged',
  partial: 'Failed — partly applied',
  unknown: 'Failed',
};

/**
 * Whether a failed restore actually left the data alone — read from what was
 * recorded, never assumed. Only the database step is transactional; the file and
 * settings steps run after it commits, so a failure there leaves data already
 * replaced. The server records a "State of your data" step carrying the verdict.
 * Older events predate that step, so fall back to whether the database step is
 * recorded as done — and when even that is absent, say nothing rather than
 * reassuring someone wrongly.
 */
const failedRestoreState = (ev: RestoreEvent): 'unchanged' | 'partial' | 'unknown' => {
  const verdict = ev.steps?.find((s: RestoreStep) => s.step === 'State of your data');
  if (verdict) return verdict.ok ? 'unchanged' : 'partial';
  if (ev.steps?.some((s: RestoreStep) => s.step === 'Restore the database' && s.ok)) return 'partial';
  return 'unknown';
};

const FREQUENCY_LABELS: Record<string, string> = {
  manual: 'Only when I ask',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

const RETENTION_LABELS: Record<string, string> = {
  '7': 'Keep the last 7 automatic backups',
  '30': 'Keep the last 30 automatic backups',
  '90': 'Keep the last 90 automatic backups',
  unlimited: 'Keep everything',
};

// ── Small presentational pieces ────────────────────────────────────────────

function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <div className="space-y-1.5">
      {checks.map((c, i) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          {c.ok
            ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            : <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />}
          <div className="min-w-0">
            <span className="font-medium">{c.check}</span>
            <span className="text-muted-foreground"> — {c.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function BackupRestore() {
  const perm = usePermission('page:/company/backup');
  const qc = useQueryClient();
  const { data: me } = useGetMe();

  const { data: dash, isLoading: loadingDash } = useBackupDashboard();
  const { data: listData, isLoading: loadingList } = useListBackups();
  const { data: historyData } = useRestoreHistory();
  const { data: settings } = useBackupSettings();

  const createBackup = useCreateBackup();
  const verifyBackup = useVerifyBackup();
  const deleteBackup = useDeleteBackup();
  const restoreBackup = useRestoreBackup();
  const updateSettings = useUpdateBackupSettings();
  const uploadBackup = useUploadBackup();

  const [scope, setScope] = useState<BackupScope>('complete');
  const [lastSelfCheck, setLastSelfCheck] = useState<CheckResult[] | null>(null);
  const [verifyResultFor, setVerifyResultFor] = useState<{ id: number; checks: CheckResult[] } | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreOutcome, setRestoreOutcome] = useState<RestoreOutcome | null>(null);
  const [restoreFailure, setRestoreFailure] = useState<RestoreFailure | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupRecord | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const backups = listData?.backups ?? [];
  const events = historyData?.events ?? [];

  const { sorted: sortedBackups, sort: backupSort } = useTableSort(backups, {
    backup: b => b.filename,
    contents: b => SCOPE_LABELS[b.scope] ?? b.scope,
    size: b => Number(b.sizeBytes),
    restores: b => b.verifyStatus,
    createdBy: b => b.createdBy,
  });

  const { sorted: sortedEvents, sort: eventSort } = useTableSort(events, {
    when: e => e.startedAt,
    from: e => e.filename,
    outcome: e => e.status,
    by: e => e.performedBy,
    undoCopy: e => e.safetyFilename,
  });
  const isHeadOffice = me?.branchType === 'headoffice';
  // The strictest combination in the app — see the route comments. Restore is the
  // one action that can destroy every record at once.
  const canRestore = perm.canEdit && isHeadOffice;

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: getBackupDashboardQueryKey() });
    qc.invalidateQueries({ queryKey: getBackupListQueryKey() });
    qc.invalidateQueries({ queryKey: getRestoreHistoryQueryKey() });
    qc.invalidateQueries({ queryKey: getBackupSettingsQueryKey() });
  };

  // Validation runs only for the archive actually opened in the restore dialog.
  const { data: validation, isLoading: validating } = useValidateBackup(restoreTarget?.id ?? null);

  const latest = dash?.latestBackup ?? null;
  const neverDownloaded = latest !== null && !latest.downloadedAt;

  const handleCreate = async () => {
    try {
      const r = await createBackup.mutateAsync({ scope });
      setLastSelfCheck(r.selfCheck);
      toast.success(`Backup created — ${r.filename} (${r.sizeLabel})`);
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'The backup could not be created.');
    }
  };

  const handleVerify = async (b: BackupRecord) => {
    setBusyId(b.id);
    try {
      const r = await verifyBackup.mutateAsync({ id: b.id });
      setVerifyResultFor({ id: b.id, checks: r.checks });
      if (r.ok) toast.success('This backup restores correctly — all checks passed.');
      else toast.error('This backup did NOT pass verification. See the details below.');
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Verification failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (b: BackupRecord) => {
    setBusyId(b.id);
    try {
      await downloadBackupArchive(b.id, b.filename);
      toast.success('Download started. Keep this file somewhere outside Replit.');
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'The download failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteBackup.mutateAsync({ id: deleteTarget.id });
      toast.success(`Deleted ${deleteTarget.filename}`);
      setDeleteTarget(null);
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'That backup could not be deleted.');
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    try {
      const outcome = await restoreBackup.mutateAsync({
        id: restoreTarget.id,
        password: restorePassword,
        scope: (restoreTarget.scope ?? 'complete') as BackupScope,
      });
      setRestoreOutcome(outcome);
      setRestorePassword('');
      if (outcome.ok) toast.success('Restore complete.');
      else toast.warning('The restore finished but some checks did not pass.');
      refreshAll();
    } catch (e: any) {
      // Never reassure blindly here. The server says whether anything was
      // applied before it failed; if that body is missing, assume the worst
      // rather than telling someone their data is safe when it may not be.
      const body = e?.data as RestoreFailure | undefined;
      setRestoreFailure({
        error: body?.error ?? e?.message ?? 'The restore failed.',
        eventId: body?.eventId ?? null,
        safetyBackupId: body?.safetyBackupId ?? null,
        steps: body?.steps ?? [],
        dataUnchanged: body?.dataUnchanged === true,
        restartRequired: body?.restartRequired === true,
      });
      setRestorePassword('');
      toast.error(
        body?.dataUnchanged === true
          ? 'The restore failed. Your data was not changed.'
          : 'The restore failed. Read the report — some of it may already be applied.',
      );
      refreshAll();
    }
  };

  const handleUpload = async (file: File) => {
    try {
      const r = await uploadBackup.mutateAsync({ file });
      if (r.ok) toast.success(`${r.filename} uploaded and validated (${r.sizeLabel}). Verify it, then restore.`);
      else toast.warning(`${r.filename} uploaded, but it has problems. Check the list before restoring.`);
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'That file could not be uploaded.');
    }
  };

  const saveSettings = async (patch: Parameters<typeof updateSettings.mutateAsync>[0]) => {
    try {
      const r = await updateSettings.mutateAsync(patch);
      toast.success(
        r.frequency === 'manual'
          ? 'Automatic backups are off.'
          : `Automatic backups: ${FREQUENCY_LABELS[r.frequency].toLowerCase()}.`,
      );
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Those settings could not be saved.');
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
        {/* Header */}
        <PageHeader
          title="Backup & Restore"
          description="Protect every record in the ERP — and be able to prove you can get it back."
          icon={DatabaseBackup}
        />

        {/* ── The question that actually matters ──────────────────────────── */}
        <SummaryCardGrid>
          <SummaryCard
            label="Last backup"
            value={latest ? ago(latest.createdAt) : 'Never'}
            sub={latest ? `${latest.filename} · ${latest.sizeLabel}` : 'Nothing is protected yet'}
            icon={Clock}
            tone={!latest ? 'negative' : latest.verifyStatus === 'passed' ? 'positive' : 'warning'}
          />
          <SummaryCard
            label="Proven to restore"
            value={
              !latest ? '—'
                : latest.verifyStatus === 'passed' ? 'Yes'
                : latest.verifyStatus === 'failed' ? 'Failed'
                : 'Not tested'
            }
            sub={
              !latest ? 'Create a backup first'
                : latest.verifyStatus === 'passed' ? `Tested ${ago(latest.verifiedAt!)}`
                : latest.verifyStatus === 'failed' ? 'This archive did not restore'
                : 'Run Verify to prove it works'
            }
            icon={latest?.verifyStatus === 'passed' ? ShieldCheck : ShieldAlert}
            tone={latest?.verifyStatus === 'passed' ? 'positive' : latest?.verifyStatus === 'failed' ? 'negative' : 'warning'}
          />
          <SummaryCard
            label="Copy kept off Replit"
            value={!latest ? '—' : neverDownloaded ? 'No' : 'Yes'}
            sub={
              !latest ? 'Create a backup first'
                : neverDownloaded ? 'Download it — see the note below'
                : `Downloaded ${ago(latest.downloadedAt!)}`
            }
            icon={neverDownloaded ? CloudOff : Download}
            tone={!latest ? 'default' : neverDownloaded ? 'warning' : 'positive'}
          />
          <SummaryCard
            label="Automatic backups"
            value={settings ? FREQUENCY_LABELS[settings.frequency] : '—'}
            sub={
              settings?.frequency === 'manual' ? 'Nothing runs on its own'
                : settings?.nextRunAt ? `Next due ${fmtTime(settings.nextRunAt)}`
                : undefined
            }
            icon={HardDrive}
            tone={settings?.frequency === 'manual' ? 'warning' : 'positive'}
          />
        </SummaryCardGrid>

        {/* Off-platform warning — the single most misunderstood thing about backups */}
        {latest && neverDownloaded && (
          <Card className="border-amber-500/50 bg-amber-500/5">
            <CardContent className="pt-5 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold">Your only copy lives on the same platform as the original.</p>
                <p className="text-muted-foreground mt-1">
                  Backups are stored in this app's own storage. That protects you from a bad
                  edit, a wrong delete or a broken migration — but not from losing the account
                  or the project itself. Download the archive and keep it somewhere else
                  entirely for that.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {dash && !dash.fileStorageConfigured && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="pt-5 flex items-start gap-3">
              <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold">File storage is not set up, so backups cannot be saved.</p>
                <p className="text-muted-foreground mt-1">
                  Archives are written to this app's object storage. Ask your developer to
                  configure a storage bucket before relying on this page.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="backups">
          <TabsList>
            <TabsTrigger value="backups">Backups</TabsTrigger>
            <TabsTrigger value="schedule">Automatic</TabsTrigger>
            <TabsTrigger value="history">Restore history</TabsTrigger>
            <TabsTrigger value="system">System</TabsTrigger>
          </TabsList>

          {/* ── Backups ──────────────────────────────────────────────────── */}
          <TabsContent value="backups" className="space-y-4 mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Create a backup</CardTitle>
                <CardDescription>
                  A complete backup holds the database, every uploaded file, and your settings.
                  It takes a few seconds and does not interrupt anyone's work.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
                  <div className="space-y-1.5">
                    <Label>What to include</Label>
                    <Select value={scope} onValueChange={(v: BackupScope) => setScope(v)}>
                      <SelectTrigger className="w-[240px]" data-testid="select-backup-scope">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="complete">Everything (recommended)</SelectItem>
                        <SelectItem value="database">Database only</SelectItem>
                        <SelectItem value="files">Uploaded files only</SelectItem>
                        <SelectItem value="settings">Settings only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={handleCreate}
                    disabled={!perm.canAdd || createBackup.isPending}
                    data-testid="button-create-backup"
                  >
                    {createBackup.isPending
                      ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Backing up…</>
                      : <><DatabaseBackup className="w-4 h-4 mr-2" /> Back up now</>}
                  </Button>

                  {canRestore && (
                    <div className="sm:ml-auto">
                      <Label
                        htmlFor="upload-archive"
                        className="inline-flex items-center gap-2 h-9 px-4 rounded-md border border-input bg-background hover:bg-accent cursor-pointer text-sm font-medium"
                      >
                        {uploadBackup.isPending
                          ? <><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</>
                          : <><Upload className="w-4 h-4" /> Upload an archive</>}
                      </Label>
                      <input
                        id="upload-archive"
                        type="file"
                        accept=".zip,application/zip"
                        className="hidden"
                        disabled={uploadBackup.isPending}
                        onChange={e => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) handleUpload(f);
                        }}
                        data-testid="input-upload-archive"
                      />
                    </div>
                  )}
                </div>

                {!perm.canAdd && (
                  <p className="text-xs text-muted-foreground">
                    You can view backups but not create them. Ask your administrator for the
                    Add right on this page.
                  </p>
                )}

                {lastSelfCheck && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-sm font-medium mb-2">The archive was checked after it was written</p>
                    <CheckList checks={lastSelfCheck} />
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="border border-border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead k="backup" sort={backupSort}>Backup</SortableHead>
                    <SortableHead k="contents" sort={backupSort} className="hidden md:table-cell">Contents</SortableHead>
                    <SortableHead k="size" sort={backupSort}>Size</SortableHead>
                    <SortableHead k="restores" sort={backupSort}>Restores?</SortableHead>
                    <SortableHead k="createdBy" sort={backupSort} className="hidden lg:table-cell">Created by</SortableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingList ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
                  ) : backups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-12">
                        <FileArchive className="w-8 h-8 mx-auto text-muted-foreground/50 mb-3" />
                        <p className="font-medium">No backups yet</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Nothing in this ERP is currently protected. Create one above.
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : sortedBackups.map(b => (
                    // Keyed on the Fragment: a row can be followed by its verify
                    // panel, so the key has to sit on the pair, not the first row.
                    <Fragment key={b.id}>
                      <TableRow data-testid={`row-backup-${b.id}`}>
                        <TableCell>
                          <div className="font-medium text-sm">{b.filename}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                            {fmtTime(b.createdAt)}
                            <Badge variant="outline" className="text-[10px] px-1 py-0">
                              {TRIGGER_LABELS[b.trigger] ?? b.trigger}
                            </Badge>
                            {b.status === 'failed' && (
                              <Badge variant="destructive" className="text-[10px] px-1 py-0">Failed</Badge>
                            )}
                          </div>
                          {b.status === 'failed' && b.error && (
                            <div className="text-xs text-destructive mt-1 max-w-md">{b.error}</div>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                          <div>{SCOPE_LABELS[b.scope] ?? b.scope}</div>
                          {b.status === 'ready' && (
                            <div className="mt-0.5">
                              {b.tableCount > 0 && `${b.rowCount.toLocaleString('en-IN')} rows in ${b.tableCount} tables`}
                              {b.fileCount > 0 && `${b.tableCount > 0 ? ' · ' : ''}${b.fileCount} files`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">{b.sizeLabel}</TableCell>
                        <TableCell>
                          {b.verifyStatus === 'passed' ? (
                            <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent hover:bg-emerald-500/15">
                              <ShieldCheck className="w-3 h-3 mr-1" /> Proven
                            </Badge>
                          ) : b.verifyStatus === 'failed' ? (
                            <Badge variant="destructive" className="bg-destructive/15 text-destructive border-transparent hover:bg-destructive/15">
                              <ShieldAlert className="w-3 h-3 mr-1" /> Failed
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not tested</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                          {b.createdBy}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {b.status === 'ready' && perm.canAdd && (
                              <Button
                                variant="ghost" size="sm" title="Restore it into a temporary database to prove it works"
                                disabled={busyId === b.id}
                                onClick={() => handleVerify(b)}
                                data-testid={`button-verify-${b.id}`}
                              >
                                {busyId === b.id && verifyBackup.isPending
                                  ? <Loader2 className="w-4 h-4 animate-spin" />
                                  : <FlaskConical className="w-4 h-4" />}
                              </Button>
                            )}
                            {b.status === 'ready' && perm.canDownload && (
                              <Button
                                variant="ghost" size="sm" title="Download this archive"
                                disabled={busyId === b.id}
                                onClick={() => handleDownload(b)}
                                data-testid={`button-download-${b.id}`}
                              >
                                <Download className="w-4 h-4" />
                              </Button>
                            )}
                            {b.status === 'ready' && canRestore && (
                              <Button
                                variant="ghost" size="sm"
                                className="text-amber-600 dark:text-amber-400 hover:text-amber-700"
                                title="Restore this backup over the live data"
                                onClick={() => { setRestoreTarget(b); setRestoreOutcome(null); setRestoreFailure(null); setRestorePassword(''); }}
                                data-testid={`button-restore-${b.id}`}
                              >
                                <RotateCcw className="w-4 h-4" />
                              </Button>
                            )}
                            {perm.canDelete && (
                              <Button
                                variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                                title="Delete this archive"
                                onClick={() => setDeleteTarget(b)}
                                data-testid={`button-delete-${b.id}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {verifyResultFor?.id === b.id && (
                        <TableRow>
                          <TableCell colSpan={6} className="bg-muted/30">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <p className="text-sm font-medium mb-2">
                                  Test restore into a temporary database
                                </p>
                                <CheckList checks={verifyResultFor.checks} />
                              </div>
                              <Button variant="ghost" size="sm" onClick={() => setVerifyResultFor(null)}>
                                Hide
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>

            {!canRestore && backups.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Restoring a backup replaces live data, so it is limited to Head Office users
                with Approve rights on this page{!isHeadOffice ? ' — you are signed in at a branch' : ''}.
              </p>
            )}
          </TabsContent>

          {/* ── Automatic ────────────────────────────────────────────────── */}
          <TabsContent value="schedule" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Automatic backups</CardTitle>
                <CardDescription>
                  The server checks every hour whether one is due, so a backup is still taken
                  even if the app was asleep or restarting at the scheduled moment.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5 max-w-xl">
                <div className="space-y-1.5">
                  <Label>How often</Label>
                  <Select
                    value={settings?.frequency ?? 'manual'}
                    disabled={!perm.canEdit}
                    onValueChange={v => saveSettings({ frequency: v as any })}
                  >
                    <SelectTrigger data-testid="select-frequency"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>How many to keep</Label>
                  <Select
                    value={settings?.retention ?? '30'}
                    disabled={!perm.canEdit}
                    onValueChange={v => saveSettings({ retention: v as any })}
                  >
                    <SelectTrigger data-testid="select-retention"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(RETENTION_LABELS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Only automatic backups and safety copies are removed. Backups you created
                    yourself are never deleted for you.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
                  <div>
                    <Label htmlFor="include-files">Include uploaded files</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Logos, expense bills and payment attachments. Turn this off only if
                      storage is tight — the database alone will not bring these back.
                    </p>
                  </div>
                  <Switch
                    id="include-files"
                    checked={settings?.includeFiles ?? true}
                    disabled={!perm.canEdit}
                    onCheckedChange={v => saveSettings({ includeFiles: v })}
                    data-testid="switch-include-files"
                  />
                </div>

                {settings?.lastRunAt && (
                  <div className="text-xs text-muted-foreground">
                    Last automatic run {fmtTime(settings.lastRunAt)}
                    {settings.lastRunStatus && ` — ${settings.lastRunStatus}`}
                  </div>
                )}
                {!perm.canEdit && (
                  <p className="text-xs text-muted-foreground">
                    These settings are read-only for you.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Restore history ──────────────────────────────────────────── */}
          <TabsContent value="history" className="mt-4">
            <div className="border border-border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead k="when" sort={eventSort}>When</SortableHead>
                    <SortableHead k="from" sort={eventSort}>Restored from</SortableHead>
                    <SortableHead k="outcome" sort={eventSort}>Outcome</SortableHead>
                    <SortableHead k="by" sort={eventSort} className="hidden lg:table-cell">By</SortableHead>
                    <SortableHead k="undoCopy" sort={eventSort} className="hidden md:table-cell">Undo copy</SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                        No restore has ever been run on this system.
                      </TableCell>
                    </TableRow>
                  ) : sortedEvents.map(ev => (
                    <TableRow key={ev.id}>
                      <TableCell className="text-sm whitespace-nowrap">{fmtTime(ev.startedAt)}</TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{ev.filename}</div>
                        <div className="text-xs text-muted-foreground">
                          {SCOPE_LABELS[ev.scope] ?? ev.scope} · {ev.source === 'uploaded' ? 'uploaded file' : 'stored backup'}
                        </div>
                      </TableCell>
                      <TableCell>
                        {ev.status === 'completed' ? (
                          <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent hover:bg-emerald-500/15">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Completed
                          </Badge>
                        ) : ev.status === 'failed' ? (
                          <div>
                            <Badge variant="destructive" className="bg-destructive/15 text-destructive border-transparent hover:bg-destructive/15">
                              <XCircle className="w-3 h-3 mr-1" />
                              {FAILED_RESTORE_LABELS[failedRestoreState(ev)]}
                            </Badge>
                            {ev.error && (
                              <div className="text-xs text-muted-foreground mt-1 max-w-md">{ev.error}</div>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline">Running…</Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                        <div>{ev.performedBy}</div>
                        <div className="font-mono">{ev.ip}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {ev.safetyFilename || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* ── System ───────────────────────────────────────────────────── */}
          <TabsContent value="system" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">What a backup is paired with</CardTitle>
                <CardDescription>
                  A backup only restores cleanly onto software it matches. These are the
                  versions recorded inside every archive this server writes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-3 sm:grid-cols-2 text-sm">
                  {[
                    ['ERP version', dash?.erpVersion],
                    ['Code revision', dash?.gitCommit],
                    ['Database engine', dash ? `PostgreSQL ${dash.databaseVersion}` : undefined],
                    ['Live database size', dash?.databaseSizeLabel],
                    ['Backups stored', dash ? `${dash.totalBackups} (${dash.totalSizeLabel})` : undefined],
                    ['Failed backups', dash ? String(dash.failedBackups) : undefined],
                    ['Last restore', dash?.lastRestore
                      ? `${dash.lastRestore.status} · ${fmtTime(dash.lastRestore.startedAt)}`
                      : 'Never restored'],
                    ['Restored by', dash?.lastRestore ? dash.lastRestore.performedBy : '—'],
                  ].map(([k, v]) => (
                    <div key={k as string} className="flex justify-between gap-4 border-b border-border pb-2">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-medium font-mono text-xs text-right">{v ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
                {loadingDash && <p className="text-sm text-muted-foreground mt-3">Loading…</p>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* ── Restore dialog ─────────────────────────────────────────────── */}
        <Dialog
          open={restoreTarget !== null}
          onOpenChange={o => { if (!o) { setRestoreTarget(null); setRestoreOutcome(null); setRestoreFailure(null); setRestorePassword(''); } }}
        >
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            {restoreFailure ? (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-destructive">
                    <XCircle className="w-5 h-5" />
                    Restore failed
                  </DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                  {/* The single most important line on the screen. */}
                  {restoreFailure.dataUnchanged ? (
                    <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/5 p-3 flex items-start gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="font-semibold">Your data was not changed.</p>
                        <p className="text-muted-foreground mt-1">
                          The restore stopped before anything was written, so the ERP is
                          exactly as it was. It is safe to fix the problem and try again.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border-2 border-destructive bg-destructive/5 p-3 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="font-semibold text-destructive">
                          Part of this restore was already applied.
                        </p>
                        <p className="text-muted-foreground mt-1">
                          Your live data has changed even though the restore failed. Do not
                          retry blindly.
                          {restoreFailure.safetyBackupId
                            ? ' Restore the safety copy listed below to get back to how things were, then restart the server.'
                            : ' No safety copy is available for this attempt.'}
                        </p>
                      </div>
                    </div>
                  )}

                  <div>
                    <p className="text-sm font-medium mb-2">What went wrong</p>
                    <p className="text-sm text-muted-foreground break-words">{restoreFailure.error}</p>
                  </div>

                  {restoreFailure.steps.length > 0 && (
                    <div>
                      <p className="text-sm font-medium mb-2">How far it got</p>
                      <div className="space-y-1.5">
                        {restoreFailure.steps.map((s, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm">
                            {s.ok
                              ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                              : <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />}
                            <div><span className="font-medium">{s.step}</span>
                              <span className="text-muted-foreground"> — {s.detail}</span></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {restoreFailure.restartRequired && (
                    <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="font-semibold">Restart the server.</p>
                        <p className="text-muted-foreground mt-1">
                          The database was replaced underneath the running app before the
                          failure, so pages may show stale or inconsistent data until it
                          restarts.
                        </p>
                      </div>
                    </div>
                  )}

                  {restoreFailure.safetyBackupId && (
                    <p className="text-xs text-muted-foreground">
                      The safety copy taken before this attempt is in the list, marked
                      “Safety copy”. Restore that to return to how things were.
                    </p>
                  )}
                </div>

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => { setRestoreTarget(null); setRestoreFailure(null); }}
                  >
                    Close
                  </Button>
                </DialogFooter>
              </>
            ) : restoreOutcome ? (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    {restoreOutcome.ok
                      ? <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                      : <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />}
                    {restoreOutcome.ok ? 'Restore complete' : 'Restore finished with warnings'}
                  </DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium mb-2">What happened</p>
                    <div className="space-y-1.5">
                      {restoreOutcome.steps.map((s, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          {s.ok
                            ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                            : <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />}
                          <div><span className="font-medium">{s.step}</span>
                            <span className="text-muted-foreground"> — {s.detail}</span></div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {restoreOutcome.verification.length > 0 && (
                    <div>
                      <p className="text-sm font-medium mb-2">Checks against the backup</p>
                      <CheckList checks={restoreOutcome.verification} />
                    </div>
                  )}

                  {restoreOutcome.restartRequired && (
                    <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                      <div className="text-sm">
                        <p className="font-semibold">Restart the server now.</p>
                        <p className="text-muted-foreground mt-1">
                          The database was replaced underneath the running app. Until it
                          restarts, some pages may show stale or inconsistent data.
                        </p>
                      </div>
                    </div>
                  )}

                  {restoreOutcome.safetyBackupId && (
                    <p className="text-xs text-muted-foreground">
                      A safety copy of the data as it was before this restore is in the list,
                      marked “Safety copy”. Restore that to undo this.
                    </p>
                  )}
                </div>

                <DialogFooter>
                  <Button onClick={() => { setRestoreTarget(null); setRestoreOutcome(null); }}>Close</Button>
                </DialogFooter>
              </>
            ) : (
              <form onSubmit={e => { e.preventDefault(); handleRestore(); }}>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="w-5 h-5" />
                    Restore over live data
                  </DialogTitle>
                  <DialogDescription>
                    Everything currently in the ERP will be replaced by the contents of{' '}
                    <span className="font-medium text-foreground">{restoreTarget?.filename}</span>,
                    taken {restoreTarget && ago(restoreTarget.createdAt)}. Any work recorded
                    since then will be gone.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 mt-4">
                  {/* Validation report — shown before the confirm button becomes usable */}
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-sm font-medium mb-2">Checks on this archive</p>
                    {validating ? (
                      <p className="text-sm text-muted-foreground flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" /> Opening the archive…
                      </p>
                    ) : validation ? (
                      <div className="space-y-1.5">
                        {validation.findings.map((f, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm">
                            {f.level === 'error' ? <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                              : f.level === 'warning' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                              : <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />}
                            <span className={f.level === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                              {f.message}
                            </span>
                          </div>
                        ))}
                        {validation.findings.length === 0 && (
                          <p className="text-sm text-muted-foreground">Nothing to report.</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Could not check this archive.</p>
                    )}
                  </div>

                  <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                    <p className="font-medium">Before anything is replaced, a backup of the current
                      data is taken automatically.</p>
                    <p className="text-muted-foreground mt-1">
                      The database is replaced in a single transaction, so if that step fails your
                      data is left exactly as it is. If a later step fails, part of the restore
                      will already have been applied — the report tells you which happened, and
                      the safety copy takes you back.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="restore-password">Confirm with your password</Label>
                    <Input
                      id="restore-password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Your account password"
                      value={restorePassword}
                      onChange={e => setRestorePassword(e.target.value)}
                      data-testid="input-restore-password"
                    />
                    <p className="text-xs text-muted-foreground">
                      Asked because this is the one action that can replace every record at once.
                    </p>
                  </div>
                </div>

                <DialogFooter className="mt-4">
                  <Button type="button" variant="outline" onClick={() => setRestoreTarget(null)}>Cancel</Button>
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={
                      !restorePassword || restoreBackup.isPending || validating ||
                      !validation?.ok
                    }
                    data-testid="button-confirm-restore"
                  >
                    {restoreBackup.isPending
                      ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Restoring…</>
                      : <><RotateCcw className="w-4 h-4 mr-2" /> Replace live data</>}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>

        {/* ── Delete confirmation ────────────────────────────────────────── */}
        <Dialog open={deleteTarget !== null} onOpenChange={o => { if (!o) setDeleteTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this backup?</DialogTitle>
              <DialogDescription>
                {deleteTarget?.filename} will be removed from storage permanently. If it is
                the only copy of that point in time, it cannot be recovered.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>Keep it</Button>
              <Button
                variant="destructive"
                disabled={deleteBackup.isPending}
                onClick={handleDelete}
                data-testid="button-confirm-delete"
              >
                {deleteBackup.isPending ? 'Deleting…' : 'Delete permanently'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
