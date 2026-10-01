import { useState } from 'react';
import { useGetLedgerStatement, useListAccountsFlat, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AccountCombobox } from '@/components/ui/account-combobox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FileText, Calendar, ShieldOff, ArrowDownCircle, ArrowUpCircle, ListChecks, Eye } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { usePermission } from '@/lib/usePermission';
import { useLocationContext, locationFilterParams } from '@/lib/locationContext';
import { PageHeader } from '@/components/app/page-header';
import { SummaryCard, SummaryCardGrid } from '@/components/app/summary-card';
import { EmptyState } from '@/components/app/empty-state';
import { TableSkeleton } from '@/components/app/loading-skeletons';
import { ExportButtons, pdfMoney, periodLabel, type ReportDoc } from '@/pages/reports/shared';
import { formatDate } from '@/lib/date';
import { inr } from '@/lib/currency';

export default function Ledger() {
  const perm = usePermission('page:/accounts/ledger');
  const { data: accounts = [] } = useListAccountsFlat();
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();
  const [accountId, setAccountId] = useState<string>('');
  const [selectedEntry, setSelectedEntry] = useState<any>(null);
  const now = new Date();
  const [fromDate, setFromDate] = useState(`${now.getFullYear()}-01-01`);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);
  // Global location selector narrows the statement to that location's slice of
  // the books. The generated hook serialises every key of its params object
  // into the query string AND the cache key, so spreading the extra params is
  // both transport and cache-correct (the generated type just doesn't know
  // about them — hence the cast).
  const { locationState } = useLocationContext();
  const locParams = locationFilterParams(locationState);

  const { data: statement, isLoading } = useGetLedgerStatement(
    {
      ...(accountId && fromDate && toDate ? { accountId: Number(accountId), fromDate, toDate } : { accountId: 0, fromDate, toDate }),
      ...locParams,
    } as any,
    { query: { enabled: !!accountId } as any }
  );

  const entries = (statement as any)?.entries || (statement as any)?.transactions || [];
  const showLocation = locationState.locationType === 'all';
  const entryLocationName = (entry: any) => {
    if (entry.locationName) return entry.locationName;
    if (entry.locationType === 'headoffice') return 'Head Office';
    if (entry.locationType === 'warehouse') return (warehouses as any[]).find((w) => Number(w.id) === Number(entry.locationId))?.name ?? `Warehouse #${entry.locationId}`;
    if (entry.locationType === 'outlet') return (outlets as any[]).find((o) => Number(o.id) === Number(entry.locationId))?.name ?? `Outlet #${entry.locationId}`;
    return 'Company';
  };
  const account = (accounts as any[]).find((a: any) => a.id === Number(accountId));

  // Server-rendered Excel/PDF — the FULL filtered statement, never the
  // current sort page (entries already hold the whole range).
  const doc = (): ReportDoc => ({
    title: 'Ledger Statement',
    subtitle: `${account?.name ?? ''} · ${periodLabel(fromDate, toDate)}${locationState.locationName ? ` · ${locationState.locationName}` : ''}`,
    filename: `ledger-${(account?.name ?? 'statement').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    metaRows: [
      ['Account', `${account?.name ?? ''}${account?.code ? ` (${account.code})` : ''}`],
      ['Period', periodLabel(fromDate, toDate)],
      ['Opening Balance', pdfMoney(Number((statement as any)?.openingBalance ?? 0))],
      ['Total Debit', pdfMoney(Number((statement as any)?.totalDebit ?? 0))],
      ['Total Credit', pdfMoney(Number((statement as any)?.totalCredit ?? 0))],
      ['Closing Balance', pdfMoney(Number((statement as any)?.closingBalance ?? 0))],
    ],
    orientation: 'landscape',
    sections: [{
      columns: [
        { label: 'Date' },
        { label: 'Narration', width: 3 },
        ...(showLocation ? [{ label: 'Location' }] : []),
        { label: 'Type' },
        { label: 'Debit', align: 'right', width: 1.4 },
        { label: 'Credit', align: 'right', width: 1.4 },
        { label: 'Balance', align: 'right', width: 1.4 },
      ],
      rows: (entries as any[]).map((e: any) => [
        formatDate(e.date),
        e.displayNarration ?? e.narration ?? e.description,
        ...(showLocation ? [entryLocationName(e)] : []),
        e.displayEntryType ?? e.entryType,
        e.debit ? pdfMoney(Number(e.debit)) : '',
        e.credit ? pdfMoney(Number(e.credit)) : '',
        pdfMoney(Number(e.balance ?? 0)),
      ] as (string | number)[]),
      totalsRow: ['', 'Total', ...(showLocation ? [''] : []), '', pdfMoney(Number((statement as any)?.totalDebit ?? 0)), pdfMoney(Number((statement as any)?.totalCredit ?? 0)), pdfMoney(Number((statement as any)?.closingBalance ?? 0))],
    }],
  });

  const { sorted, sort } = useTableSort(entries as any[], {
    date: (e: any) => e.date,
    description: (e: any) => e.displayNarration ?? e.description,
    type: (e: any) => e.displayEntryType ?? e.entryType,
    debit: (e: any) => Number(e.debit) || null,
    credit: (e: any) => Number(e.credit) || null,
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
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeader
          title="Ledger Statement"
          description="Account-wise debit / credit statement"
          icon={FileText}
          actions={
            <ExportButtons
              canDownload={perm.canDownload}
              disabled={!entries.length}
              doc={doc}
               onCSV={() => downloadCSV('ledger.csv', entries.map((e: any) => ({ Date: formatDate(e.date), Narration: e.displayNarration ?? e.narration ?? e.description, ...(showLocation ? { Location: entryLocationName(e) } : {}), Type: e.displayEntryType ?? e.entryType, Debit: e.debit || 0, Credit: e.credit || 0, Balance: e.balance || 0 })))}
            />
          }
        />

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <AccountCombobox
            className="w-60"
            placeholder="Select account"
            options={(accounts as any[])
              .filter((a: any) => !a.isGroup)
              // Clean display names — the internal code renders as a subtle
              // secondary line inside the combobox and stays searchable there.
              .map((a: any) => ({ id: a.id, name: a.name, code: a.code ?? null }))}
            value={Number(accountId) || 0}
            onChange={id => setAccountId(String(id))}
          />
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
          </div>
        </div>

        {statement && (
          <SummaryCardGrid>
            <SummaryCard label="Opening Balance" value={`₹${Number(statement.openingBalance || 0).toLocaleString('en-IN')}`} icon={ArrowDownCircle} tone="info" loading={isLoading} />
            <SummaryCard label="Closing Balance" value={`₹${Number(statement.closingBalance || 0).toLocaleString('en-IN')}`} icon={ArrowUpCircle} tone="info" loading={isLoading} />
            <SummaryCard label="Entries" value={String(entries.length)} icon={ListChecks} tone="default" loading={isLoading} />
          </SummaryCardGrid>
        )}

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          {!accountId ? (
            <EmptyState icon={FileText} title="Select an account to view statement" />
          ) : isLoading ? (
            <TableSkeleton rows={5} cols={6} />
          ) : entries.length === 0 ? (
            <EmptyState icon={FileText} title="No entries for this period" />
          ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <SortableHead k="date" sort={sort}>Date</SortableHead>
                <SortableHead k="description" sort={sort}>Narration</SortableHead>
                {showLocation && <TableHead>Location</TableHead>}
                <SortableHead k="type" sort={sort}>Type</SortableHead>
                <SortableHead k="debit" sort={sort} className="text-right">Debit</SortableHead>
                <SortableHead k="credit" sort={sort} className="text-right">Credit</SortableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="w-14 text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((e: any, i: number) => {
                return (
                <TableRow
                  key={i}
                  className="hover:bg-muted/10"
                >
                  <TableCell className="text-sm">{formatDate(e.date)}</TableCell>
                  <TableCell className="text-sm">
                    <span className="inline-flex items-center gap-1.5">
                       {e.displayNarration ?? e.narration ?? e.description}
                    </span>
                  </TableCell>
                   {showLocation && <TableCell className="text-sm text-muted-foreground">{entryLocationName(e)}</TableCell>}
                  <TableCell><Badge variant="outline" className="text-xs">{e.displayEntryType ?? e.entryType}</Badge></TableCell>
                  <TableCell className="text-right font-mono text-red-500">{e.debit ? `₹${Number(e.debit).toLocaleString('en-IN')}` : '—'}</TableCell>
                  <TableCell className="text-right font-mono text-emerald-500">{e.credit ? `₹${Number(e.credit).toLocaleString('en-IN')}` : '—'}</TableCell>
                  <TableCell className="text-right font-mono font-bold">₹{Number(e.balance || 0).toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="View transaction details"
                      aria-label={`View transaction details for row ${i + 1}`}
                      data-testid={`button-ledger-details-${i}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedEntry(e);
                      }}
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
          )}
        </div>

        <Dialog open={!!selectedEntry} onOpenChange={(open) => !open && setSelectedEntry(null)}>
          {selectedEntry && (
            <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-ledger-entry-details">
              <DialogHeader>
                <DialogTitle>{selectedEntry.displayEntryType ?? selectedEntry.entryType} details</DialogTitle>
                <DialogDescription>
                  {formatDate(selectedEntry.date)}
                  {selectedEntry.reference ? ` · ${selectedEntry.reference}` : ''}
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg border border-border bg-muted/10 p-3">
                  <p className="text-xs text-muted-foreground">Debit</p>
                  <p className="mt-1 font-mono text-sm">{inr(Number(selectedEntry.debit) || 0)}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/10 p-3">
                  <p className="text-xs text-muted-foreground">Credit</p>
                  <p className="mt-1 font-mono text-sm">{inr(Number(selectedEntry.credit) || 0)}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/10 p-3">
                  <p className="text-xs text-muted-foreground">Balance</p>
                  <p className="mt-1 font-mono text-sm">{inr(Number(selectedEntry.balance) || 0)}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/10 p-3">
                  <p className="text-xs text-muted-foreground">Location</p>
                  <p className="mt-1 text-sm">{entryLocationName(selectedEntry)}</p>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Original transaction</h3>
                {(selectedEntry.sourceDetails ?? []).length ? (
                  selectedEntry.sourceDetails.map((detail: any, index: number) => (
                    detail.kind === 'stock_transfer' ? (
                      <div key={`transfer-${detail.transferId}-${detail.entryLabel}`} className="rounded-lg border border-border p-4 space-y-4" data-testid={`card-ledger-stock-transfer-${index}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">Stock Transfer</Badge>
                            <Badge variant="outline">{detail.entryLabel}</Badge>
                            {detail.reference && <span className="font-mono text-sm">{detail.reference}</span>}
                          </div>
                          {detail.totalValue != null && (
                            <span className="font-mono text-sm font-semibold">{inr(Number(detail.totalValue) || 0)}</span>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                          <div>
                            <span className="text-muted-foreground">Transfer date: </span>
                            {detail.date ? formatDate(detail.date) : '—'}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Status: </span>
                            <span className="capitalize">{detail.status || '—'}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Source: </span>
                            {detail.fromName || '—'}
                            {detail.fromType ? <span className="text-muted-foreground"> ({detail.fromType})</span> : ''}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Destination: </span>
                            {detail.toName || '—'}
                            {detail.toType ? <span className="text-muted-foreground"> ({detail.toType})</span> : ''}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Transfer type: </span>
                            <span className="capitalize">{String(detail.transferType || '—').replaceAll('_', ' ')}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Document mode: </span>
                            <span className="capitalize">{detail.documentMode || '—'}</span>
                          </div>
                          {detail.transferInvoiceNumber && (
                            <div className="sm:col-span-2">
                              <span className="text-muted-foreground">Transfer invoice: </span>
                              <span className="font-mono">{detail.transferInvoiceNumber}</span>
                            </div>
                          )}
                        </div>

                        {(detail.transferValue != null || detail.gstAmount != null) && (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-border pt-3">
                            {detail.transferValue != null && (
                              <div>
                                <p className="text-xs text-muted-foreground">Transfer value</p>
                                <p className="mt-1 font-mono text-sm">{inr(Number(detail.transferValue) || 0)}</p>
                              </div>
                            )}
                            {detail.gstAmount != null && (
                              <div>
                                <p className="text-xs text-muted-foreground">
                                  GST ({detail.taxType === 'cgst_sgst' ? 'CGST + SGST' : detail.taxType === 'igst' ? 'IGST' : 'tax'})
                                </p>
                                <p className="mt-1 font-mono text-sm">{inr(Number(detail.gstAmount) || 0)}</p>
                              </div>
                            )}
                            {detail.totalValue != null && (
                              <div>
                                <p className="text-xs text-muted-foreground">Total transfer document</p>
                                <p className="mt-1 font-mono text-sm">{inr(Number(detail.totalValue) || 0)}</p>
                              </div>
                            )}
                          </div>
                        )}

                        {detail.lines?.length > 0 && (
                          <div className="border-t border-border pt-3 space-y-2">
                            <p className="text-xs font-medium text-muted-foreground">Dispatched and received quantities</p>
                            <div className="space-y-2">
                              {detail.lines.map((line: any, lineIndex: number) => (
                                <div key={`${line.materialType}-${line.itemId}-${lineIndex}`} className="rounded-md bg-muted/20 p-3 space-y-2" data-testid={`row-ledger-transfer-line-${index}-${lineIndex}`}>
                                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                                    <span className="min-w-0 break-words text-sm font-medium">{line.itemName || `Product #${line.itemId}`}</span>
                                    <span className="text-xs capitalize text-muted-foreground">{String(line.materialType || 'item').replaceAll('_', ' ')}</span>
                                  </div>
                                  <div className="grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                      <p className="text-xs text-muted-foreground">Dispatched</p>
                                      <p className="mt-0.5 font-mono">{Number(line.dispatchedQuantity || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })}</p>
                                    </div>
                                    <div>
                                      <p className="text-xs text-muted-foreground">Received</p>
                                      <p className="mt-0.5 font-mono">
                                        {line.receivedQuantity == null
                                          ? 'Pending'
                                          : Number(line.receivedQuantity || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })}
                                      </p>
                                    </div>
                                  </div>
                                  {(line.unitCost != null || line.lineValue != null) && (
                                    <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border/60 pt-2 text-xs text-muted-foreground">
                                      {line.unitCost != null && <span>Unit cost: <span className="font-mono text-foreground">{inr(Number(line.unitCost) || 0)}</span></span>}
                                      {line.lineValue != null && <span>Line value: <span className="font-mono text-foreground">{inr(Number(line.lineValue) || 0)}</span></span>}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div key={`${detail.type}-${detail.reference ?? index}`} className="rounded-lg border border-border p-4 space-y-3" data-testid={`card-ledger-source-detail-${index}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{detail.type}</Badge>
                            {detail.reference && <span className="font-mono text-sm">{detail.reference}</span>}
                          </div>
                          <span className="font-mono text-sm font-semibold">{inr(Number(detail.amount) || 0)}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                          <div>
                            <span className="text-muted-foreground">Date: </span>
                            {detail.date ? formatDate(detail.date) : '—'}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Party: </span>
                            {detail.partyName || '—'}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Method: </span>
                            {detail.method || '—'}
                          </div>
                          <div>
                            <span className="text-muted-foreground">Reference: </span>
                            {detail.referenceNumber || '—'}
                          </div>
                        </div>
                        <p className="text-sm whitespace-pre-wrap break-words">{detail.narration || '—'}</p>
                        {detail.invoiceAllocations?.length > 0 && (
                          <div className="border-t border-border pt-3 space-y-2">
                            <p className="text-xs font-medium text-muted-foreground">Invoice allocations</p>
                            <div className="space-y-1.5">
                              {detail.invoiceAllocations.map((allocation: any, allocationIndex: number) => (
                                <div key={`${allocation.invoiceNumber ?? 'invoice'}-${allocationIndex}`} className="flex items-center justify-between gap-3 text-sm" data-testid={`row-ledger-invoice-allocation-${index}-${allocationIndex}`}>
                                  <span className="min-w-0 break-words">
                                    {allocation.invoiceNumber || 'Invoice'}
                                    {allocation.date ? <span className="text-muted-foreground"> · {formatDate(allocation.date)}</span> : ''}
                                  </span>
                                  <span className="shrink-0 font-mono">{inr(Number(allocation.amount) || 0)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  ))
                ) : (
                  <div className="rounded-lg border border-border p-4 space-y-2">
                    <p className="text-sm">{selectedEntry.displayNarration ?? selectedEntry.narration ?? selectedEntry.description ?? 'No additional source details.'}</p>
                    <p className="text-xs text-muted-foreground">No linked Sale, Receipt, Payment, or Stock Transfer record is available for this row.</p>
                  </div>
                )}
              </div>
            </DialogContent>
          )}
        </Dialog>
      </div>
    </AppLayout>
  );
}
