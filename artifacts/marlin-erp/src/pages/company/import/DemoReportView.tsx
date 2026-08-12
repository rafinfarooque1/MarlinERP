/**
 * Demo report pack viewer — the full set of accounting reports computed from
 * the demo import state (which was never committed). The user compares these
 * figures against the old ERP before approving the real import.
 */
import { useImportDemoReport, useMigrationDemoReport } from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fmtMoney, fmtTime } from './shared';
import { Loader2, MapPin } from 'lucide-react';

// ── Light local types for the pack (server is authoritative) ───────────────

interface GroupNode { id?: number; name: string; total: number; children?: GroupNode[] }
interface TBRow { code: string; name: string; groupName: string; debit: number; credit: number }
interface BookEntry { date: string; voucherNumber: string | null; description: string | null; debit: number; credit: number; balance: number }
interface Book { ledger: { name: string }; openingBalance: number; closingBalance: number; totalDebit: number; totalCredit: number; entries: BookEntry[] }
interface ValuationRow { itemName: string; materialType: string; quantity: number; unit: string; unitCost: number; value: number }

function GroupTree({ node, depth = 0 }: { node: GroupNode | null | undefined; depth?: number }) {
  if (!node) return null;
  const children = (node.children ?? []).filter((c) => Number(c.total) !== 0 || (c.children ?? []).length > 0);
  if (Number(node.total) === 0 && children.length === 0) return null;
  return (
    <>
      <div className="flex justify-between py-0.5 text-sm" style={{ paddingLeft: depth * 16 }}>
        <span className={depth === 0 ? 'font-medium' : 'text-muted-foreground'}>{node.name}</span>
        <span className={depth === 0 ? 'font-medium tabular-nums' : 'tabular-nums'}>{fmtMoney(node.total)}</span>
      </div>
      {children.map((c, i) => <GroupTree key={`${c.name}-${i}`} node={c} depth={depth + 1} />)}
    </>
  );
}

function MoneyLine({ label, value, bold, indent }: { label: string; value: number; bold?: boolean; indent?: boolean }) {
  return (
    <div className={`flex justify-between py-0.5 text-sm ${indent ? 'pl-4' : ''}`}>
      <span className={bold ? 'font-semibold' : ''}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-semibold' : ''}`}>{fmtMoney(value)}</span>
    </div>
  );
}

