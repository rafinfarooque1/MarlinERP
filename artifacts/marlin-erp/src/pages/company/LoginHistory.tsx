import { useState } from 'react';
import { useLoginHistory } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, ShieldAlert, Search, ChevronLeft, ChevronRight, Lock, ShieldOff } from 'lucide-react';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';

const REASON_LABELS: Record<string, string> = {
  invalid_credentials: 'Wrong password',
  invalid_credentials_locked: 'Wrong password — account locked',
  account_deactivated: 'Account deactivated',
  rate_limited: 'Too many attempts (locked out)',
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function LoginHistory() {
  const perm = usePermission('page:/company/login-history');
  const [page, setPage] = useState(1);
  const [usernameFilter, setUsernameFilter] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [successFilter, setSuccessFilter] = useState<'all' | 'true' | 'false'>('all');
  const limit = 25;

  const { data, isLoading, isFetching } = useLoginHistory({
    page,
    limit,
    username: usernameFilter || undefined,
    success: successFilter === 'all' ? '' : successFilter,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const lockedAccounts = data?.lockedAccounts ?? [];

  const { sorted, sort } = useTableSort(rows, {
    time: r => r.createdAt,
    user: r => r.employeeName || r.username,
    status: r => r.success,
    details: r => r.reason ? (REASON_LABELS[r.reason] ?? r.reason) : (r.success ? 'Signed in' : ''),
    ip: r => r.ip,
    device: r => r.userAgent,
  });

  const applyUsername = () => {
    setPage(1);
    setUsernameFilter(usernameInput.trim());
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
            <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.<br />Contact your administrator to request access.</p>
          </div>
        </div>
      </AppLayout>
    );
  }
  return (
    <AppLayout>
      <div className="space-y-6 font-sans">
        <PageHeader
          title="Login History"
          description="Every sign-in attempt — successful or failed — with who, when, and from where."
          icon={ShieldCheck}
        />

        {/* Active lockouts */}
        {lockedAccounts.length > 0 && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-destructive">
                <Lock className="w-4 h-4" />
                Currently locked accounts
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {lockedAccounts.map(acc => (
                <Badge key={acc.username} variant="destructive" className="font-mono">
                  {acc.username} · until {new Date(acc.lockedUntil).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </Badge>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter by username…"
              value={usernameInput}
              onChange={e => setUsernameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyUsername(); }}
              className="pl-9"
            />
          </div>
          <Select value={successFilter} onValueChange={(v: 'all' | 'true' | 'false') => { setSuccessFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All attempts</SelectItem>
              <SelectItem value="true">Successful only</SelectItem>
              <SelectItem value="false">Failed only</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={applyUsername}>Apply</Button>
        </div>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <TableSkeleton rows={8} cols={6} />
          ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead k="time" sort={sort}>Time</SortableHead>
                <SortableHead k="user" sort={sort}>User</SortableHead>
                <SortableHead k="status" sort={sort}>Status</SortableHead>
                <SortableHead k="details" sort={sort}>Details</SortableHead>
                <SortableHead k="ip" sort={sort} className="hidden md:table-cell">IP</SortableHead>
                <SortableHead k="device" sort={sort} className="hidden lg:table-cell">Device</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="p-0">
                    <EmptyState icon={ShieldCheck} title="No login attempts recorded yet." compact />
                  </TableCell>
                </TableRow>
              ) : sorted.map(row => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-sm">{fmtTime(row.createdAt)}</TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{row.employeeName || row.username}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.username}</div>
                  </TableCell>
                  <TableCell>
                    {row.success ? (
                      <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent hover:bg-emerald-500/15">
                        <ShieldCheck className="w-3 h-3 mr-1" /> Success
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="bg-destructive/15 text-destructive border-transparent hover:bg-destructive/15">
                        <ShieldAlert className="w-3 h-3 mr-1" /> Failed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.reason ? (REASON_LABELS[row.reason] ?? row.reason) : row.success ? 'Signed in' : '—'}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-xs font-mono text-muted-foreground">{row.ip || '—'}</TableCell>
                  <TableCell className="hidden lg:table-cell text-xs text-muted-foreground max-w-[220px] truncate" title={row.userAgent || undefined}>
                    {row.userAgent || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total > 0 ? `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} attempts` : 'No attempts'}
            {isFetching && !isLoading ? ' · refreshing…' : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="w-4 h-4" /> Prev
            </Button>
            <span className="text-sm text-muted-foreground">Page {page} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
