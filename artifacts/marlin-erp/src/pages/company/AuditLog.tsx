import { useState } from 'react';
import { useListAuditLogs, type AuditLogEntry } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import {
  Shield, Search, ChevronLeft, ChevronRight, Eye, Plus, Pencil, Trash2,
  Filter, Calendar, RefreshCw,
  ShieldOff,
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';

const MODULES = [
  { value: 'all',        label: 'All Modules' },
  { value: 'sales',      label: 'Sales' },
  { value: 'purchases',  label: 'Purchases' },
  { value: 'production', label: 'Production' },
  { value: 'hr',         label: 'HR' },
  { value: 'payroll',    label: 'Payroll' },
  { value: 'transfers',  label: 'Transfers' },
];

const ACTIONS = [
  { value: 'all',    label: 'All Actions' },
  { value: 'CREATE', label: 'Create' },
  { value: 'UPDATE', label: 'Update' },
  { value: 'DELETE', label: 'Delete' },
];

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    CREATE: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    UPDATE: 'bg-blue-500/10   text-blue-600   border-blue-500/20',
    DELETE: 'bg-red-500/10    text-red-600    border-red-500/20',
  };
  const icons: Record<string, React.ReactElement> = {
    CREATE: <Plus  className="w-3 h-3 mr-1" />,
    UPDATE: <Pencil className="w-3 h-3 mr-1" />,
    DELETE: <Trash2 className="w-3 h-3 mr-1" />,
  };
  return (
    <Badge variant="outline" className={`uppercase text-xs flex items-center w-fit ${styles[action] ?? ''}`}>
      {icons[action]}
      {action}
    </Badge>
  );
}

function ModuleBadge({ module }: { module: string }) {
  const colors: Record<string, string> = {
    sales:      'bg-violet-500/10 text-violet-600 border-violet-500/20',
    purchases:  'bg-amber-500/10  text-amber-600  border-amber-500/20',
    production: 'bg-teal-500/10   text-teal-600   border-teal-500/20',
    hr:         'bg-pink-500/10   text-pink-600   border-pink-500/20',
    payroll:    'bg-indigo-500/10 text-indigo-600 border-indigo-500/20',
    transfers:  'bg-cyan-500/10   text-cyan-600   border-cyan-500/20',
  };
  return (
    <Badge variant="outline" className={`capitalize text-xs ${colors[module] ?? 'bg-muted/30'}`}>
      {module || 'system'}
    </Badge>
  );
}