function BookView({ title, book }: { title: string; book: Book | null }) {
  if (!book) return <p className="text-sm text-muted-foreground">{title}: no ledger found.</p>;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">{title} — {book.ledger?.name}</div>
        <div className="text-xs text-muted-foreground">
          Opening {fmtMoney(book.openingBalance)} · Closing <span className="font-semibold text-foreground">{fmtMoney(book.closingBalance)}</span>
        </div>
      </div>
      {book.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No entries.</p>
      ) : (
        <div className="rounded-lg border overflow-x-auto max-h-[22rem] overflow-y-auto">
          <Table className="no-sticky-col">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Voucher</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {book.entries.map((e, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap text-xs">{e.date ? new Date(e.date).toLocaleDateString('en-IN') : '—'}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{e.voucherNumber ?? '—'}</TableCell>
                  <TableCell className="text-xs max-w-[18rem] truncate" title={e.description ?? ''}>{e.description ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{e.debit ? fmtMoney(e.debit) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{e.credit ? fmtMoney(e.credit) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{fmtMoney(e.balance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function DuesTable({ rows, total, partyWord }: { rows: Array<{ name: string; outstanding: number }>; total: number; partyWord: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-2">No outstanding {partyWord} dues.</p>;
  return (
    <div className="rounded-lg border overflow-x-auto max-h-[22rem] overflow-y-auto">
      <Table className="no-sticky-col">
        <TableHeader>
          <TableRow>
            <TableHead>{partyWord === 'customer' ? 'Customer' : 'Vendor'}</TableHead>
            <TableHead className="text-right">Outstanding</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="text-sm">{r.name}</TableCell>
              <TableCell className="text-right tabular-nums text-sm">{fmtMoney(r.outstanding)}</TableCell>
            </TableRow>
          ))}
          <TableRow className="font-semibold bg-muted/40">
            <TableCell>Total</TableCell>
            <TableCell className="text-right tabular-nums">{fmtMoney(total)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

// ── Main viewer ─────────────────────────────────────────────────────────────

export function DemoReportView({ batchId = null, migrationId = null, open, onOpenChange }: {
  /** Per-batch report (legacy standalone wizard batches). */
  batchId?: number | null;
  /** Migration report — ONE pack computed across all of the migration's files. */
  migrationId?: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const batchQ = useImportDemoReport(migrationId == null ? batchId : null, open);
  const migQ = useMigrationDemoReport(migrationId, open);
  const data = migrationId != null ? migQ.data : batchQ.data;
  const isLoading = migrationId != null ? migQ.isLoading : batchQ.isLoading;
  const report = data?.report as any;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Demo import — comparison reports</DialogTitle>
          <DialogDescription>
            These figures come from the demo run — nothing has been recorded in your books yet.
            Compare each report against your old ERP; approve the import only when they match.
            {data?.demoAt ? ` Demo run ${fmtTime(data.demoAt)} by ${data.demoBy}.` : ''}
          </DialogDescription>
        </DialogHeader>

        {/* Older packs were computed company-wide and carry no location — the
            label only appears on packs that are genuinely scoped. */}
        {report?.location?.name && (
          <div className="flex items-start gap-2 rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-sm text-blue-900 dark:text-blue-300">
            <MapPin className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              <span className="font-semibold">Figures for {report.location.name} only.</span>{' '}
              Every tab shows just this location's slice — compare it against the same location in your old ERP.
            </span>
          </div>
        )}

        {isLoading && (
          <div className="py-12 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        )}

        {report && (
          <Tabs defaultValue="overview">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tb">Trial Balance</TabsTrigger>
              <TabsTrigger value="pl">Profit &amp; Loss</TabsTrigger>
              <TabsTrigger value="bs">Balance Sheet</TabsTrigger>
              <TabsTrigger value="books">Cash &amp; Bank</TabsTrigger>
              <TabsTrigger value="dues">Dues</TabsTrigger>
              <TabsTrigger value="stock">Stock</TabsTrigger>
            </TabsList>

            {/* Overview */}
            <TabsContent value="overview" className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([
                  ['Customers owe you', report.kpis?.totalReceivables ?? 0],
                  ['You owe vendors', report.kpis?.totalPayables ?? 0],
                  ['Stock value (at cost)', report.kpis?.stockValue ?? 0],
                  ['Net profit', report.profitAndLoss?.summary?.netProfit ?? 0],
                ] as Array<[string, number]>).map(([label, value]) => (
                  <div key={label} className="rounded-lg border p-3">
                    <div className="text-lg font-bold tabular-nums">{fmtMoney(value)}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border p-3 space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  Trial balance
                  {report.trialBalance?.balanced
                    ? <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Balanced</Badge>
                    : <Badge variant="destructive">Off by {fmtMoney(report.trialBalance?.difference ?? 0)}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  Debits {fmtMoney(report.trialBalance?.totalDebit ?? 0)} · Credits {fmtMoney(report.trialBalance?.totalCredit ?? 0)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Open each tab and put the same report from your old ERP beside it. If a figure disagrees,
                fix the file or the mappings and run the demo again — nothing is final until you approve.
              </p>
            </TabsContent>

            {/* Trial balance */}
            <TabsContent value="tb" className="mt-4">
              <div className="rounded-lg border overflow-x-auto max-h-[26rem] overflow-y-auto">
                <Table className="no-sticky-col">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ledger</TableHead>
                      <TableHead>Group</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {((report.trialBalance?.rows ?? []) as TBRow[]).map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-sm">{r.name} <span className="text-xs text-muted-foreground font-mono">{r.code}</span></TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.groupName}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{r.debit ? fmtMoney(r.debit) : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">{r.credit ? fmtMoney(r.credit) : '—'}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold bg-muted/40">
                      <TableCell colSpan={2}>Total</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(report.trialBalance?.totalDebit ?? 0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoney(report.trialBalance?.totalCredit ?? 0)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            {/* P&L */}
            <TabsContent value="pl" className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <div className="text-sm font-semibold mb-2">Income</div>
                  <MoneyLine label="Gross sales" value={report.profitAndLoss?.incomes?.grossSales ?? 0} />
                  {Number(report.profitAndLoss?.incomes?.salesReturns ?? 0) !== 0 && (
                    <MoneyLine label="Less: sales returns" value={-(report.profitAndLoss?.incomes?.salesReturns ?? 0)} indent />
                  )}
                  <GroupTree node={report.profitAndLoss?.incomes?.directIncomes} />
                  <GroupTree node={report.profitAndLoss?.incomes?.indirectIncomes} />
                  <MoneyLine label="Closing stock" value={report.profitAndLoss?.incomes?.closingStock ?? 0} />
                  <div className="border-t mt-1 pt-1"><MoneyLine label="Total" value={report.profitAndLoss?.incomes?.total ?? 0} bold /></div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-sm font-semibold mb-2">Expenses</div>
                  <MoneyLine label="Opening stock" value={report.profitAndLoss?.expenses?.openingStock ?? 0} />
                  <MoneyLine label="Purchases" value={report.profitAndLoss?.expenses?.purchases ?? 0} />
                  {Number(report.profitAndLoss?.expenses?.purchaseReturns ?? 0) !== 0 && (
                    <MoneyLine label="Less: purchase returns" value={-(report.profitAndLoss?.expenses?.purchaseReturns ?? 0)} indent />
                  )}
                  <GroupTree node={report.profitAndLoss?.expenses?.directExpenses} />
                  <GroupTree node={report.profitAndLoss?.expenses?.indirectExpenses} />
                  <div className="border-t mt-1 pt-1"><MoneyLine label="Total" value={report.profitAndLoss?.expenses?.total ?? 0} bold /></div>
                </div>
              </div>
              <div className="rounded-lg border p-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  ['Revenue', report.profitAndLoss?.summary?.revenue ?? 0],
                  ['Gross profit', report.profitAndLoss?.summary?.grossProfit ?? 0],
                  ['Operating expenses', report.profitAndLoss?.summary?.operatingExpenses ?? 0],
                  ['Net profit', report.profitAndLoss?.summary?.netProfit ?? 0],
                ] as Array<[string, number]>).map(([label, value]) => (
                  <div key={label}>
                    <div className="text-sm font-bold tabular-nums">{fmtMoney(value)}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* Balance sheet */}
            <TabsContent value="bs" className="mt-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <div className="text-sm font-semibold mb-2">Assets</div>
                  <GroupTree node={report.balanceSheet?.assets?.fixedAssets} />
                  <GroupTree node={report.balanceSheet?.assets?.currentAssets} />
                  <MoneyLine label="Closing stock" value={report.balanceSheet?.assets?.closingStock ?? 0} />
                  <div className="border-t mt-1 pt-1"><MoneyLine label="Total assets" value={report.balanceSheet?.assets?.total ?? 0} bold /></div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-sm font-semibold mb-2">Liabilities</div>
                  <GroupTree node={report.balanceSheet?.liabilities?.capitalAccount} />
                  <MoneyLine label="Profit & loss carried forward" value={report.balanceSheet?.liabilities?.pandlCarryForward ?? 0} />
                  <GroupTree node={report.balanceSheet?.liabilities?.loans} />
                  <GroupTree node={report.balanceSheet?.liabilities?.currentLiabilities} />
                  <div className="border-t mt-1 pt-1"><MoneyLine label="Total liabilities" value={report.balanceSheet?.liabilities?.total ?? 0} bold /></div>
                  {Number(report.balanceSheet?.liabilities?.difference ?? 0) !== 0 && (
                    <p className="text-xs text-destructive mt-1">Difference: {fmtMoney(report.balanceSheet?.liabilities?.difference ?? 0)}</p>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* Cash & bank */}
            <TabsContent value="books" className="mt-4 space-y-6">
              <BookView title="Cash book" book={report.cashBook as Book | null} />
              <BookView title="Bank book" book={report.bankBook as Book | null} />
            </TabsContent>

            {/* Dues */}
            <TabsContent value="dues" className="mt-4 space-y-6">
              <div>
                <div className="text-sm font-semibold mb-2">Customers owe you (receivables)</div>
                <DuesTable rows={report.receivables?.rows ?? []} total={report.receivables?.total ?? 0} partyWord="customer" />
              </div>
              <div>
                <div className="text-sm font-semibold mb-2">You owe vendors (payables)</div>
                <DuesTable rows={report.payables?.rows ?? []} total={report.payables?.total ?? 0} partyWord="vendor" />
              </div>
            </TabsContent>

            {/* Stock */}
            <TabsContent value="stock" className="mt-4 space-y-3">
              {((report.stockValuation?.byProduct ?? []) as ValuationRow[]).length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No stock on hand.</p>
              ) : (
                <div className="rounded-lg border overflow-x-auto max-h-[24rem] overflow-y-auto">
                  <Table className="no-sticky-col">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                        <TableHead className="text-right">Unit cost</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {((report.stockValuation?.byProduct ?? []) as ValuationRow[]).map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{r.itemName}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{r.quantity} {r.unit}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{fmtMoney(r.unitCost)}</TableCell>
                          <TableCell className="text-right tabular-nums text-sm">{fmtMoney(r.value)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-semibold bg-muted/40">
                        <TableCell colSpan={3}>Stock on hand (at cost)</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtMoney(report.stockValuation?.onHandValue ?? 0)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
