import { useState } from 'react';
import {
  useGetHsnSummary, useGetGstr1, useGetGstr3b, useGetGstReconciliation,
  type HsnSummaryRow, type Gstr3bResponse,
} from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { FileSpreadsheet, Download, CheckCircle2, AlertTriangle, ShieldOff } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { usePermission } from '@/lib/usePermission';

const fmt = (n: number) => `₹${Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthLabel = (m: string) => {
  const d = new Date(`${m}-01T00:00:00`);
  return isNaN(d.getTime()) ? m : d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
};

function HsnTable({ title, rows, loading }: { title: string; rows: HsnSummaryRow[]; loading: boolean }) {
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20">
        <h3 className="font-semibold text-sm">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/10">
              <TableHead>HSN</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Taxable Value</TableHead>
              <TableHead className="text-right">CGST</TableHead>
              <TableHead className="text-right">SGST</TableHead>
              <TableHead className="text-right">IGST</TableHead>
              <TableHead className="text-right">Total Tax</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={9}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground text-sm">No records in this period</TableCell></TableRow>
            ) : rows.map((r, i) => (
              <TableRow key={i} className="hover:bg-muted/10">
                <TableCell className="font-mono text-xs">{r.hsnCode}</TableCell>
                <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                <TableCell className="text-right font-mono text-xs">{Number(r.quantity).toLocaleString('en-IN')}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.unit || '—'}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.cgst)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.sgst)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(r.igst)}</TableCell>
                <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.taxAmount)}</TableCell>
              </TableRow>
            ))}
            {rows.length > 1 && (
              <TableRow className="bg-muted/10 font-bold border-t-2">
                <TableCell colSpan={4} className="text-xs uppercase tracking-wider">Total</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.taxableValue), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.cgst), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.sgst), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.igst), 0))}</TableCell>
                <TableCell className="text-right font-mono text-xs">{fmt(rows.reduce((s, r) => s + Number(r.taxAmount), 0))}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function Gstr3bCard({ title, heads, total, totalLabel, accent }: {
  title: string;
  heads: { cgst: number; sgst: number; igst: number };
  total: number;
  totalLabel: string;
  accent: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">{title}</p>
      <div className="space-y-1.5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">CGST</span><span className="font-mono">{fmt(heads.cgst)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">SGST</span><span className="font-mono">{fmt(heads.sgst)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">IGST</span><span className="font-mono">{fmt(heads.igst)}</span></div>
        <div className="flex justify-between border-t border-border pt-1.5 mt-1.5 font-bold">
          <span>{totalLabel}</span><span className={`font-mono ${accent}`}>{fmt(total)}</span>
        </div>
      </div>
    </div>
  );
}

export default function GstReturns() {
  const perms = usePermission('page:/accounts/gst-returns');
  const now = new Date();
  const fyStart = `${now.getMonth() + 1 < 4 ? now.getFullYear() - 1 : now.getFullYear()}-04-01`;
  const [fromDate, setFromDate] = useState(fyStart);
  const [toDate, setToDate] = useState(now.toISOString().split('T')[0]);
  const [month, setMonth] = useState(now.toISOString().slice(0, 7));
  const [tab, setTab] = useState('hsn');

  const hsn = useGetHsnSummary({ fromDate, toDate });
  const g1 = useGetGstr1({ fromDate, toDate });
  const g3b = useGetGstr3b(month);
  const recon = useGetGstReconciliation({ fromDate, toDate });

  if (!perms.isLoading && !perms.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ShieldOff className="w-10 h-10 text-muted-foreground mb-3" />
          <h2 className="text-lg font-semibold">No access</h2>
          <p className="text-sm text-muted-foreground mt-1">You don't have permission to view GST Returns.</p>
        </div>
      </AppLayout>
    );
  }

  const b2b = g1.data?.b2b ?? [];
  const b2cs = g1.data?.b2cs ?? [];
  const d3b: Gstr3bResponse | undefined = g3b.data;
  const reconRows = recon.data?.rows ?? [];

  const exportHsn = () => {
    const mk = (r: HsnSummaryRow, type: string) => ({
      Type: type, HSN: r.hsnCode, 'Rate %': r.taxRate, Qty: r.quantity, Unit: r.unit,
      'Taxable Value': r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst, 'Total Tax': r.taxAmount,
    });
    downloadCSV(`hsn-summary-${fromDate}-to-${toDate}.csv`, [
      ...(hsn.data?.outward ?? []).map(r => mk(r, 'Outward (Sales)')),
      ...(hsn.data?.inward ?? []).map(r => mk(r, 'Inward (Purchases)')),
    ]);
  };
  const exportGstr1 = () => {
    downloadCSV(`gstr1-${fromDate}-to-${toDate}.csv`, [
      ...b2b.map(r => ({
        Section: 'B2B', 'Invoice No': r.invoiceNumber, Date: r.saleDate, Customer: r.customerName,
        GSTIN: r.gstin, 'Place of Supply': r.placeOfSupply, 'Rate %': r.taxRate,
        'Taxable Value': r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst,
        'Total Tax': r.taxAmount, 'Invoice Value': r.invoiceValue,
      })),
      ...b2cs.map(r => ({
        Section: 'B2C (Small)', 'Invoice No': '', Date: '', Customer: '', GSTIN: '',
        'Place of Supply': r.placeOfSupply, 'Rate %': r.taxRate,
        'Taxable Value': r.taxableValue, CGST: r.cgst, SGST: r.sgst, IGST: r.igst,
        'Total Tax': r.taxAmount, 'Invoice Value': '',
      })),
    ]);
  };
  const exportGstr3b = () => {
    if (!d3b) return;
    downloadCSV(`gstr3b-${month}.csv`, [
      { Section: '3.1(a) Outward taxable supplies', 'Taxable Value': d3b.outwardSupplies.taxableValue, CGST: d3b.outwardSupplies.cgst, SGST: d3b.outwardSupplies.sgst, IGST: d3b.outwardSupplies.igst, Total: d3b.outwardSupplies.totalTax },
      { Section: '3.1(c) Nil-rated / exempt supplies', 'Taxable Value': d3b.nilRatedSupplies.taxableValue, CGST: 0, SGST: 0, IGST: 0, Total: 0 },
      { Section: '4(A) Eligible ITC', 'Taxable Value': '', CGST: d3b.itc.cgst, SGST: d3b.itc.sgst, IGST: d3b.itc.igst, Total: d3b.itc.totalItc },
      { Section: '6.1 Net tax payable (after ITC set-off)', 'Taxable Value': '', CGST: d3b.netPayable.cgst, SGST: d3b.netPayable.sgst, IGST: d3b.netPayable.igst, Total: d3b.netPayable.total },
      { Section: 'ITC carried forward', 'Taxable Value': '', CGST: d3b.itcCarriedForward.cgst, SGST: d3b.itcCarriedForward.sgst, IGST: d3b.itcCarriedForward.igst, Total: d3b.itcCarriedForward.total },
    ]);
  };
  const exportRecon = () => {
    downloadCSV(`gst-reconciliation-${fromDate}-to-${toDate}.csv`, reconRows.map(r => ({
      Head: r.head, Ledger: r.ledgerCode, 'Ledger Amount': r.ledgerAmount,
      'Register Amount': r.registerAmount, Difference: r.difference,
    })));
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <FileSpreadsheet className="w-6 h-6 text-primary" /> GST Returns
            </h1>
            <p className="text-muted-foreground mt-1">HSN summary, GSTR-1 and GSTR-3B working data, and ledger reconciliation</p>
          </div>
        </div>

        {tab !== 'gstr3b' && (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-muted-foreground">Period:</span>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="w-36" />
            <span className="text-muted-foreground">to</span>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="w-36" />
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="hsn">HSN Summary</TabsTrigger>
            <TabsTrigger value="gstr1">GSTR-1</TabsTrigger>
            <TabsTrigger value="gstr3b">GSTR-3B</TabsTrigger>
            <TabsTrigger value="recon">Reconciliation</TabsTrigger>
          </TabsList>

          {/* ── HSN Summary ─────────────────────────────────────────────── */}
          <TabsContent value="hsn" className="space-y-4 mt-4">
            {perms.canDownload && (
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={exportHsn}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              </div>
            )}
            <HsnTable title="Outward Supplies (Sales)" rows={hsn.data?.outward ?? []} loading={hsn.isLoading} />
            <HsnTable title="Inward Supplies (Purchases)" rows={hsn.data?.inward ?? []} loading={hsn.isLoading} />
          </TabsContent>

          {/* ── GSTR-1 ──────────────────────────────────────────────────── */}
          <TabsContent value="gstr1" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex gap-2 flex-wrap">
                <Badge variant="secondary">{g1.data?.totals.invoiceCount ?? 0} invoices</Badge>
                <Badge variant="secondary">{g1.data?.totals.b2bInvoices ?? 0} B2B</Badge>
                <Badge variant="secondary">{g1.data?.totals.b2cInvoices ?? 0} B2C</Badge>
                <Badge variant="outline" className="font-mono">Tax: {fmt(g1.data?.totals.taxAmount ?? 0)}</Badge>
              </div>
              {perms.canDownload && (
                <Button variant="outline" size="sm" onClick={exportGstr1}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20">
                <h3 className="font-semibold text-sm">B2B Invoices (registered customers, rate-wise)</h3>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/10">
                      <TableHead>Invoice</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>GSTIN</TableHead>
                      <TableHead>POS</TableHead>
                      <TableHead>Rate</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">CGST</TableHead>
                      <TableHead className="text-right">SGST</TableHead>
                      <TableHead className="text-right">IGST</TableHead>
                      <TableHead className="text-right">Invoice Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g1.isLoading ? (
                      <TableRow><TableCell colSpan={11}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                    ) : b2b.length === 0 ? (
                      <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground text-sm">No B2B invoices in this period</TableCell></TableRow>
                    ) : b2b.map((r, i) => (
                      <TableRow key={i} className="hover:bg-muted/10">
                        <TableCell className="font-mono text-xs">{r.invoiceNumber}</TableCell>
                        <TableCell className="text-xs">{r.saleDate}</TableCell>
                        <TableCell className="text-xs">{r.customerName}</TableCell>
                        <TableCell className="font-mono text-xs">{r.gstin}</TableCell>
                        <TableCell className="text-xs">{r.placeOfSupply || '—'}</TableCell>
                        <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.cgst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.sgst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(r.igst)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.invoiceValue)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="p-4 border-b border-border bg-muted/20">
                <h3 className="font-semibold text-sm">B2C Small (unregistered, aggregated by place of supply & rate)</h3>
              </div>
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/10">
                    <TableHead>Place of Supply</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">CGST</TableHead>
                    <TableHead className="text-right">SGST</TableHead>
                    <TableHead className="text-right">IGST</TableHead>
                    <TableHead className="text-right">Total Tax</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g1.isLoading ? (
                    <TableRow><TableCell colSpan={7}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  ) : b2cs.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-sm">No B2C sales in this period</TableCell></TableRow>
                  ) : b2cs.map((r, i) => (
                    <TableRow key={i} className="hover:bg-muted/10">
                      <TableCell className="text-xs">{r.placeOfSupply || '—'}</TableCell>
                      <TableCell><Badge variant="secondary">{r.taxRate}%</Badge></TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.taxableValue)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.cgst)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.sgst)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.igst)}</TableCell>
                      <TableCell className="text-right font-mono text-xs font-bold">{fmt(r.taxAmount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* ── GSTR-3B ─────────────────────────────────────────────────── */}
          <TabsContent value="gstr3b" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Return month:</span>
                <Input type="month" value={month} onChange={e => setMonth(e.target.value)} className="w-44" />
              </div>
              {perms.canDownload && d3b && (
                <Button variant="outline" size="sm" onClick={exportGstr3b}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            {g3b.isLoading ? (
              <div className="h-40 bg-muted/30 rounded-xl animate-pulse" />
            ) : d3b ? (
              <>
                <div className="bg-card border border-border rounded-xl p-5">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">3.1(a) Outward Taxable Supplies — {monthLabel(d3b.month)}</p>
                      <p className="text-2xl font-bold font-mono mt-1">{fmt(d3b.outwardSupplies.taxableValue)}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Taxable value · {d3b.counts.sales} sales, {d3b.counts.purchases} purchases · Nil-rated: {fmt(d3b.nilRatedSupplies.taxableValue)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Output Tax</p>
                      <p className="text-2xl font-bold font-mono text-emerald-500 mt-1">{fmt(d3b.outwardSupplies.totalTax)}</p>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <Gstr3bCard title="3.1(a) Output Tax" heads={d3b.outwardSupplies} total={d3b.outwardSupplies.totalTax} totalLabel="Total" accent="text-emerald-500" />
                  <Gstr3bCard title="4(A) Eligible ITC" heads={d3b.itc} total={d3b.itc.totalItc} totalLabel="Total ITC" accent="text-primary" />
                  <Gstr3bCard title="6.1 Net Payable (cash)" heads={d3b.netPayable} total={d3b.netPayable.total} totalLabel="Payable" accent={d3b.netPayable.total > 0 ? 'text-red-500' : 'text-emerald-500'} />
                  <Gstr3bCard title="ITC Carried Forward" heads={d3b.itcCarriedForward} total={d3b.itcCarriedForward.total} totalLabel="Carry Fwd" accent="text-primary" />
                </div>
                <p className="text-xs text-muted-foreground">
                  Net payable applies the standard ITC set-off order: IGST credit against IGST → CGST → SGST; CGST credit against CGST → IGST; SGST credit against SGST → IGST.
                </p>
              </>
            ) : (
              <div className="text-center py-12 text-muted-foreground text-sm">Pick a month to compute GSTR-3B</div>
            )}
          </TabsContent>

          {/* ── Reconciliation ──────────────────────────────────────────── */}
          <TabsContent value="recon" className="space-y-4 mt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              {recon.data && (
                recon.data.matched ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 border-0">
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Ledgers match registers
                  </Badge>
                ) : (
                  <Badge className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 border-0">
                    <AlertTriangle className="w-3.5 h-3.5 mr-1" /> Differences found
                  </Badge>
                )
              )}
              {perms.canDownload && (
                <Button variant="outline" size="sm" onClick={exportRecon}><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
              )}
            </div>

            <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/10">
                    <TableHead>Tax Head</TableHead>
                    <TableHead>Ledger</TableHead>
                    <TableHead className="text-right">Ledger Balance</TableHead>
                    <TableHead className="text-right">Register Total</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recon.isLoading ? (
                    <TableRow><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
                  ) : reconRows.map((r) => (
                    <TableRow key={r.ledgerCode} className="hover:bg-muted/10">
                      <TableCell className="text-sm font-medium">{r.head}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{r.ledgerCode}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.ledgerAmount)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(r.registerAmount)}</TableCell>
                      <TableCell className="text-right">
                        {Math.abs(r.difference) < 0.05 ? (
                          <Badge variant="secondary" className="font-mono text-emerald-600">0.00</Badge>
                        ) : (
                          <Badge className="bg-red-500/15 text-red-600 hover:bg-red-500/15 border-0 font-mono">{r.difference > 0 ? '+' : '−'}{fmt(r.difference)}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {recon.data && (Math.abs(recon.data.dtxDirect) > 0.004 || Math.abs(recon.data.salesLumpResidual) > 0.004) && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm text-amber-700 dark:text-amber-400">
                <p className="font-medium mb-1">Legacy Duty & Tax lump: {fmt(recon.data.dtxDirect)}</p>
                <p className="text-xs opacity-80">{recon.data.note}</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