function MetaViewer({ entry }: { entry: AuditLogEntry }) {
  const meta = entry.metadata as any;
  if (!meta) return <p className="text-xs text-muted-foreground italic">No additional details</p>;

  const sections: { title: string; data: Record<string, unknown> | undefined }[] = [];
  if (meta.before) sections.push({ title: 'Before', data: meta.before as any });
  if (meta.after)  sections.push({ title: 'After',  data: meta.after as any });
  if (!sections.length) sections.push({ title: 'Details', data: meta });

  return (
    <div className="space-y-4">
      {sections.map(({ title, data }) => (
        <div key={title}>
          <p className={`text-xs font-semibold mb-1.5 ${title === 'Before' ? 'text-red-500' : title === 'After' ? 'text-emerald-600' : 'text-muted-foreground'}`}>
            {title}
          </p>
          <div className="bg-muted/30 rounded-lg p-3 space-y-1.5">
            {Object.entries(data ?? {}).map(([k, v]) => (
              <div key={k} className="flex gap-3 text-xs">
                <span className="text-muted-foreground min-w-[100px] shrink-0">{k}</span>
                <span className="font-mono break-all">
                  {v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {meta.changes && Array.isArray(meta.changes) && (
        <div>
          <p className="text-xs font-semibold mb-1.5 text-muted-foreground">Changed Fields</p>
          <div className="flex flex-wrap gap-1">
            {(meta.changes as string[]).map((c: string) => (
              <Badge key={c} variant="secondary" className="text-xs font-mono">{c}</Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AuditLog() {
  const perm = usePermission('page:/company/audit');
  const [page,        setPage]        = useState(1);
  const [module,      setModule]      = useState('all');
  const [action,      setAction]      = useState('all');
  const [dateFrom,    setDateFrom]    = useState('');
  const [dateTo,      setDateTo]      = useState('');
  const [search,      setSearch]      = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [viewEntry,   setViewEntry]   = useState<AuditLogEntry | null>(null);

  const LIMIT = 50;

  const { data, isLoading, refetch, isFetching } = useListAuditLogs({
    page, limit: LIMIT,
    module:   module !== 'all' ? module : undefined,
    action:   action !== 'all' ? action : undefined,
    dateFrom: dateFrom || undefined,
    dateTo:   dateTo   || undefined,
    search:   search   || undefined,
  });

  const logs       = data?.logs       ?? [];
  const total      = data?.total      ?? 0;
  const totalPages = data?.totalPages ?? 1;

  const resetFilters = () => {
    setModule('all'); setAction('all'); setDateFrom(''); setDateTo('');
    setSearch(''); setSearchInput(''); setPage(1);
  };

  const hasFilters = module !== 'all' || action !== 'all' || !!dateFrom || !!dateTo || !!search;

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.<br />Contact your administrator to request access.</p>
          </div>
        </div>
      </AppLayout>
    );
  }
  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Shield className="w-6 h-6 text-primary" /> Audit Trail
            </h1>
            <p className="text-muted-foreground mt-1">Read-only log of all create, update, and delete actions</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>

        {/* Filters */}
        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Filter className="w-4 h-4" /> Filters
            {hasFilters && (
              <button onClick={resetFilters} className="ml-auto text-xs text-primary hover:underline">
                Clear all
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {/* Search */}
            <div className="relative lg:col-span-2">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search descriptions…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { setSearch(searchInput); setPage(1); } }}
                className="pl-9"
              />
            </div>
            {/* Module */}
            <Select value={module} onValueChange={v => { setModule(v); setPage(1); }}>
              <SelectTrigger><SelectValue placeholder="Module" /></SelectTrigger>
              <SelectContent>
                {MODULES.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {/* Action */}
            <Select value={action} onValueChange={v => { setAction(v); setPage(1); }}>
              <SelectTrigger><SelectValue placeholder="Action" /></SelectTrigger>
              <SelectContent>
                {ACTIONS.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {/* Date From */}
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} className="text-sm" />
            </div>
          </div>
          {/* Date To (separate row for readability) */}
          {dateFrom && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-24">To date</span>
              <Input type="date" value={dateTo} min={dateFrom} onChange={e => { setDateTo(e.target.value); setPage(1); }} className="text-sm max-w-[180px]" />
            </div>
          )}
        </div>

        {/* Summary */}
        <div className="flex items-center justify-between text-sm text-muted-foreground px-1">
          <span>{total.toLocaleString('en-IN')} log entr{total === 1 ? 'y' : 'ies'}{hasFilters ? ' (filtered)' : ''}</span>
          {totalPages > 1 && (
            <span>Page {page} of {totalPages}</span>
          )}
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead className="w-40">Timestamp</TableHead>
                <TableHead className="w-24">Action</TableHead>
                <TableHead className="w-28">Module</TableHead>
                <TableHead className="w-28">Entity</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-28">User</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(8)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
                  </TableRow>
                ))
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-16 text-muted-foreground">
                    <Shield className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>{hasFilters ? 'No logs match your filters' : 'No audit logs yet — actions will appear here as you use the system'}</p>
                  </TableCell>
                </TableRow>
              ) : (
                logs.map(log => (
                  <TableRow key={log.id} className="hover:bg-muted/10">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-mono">
                      {new Date(log.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                    </TableCell>
                    <TableCell><ActionBadge action={log.action} /></TableCell>
                    <TableCell><ModuleBadge module={log.module} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {log.entityType && (
                        <span className="capitalize">{log.entityType}</span>
                      )}
                      {log.entityId && (
                        <span className="font-mono ml-1 text-muted-foreground/60">#{log.entityId}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm max-w-[320px]">
                      <p className="truncate">{log.description}</p>
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="bg-muted/40 rounded px-1.5 py-0.5 font-mono text-muted-foreground">{log.user}</span>
                    </TableCell>
                    <TableCell>
                      {log.metadata && (
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 hover:text-primary"
                          onClick={() => setViewEntry(log)} title="View details"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="p-3 border-t border-border flex items-center justify-between">
              <Button
                variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1 || isFetching}
              >
                <ChevronLeft className="w-4 h-4 mr-1" /> Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                {((page - 1) * LIMIT + 1).toLocaleString('en-IN')}–{Math.min(page * LIMIT, total).toLocaleString('en-IN')} of {total.toLocaleString('en-IN')}
              </span>
              <Button
                variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages || isFetching}
              >
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Detail Sheet */}
      <Sheet open={!!viewEntry} onOpenChange={v => !v && setViewEntry(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Audit Entry #{viewEntry?.id}
            </SheetTitle>
            <SheetDescription>
              {viewEntry && new Date(viewEntry.createdAt).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'medium' })}
            </SheetDescription>
          </SheetHeader>
          {viewEntry && (
            <div className="mt-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['Action',  <ActionBadge action={viewEntry.action} />],
                  ['Module',  <ModuleBadge module={viewEntry.module} />],
                  ['Entity',  <span className="text-sm capitalize">{viewEntry.entityType}{viewEntry.entityId ? ` #${viewEntry.entityId}` : ''}</span>],
                  ['User',    <span className="text-sm font-mono bg-muted/40 rounded px-1.5 py-0.5">{viewEntry.user}</span>],
                ].map(([k, v]) => (
                  <div key={String(k)} className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>

              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Description</p>
                <p className="text-sm">{viewEntry.description}</p>
              </div>

              {viewEntry.metadata && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Snapshot</p>
                    <MetaViewer entry={viewEntry} />
                  </div>
                </>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </AppLayout>
  );
}
