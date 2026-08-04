import { useEffect, useState } from 'react';
import { usePaginatedStockLedger, type StockLedgerRow } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, BookOpen, Download, ShieldOff, TrendingUp, TrendingDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { downloadCSV } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';

const money = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dtIN = (s: string) => {
  const d = new Date(s);
  return d.toLocaleDateString('en-IN') + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

const TXN_LABELS: Record<string, string> = {
  purchase:               'Purchase',
  purchase_reversal:      'Purchase Reversal',
  production_consumption: 'Production Consumption',
  production_output:      'Production Output',
  transfer_out:           'Transfer Out',
  transfer_in:            'Transfer In',
  sales_return:           'Sales Return',
  purchase_return:        'Purchase Return',
};

const TXN_COLORS: Record<string, string> = {
  purchase:               'text-emerald-500 border-emerald-500/30',
  production_output:      'text-emerald-500 border-emerald-500/30',
  transfer_in:            'text-emerald-500 border-emerald-500/30',
  sales_return:           'text-emerald-500 border-emerald-500/30',
  purchase_reversal:      'text-red-500 border-red-500/30',
  production_consumption: 'text-orange-500 border-orange-500/30',
  transfer_out:           'text-red-500 border-red-500/30',
  purchase_return:        'text-red-500 border-red-500/30',
};

const MAT_LABELS: Record<string, string> = {
  item:        'Item (SKU)',
  material:    'Raw Material',
  raw_material:'Packing Material',
};

function TxnBadge({ type }: { type: string }) {
  const cls = TXN_COLORS[type] ?? 'text-muted-foreground border-muted';
  return <Badge variant="outline" className={`text-[10px] ${cls}`}>{TXN_LABELS[type] ?? type}</Badge>;
}

export default function StockLedger() {
  const perm = usePermission('page:/headoffice/stock-ledger');
  const [search,    setSearch]    = useState('');
  const [debSearch, setDebSearch] = useState('');
  const [from,      setFrom]      = useState('');
  const [to,        setTo]        = useState('');
  const [matType,   setMatType]   = useState('all');
  const [txnType,   setTxnType]   = useState('all');
  const [page,      setPage]      = useState(1);
  const PAGE_SIZE = 50;

  useEffect(() => {
    const t = setTimeout(() => { setDebSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); }, [from, to, matType, txnType]);

  const { data, isLoading, isFetching } = usePaginatedStockLedger({
    page, limit: PAGE_SIZE,
    q:            debSearch || undefined,
    from:         from      || undefined,
    to:           to        || undefined,
    materialType: matType   !== 'all' ? matType   : undefined,
    txnType:      txnType   !== 'all' ? txnType   : undefined,
  });

  const rows: StockLedgerRow[] = data?.rows ?? [];
  // The server decides whether this employee may see cost; default to hidden
  // so a slow or failed response never flashes a rate at someone.
  const canSeeValue = data?.canViewValuation === true;
  const COLS = canSeeValue ? 9 : 8;
  const totalRows  = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  const { sorted, sort } = useTableSort(rows, {
    createdAt:      r => r.createdAt,
    txnType:        r => TXN_LABELS[r.txnType] ?? r.txnType,
    itemName:       r => r.itemName,
    materialType:   r => MAT_LABELS[r.materialType] ?? r.materialType,
    branchName:     r => r.branchName || r.branchType,
    qtyChange:      r => Number(r.qtyChange),
    runningBalance: r => Number(r.runningBalance),
    unitCost:       r => (r.unitCost != null ? Number(r.unitCost) : null),
    docType:        r => (r.docType && r.docId ? `${r.docType} ${r.docId}` : null),
  });

  if (!perm.isLoading && !perm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">Contact your administrator to request access.</p>
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
              <BookOpen className="w-6 h-6 text-primary" /> Stock Ledger
            </h1>
            <p className="text-muted-foreground mt-1">
              Immutable history of every inventory movement — purchase, production, transfer, return
            </p>
          </div>
          {perm.canDownload && (
          <Button variant="outline" size="sm" onClick={() => downloadCSV('stock-ledger.csv', rows.map(r => ({
            Date: dtIN(r.createdAt),
            'Transaction Type': TXN_LABELS[r.txnType] ?? r.txnType,
            Item: r.itemName,
            'Item Type': MAT_LABELS[r.materialType] ?? r.materialType,
            Location: r.branchName || r.branchType,
            'Qty Change': r.qtyChange,
            Unit: r.unit,
            'Running Balance': r.runningBalance,
            ...(canSeeValue ? { 'Unit Cost': r.unitCost } : {}),
            'Doc Type': r.docType,
            'Doc ID': r.docId ?? '',
            Notes: r.notes ?? '',
          })))}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {/* Filter bar */}
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="Search item name…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0"
              />
            </div>
            <input
              type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              title="From date"
            />
            <input
              type="date" value={to} onChange={e => setTo(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              title="To date"
            />
            <Select value={txnType} onValueChange={v => { setTxnType(v); setPage(1); }}>
              <SelectTrigger className="w-48"><SelectValue placeholder="All Transaction Types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Transactions</SelectItem>
                <SelectItem value="purchase">Purchase</SelectItem>
                <SelectItem value="purchase_reversal">Purchase Reversal</SelectItem>
                <SelectItem value="production_consumption">Production Consumption</SelectItem>
                <SelectItem value="production_output">Production Output</SelectItem>
                <SelectItem value="transfer_out">Transfer Out</SelectItem>
                <SelectItem value="transfer_in">Transfer In</SelectItem>
                <SelectItem value="sales_return">Sales Return</SelectItem>
                <SelectItem value="purchase_return">Purchase Return</SelectItem>
              </SelectContent>
            </Select>
            <Select value={matType} onValueChange={v => { setMatType(v); setPage(1); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All Item Types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Item Types</SelectItem>
                <SelectItem value="item">Item Name (SKU)</SelectItem>
                <SelectItem value="material">Raw Material</SelectItem>
                <SelectItem value="raw_material">Packing Material</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="createdAt" sort={sort}>Date &amp; Time</SortableHead>
                <SortableHead k="txnType" sort={sort}>Transaction</SortableHead>
                <SortableHead k="itemName" sort={sort}>Item</SortableHead>
                <SortableHead k="materialType" sort={sort}>Type</SortableHead>
                <SortableHead k="branchName" sort={sort}>Location</SortableHead>
                <SortableHead k="qtyChange" sort={sort} className="text-right">Qty Change</SortableHead>
                <SortableHead k="runningBalance" sort={sort} className="text-right">Running Balance</SortableHead>
                {canSeeValue && <SortableHead k="unitCost" sort={sort} className="text-right">Unit Cost</SortableHead>}
                <SortableHead k="docType" sort={sort}>Source Doc</SortableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={COLS}><div className="h-7 bg-muted/30 rounded animate-pulse" /></TableCell>
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={COLS} className="text-center py-16 text-muted-foreground">
                    <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-20" />
                    <p>No ledger entries found</p>
                    <p className="text-xs mt-1 opacity-60">Entries appear automatically when purchases, production, transfers, or returns are recorded.</p>
                  </TableCell>
                </TableRow>
              ) : sorted.map(r => {
                const isIn = r.qtyChange > 0;
                return (
                  <TableRow key={r.id} className="hover:bg-muted/10">
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{dtIN(r.createdAt)}</TableCell>
                    <TableCell><TxnBadge type={r.txnType} /></TableCell>
                    <TableCell className="font-medium max-w-[180px] truncate" title={r.itemName}>{r.itemName}</TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">{MAT_LABELS[r.materialType] ?? r.materialType}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.branchName || r.branchType}</TableCell>
                    <TableCell className={`text-right font-mono font-bold text-sm ${isIn ? 'text-emerald-500' : 'text-red-500'}`}>
                      <span className="inline-flex items-center gap-1">
                        {isIn
                          ? <TrendingUp className="w-3 h-3" />
                          : <TrendingDown className="w-3 h-3" />}
                        {isIn ? '+' : ''}{Number(r.qtyChange).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}
                        {r.unit ? <span className="text-[10px] font-normal text-muted-foreground ml-0.5">{r.unit}</span> : null}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-muted-foreground">
                      {Number(r.runningBalance).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}
                      {r.unit ? <span className="text-[10px] ml-0.5">{r.unit}</span> : null}
                    </TableCell>
                    {canSeeValue && (
                      <TableCell className="text-right font-mono text-sm text-muted-foreground">
                        {(r.unitCost ?? 0) > 0 ? money(r.unitCost!) : '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-xs text-muted-foreground">
                      {r.docType && r.docId ? (
                        <span className="capitalize">{r.docType.replace(/_/g, ' ')} #{r.docId}</span>
                      ) : (
                        <span className="opacity-40">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {totalRows > 0 && (
            <div className="p-3 border-t border-border text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalRows)} of {totalRows} entries
                {isFetching ? ' · refreshing…' : ''}
              </span>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <span className="px-1">Page {page}/{totalPages}</span>
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
