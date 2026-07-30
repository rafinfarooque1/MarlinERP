/**
 * Party reports — customer/vendor statements (mirror the existing ledger
 * semantics exactly) and receivables/payables aging.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  customFetch, useListCustomers, useListVendors, useReceivablesAging, usePayablesAging,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { downloadCSV } from '@/lib/download';
import {
  fmt, pdfMoney, fmtDate, titleCase, periodLabel,
  useDateRange, RangeBar, ReportPicker, SummaryCards, RTable, ExportButtons, exportReportPdf,
  type RangeState, type Col,
} from '../shared';

type PartyReport = 'customerStatement' | 'vendorStatement' | 'receivables' | 'payables';

interface LedgerEntry {
  date: string;
  description: string;
  entryType: string;
  debit: number;
  credit: number;
  balance: number;
}
interface CustomerLedger { balance: number; totalBilled: number; totalPaid: number; entries: LedgerEntry[] }
interface VendorLedger { balance: number; totalPurchased: number; totalPaid: number; entries: LedgerEntry[] }

const dkey = (d: string) => String(d).slice(0, 10);

// ── Statement (shared for customer & vendor) ─────────────────────────────────
function Statement({ kind, range, canDownload }: { kind: 'customer' | 'vendor'; range: RangeState; canDownload: boolean }) {
  const [partyId, setPartyId] = useState('');
  const { data: customers = [] } = useListCustomers();
  const { data: vendors = [] } = useListVendors();
  const parties = (kind === 'customer' ? customers : vendors) as { id: number; name: string }[];
  const party = parties.find((p) => String(p.id) === partyId);

  const url = kind === 'customer' ? `/api/customers/${partyId}/ledger` : `/api/vendors/${partyId}/ledger`;
  const { data, isLoading } = useQuery({
    queryKey: [url],
    queryFn: () => customFetch<CustomerLedger | VendorLedger>(url),
    enabled: !!partyId,
  });

  // Customer ledger: Dr − Cr = what they owe us. Vendor: Cr − Dr = what we owe.
  const sign = (e: LedgerEntry) => (kind === 'customer' ? e.debit - e.credit : e.credit - e.debit);
  const entries = data?.entries ?? [];
  const opening = range.from ? entries.filter((e) => dkey(e.date) < range.from).reduce((s, e) => s + sign(e), 0) : 0;
  const period = entries.filter((e) => (!range.from || dkey(e.date) >= range.from) && (!range.to || dkey(e.date) <= range.to));
  let run = opening;
  const rows = period.map((e, i) => ({ ...e, i, running: (run += sign(e)) }));
  const closing = run;
  const totalDebit = period.reduce((s, e) => s + e.debit, 0);
  const totalCredit = period.reduce((s, e) => s + e.credit, 0);
  const balNote = kind === 'customer' ? 'Positive balance = receivable from customer' : 'Positive balance = payable to vendor';
  const title = kind === 'customer' ? 'Customer Statement' : 'Vendor Statement';

  const csv = () => downloadCSV(`${kind}-statement-${(party?.name ?? 'party').toLowerCase().replace(/\s+/g, '-')}.csv`, [
    { Date: '', Description: 'Opening Balance', Type: '', 'Debit (₹)': '', 'Credit (₹)': '', 'Balance (₹)': opening.toFixed(2) },
    ...rows.map((r) => ({
      Date: dkey(r.date), Description: r.description, Type: r.entryType,
      'Debit (₹)': r.debit.toFixed(2), 'Credit (₹)': r.credit.toFixed(2), 'Balance (₹)': r.running.toFixed(2),
    })),
  ]);

  const pdf = () => exportReportPdf({
    title,
    subtitle: `${party?.name ?? ''}   |   Period: ${periodLabel(range.from, range.to)}`,
    metaRows: [
      [kind === 'customer' ? 'Customer' : 'Vendor', party?.name ?? '—'],
      ['Period', periodLabel(range.from, range.to)],
      ['Opening Balance', pdfMoney(opening)],
      ['Closing Balance', pdfMoney(closing)],
    ],
    sections: [{
      columns: [
        { label: 'Date' }, { label: 'Description', width: 2.8 }, { label: 'Type' },
        { label: 'Debit', align: 'right', width: 1.3 }, { label: 'Credit', align: 'right', width: 1.3 },
        { label: 'Balance', align: 'right', width: 1.3 },
      ],
      rows: [
        ['', 'Opening Balance', '', '', '', pdfMoney(opening)],
        ...rows.map((r) => [fmtDate(r.date), r.description, titleCase(r.entryType), r.debit ? pdfMoney(r.debit) : '-',
          r.credit ? pdfMoney(r.credit) : '-', pdfMoney(r.running)]),
      ],
      totalsRow: ['', 'Closing Balance', '', pdfMoney(totalDebit), pdfMoney(totalCredit), pdfMoney(closing)],
    }],
    footerNote: balNote,
    filename: `${kind}-statement-${party?.name ?? 'party'}`,
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <Select value={partyId} onValueChange={setPartyId}>
          <SelectTrigger className="h-8 text-xs w-56">
            <SelectValue placeholder={`Select ${kind}…`} />
          </SelectTrigger>
          <SelectContent>
            {parties.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <ExportButtons canDownload={canDownload} disabled={!partyId || isLoading} onCSV={csv} onPDF={pdf} />
      </RangeBar>

      {!partyId ? (
        <div className="bg-card border border-border rounded-xl p-14 text-center text-muted-foreground text-sm">
          Select a {kind} to view their statement
        </div>
      ) : (
        <>
          <SummaryCards cards={[
            { label: 'Opening Balance', value: fmt(opening) },
            { label: kind === 'customer' ? 'Billed (Dr)' : 'Payments (Dr)', value: fmt(totalDebit) },
            { label: kind === 'customer' ? 'Received (Cr)' : 'Purchases (Cr)', value: fmt(totalCredit) },
            { label: 'Closing Balance', value: fmt(closing), tone: closing > 0 ? (kind === 'customer' ? 'neg' : 'warn') : 'pos' },
          ]} />

          <RTable
            cols={[
              { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
              { key: 'description', label: 'Description' },
              { key: 'entryType', label: 'Type', render: (r) => <Badge variant="outline" className="text-[10px] capitalize">{titleCase(r.entryType)}</Badge> },
              { key: 'debit', label: 'Debit', align: 'right', render: (r) => (r.debit ? fmt(r.debit) : '—') },
              { key: 'credit', label: 'Credit', align: 'right', render: (r) => (r.credit ? fmt(r.credit) : '—') },
              { key: 'running', label: 'Balance', align: 'right', render: (r) => <b>{fmt(r.running)}</b> },
            ] satisfies Col<(typeof rows)[number]>[]}
            rows={rows} loading={isLoading} rowKey={(r) => r.i}
            empty="No transactions in the selected period"
            footer={['', 'Closing Balance', '', fmt(totalDebit), fmt(totalCredit), fmt(closing)]}
          />
          <p className="text-xs text-muted-foreground">{balNote}. Opening balance covers all activity before the period start.</p>
        </>
      )}
    </div>
  );
}

// ── Receivables aging ─────────────────────────────────────────────────────────
function ReceivablesReport({ canDownload }: { canDownload: boolean }) {
  const { data, isLoading } = useReceivablesAging();
  const rows = data?.customers ?? [];
  const t = data?.totals;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">As of {fmtDate(data?.asOf)} — aging is always current, not date-filtered</p>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('receivables-aging.csv', rows.map((r) => ({
            Customer: r.name, Phone: r.phone ?? '', '0-30 (₹)': r.b0_30.toFixed(2), '31-60 (₹)': r.b31_60.toFixed(2),
            '61-90 (₹)': r.b61_90.toFixed(2), '90+ (₹)': r.b90p.toFixed(2), 'Total Due (₹)': r.totalDue.toFixed(2),
            'Credit Notes (₹)': r.creditNotes.toFixed(2), 'Net Due (₹)': r.netDue.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Receivables Aging',
            subtitle: `As of ${fmtDate(data?.asOf)}`,
            metaRows: [['As of', fmtDate(data?.asOf)], ['Customers', String(rows.length)], ['Net Due', pdfMoney(t?.netDue)]],
            orientation: 'landscape',
            sections: [{
              columns: [
                { label: 'Customer', width: 2 }, { label: 'Phone', width: 1.2 },
                { label: '0-30 days', align: 'right', width: 1.2 }, { label: '31-60 days', align: 'right', width: 1.2 },
                { label: '61-90 days', align: 'right', width: 1.2 }, { label: '90+ days', align: 'right', width: 1.2 },
                { label: 'Total Due', align: 'right', width: 1.3 }, { label: 'Credit Notes', align: 'right', width: 1.2 },
                { label: 'Net Due', align: 'right', width: 1.3 },
              ],
              rows: rows.map((r) => [r.name, r.phone ?? '-', pdfMoney(r.b0_30), pdfMoney(r.b31_60), pdfMoney(r.b61_90),
                pdfMoney(r.b90p), pdfMoney(r.totalDue), pdfMoney(r.creditNotes), pdfMoney(r.netDue)]),
              totalsRow: ['TOTAL', '', pdfMoney(t?.b0_30), pdfMoney(t?.b31_60), pdfMoney(t?.b61_90), pdfMoney(t?.b90p),
                pdfMoney(t?.totalDue), pdfMoney(t?.creditNotes), pdfMoney(t?.netDue)],
            }],
          })}
        />
      </div>

      <SummaryCards cards={[
        { label: 'Total Due', value: fmt(t?.totalDue), tone: 'neg' },
        { label: '0–30 days', value: fmt(t?.b0_30) },
        { label: '31–90 days', value: fmt((t?.b31_60 ?? 0) + (t?.b61_90 ?? 0)), tone: 'warn' },
        { label: '90+ days', value: fmt(t?.b90p), tone: 'neg' },
      ]} />

      <RTable
        cols={[
          { key: 'name', label: 'Customer', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'b0_30', label: '0–30', align: 'right', render: (r) => fmt(r.b0_30) },
          { key: 'b31_60', label: '31–60', align: 'right', render: (r) => <span className={r.b31_60 > 0 ? 'text-amber-600' : ''}>{fmt(r.b31_60)}</span> },
          { key: 'b61_90', label: '61–90', align: 'right', render: (r) => <span className={r.b61_90 > 0 ? 'text-orange-600' : ''}>{fmt(r.b61_90)}</span> },
          { key: 'b90p', label: '90+', align: 'right', render: (r) => <span className={r.b90p > 0 ? 'text-red-500 font-bold' : ''}>{fmt(r.b90p)}</span> },
          { key: 'totalDue', label: 'Total Due', align: 'right', render: (r) => <b>{fmt(r.totalDue)}</b> },
          { key: 'creditNotes', label: 'Credit Notes', align: 'right', render: (r) => (r.creditNotes ? <span className="text-emerald-600">−{fmt(r.creditNotes)}</span> : '—') },
          { key: 'netDue', label: 'Net Due', align: 'right', render: (r) => <b className="text-red-500">{fmt(r.netDue)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.customerId}
        empty="No outstanding receivables 🎉"
        footer={['TOTAL', fmt(t?.b0_30), fmt(t?.b31_60), fmt(t?.b61_90), fmt(t?.b90p), fmt(t?.totalDue), fmt(t?.creditNotes), fmt(t?.netDue)]}
      />
    </div>
  );
}

// ── Payables aging ────────────────────────────────────────────────────────────
function PayablesReport({ canDownload }: { canDownload: boolean }) {
  const { data, isLoading } = usePayablesAging();
  const rows = data?.vendors ?? [];
  const t = data?.totals;
  // The control figure from the payables report: the sum of the vendor ledger
  // balances, which is Sundry Creditors on the Balance Sheet. Falls back to
  // summing the rows, which comes to the same thing by construction.
  const netPayable = t?.netDue ?? rows.reduce((s, r) => s + r.netDue, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">As of {fmtDate(data?.asOf)} — aging is always current, not date-filtered</p>
        <ExportButtons
          canDownload={canDownload}
          disabled={isLoading || rows.length === 0}
          onCSV={() => downloadCSV('payables-aging.csv', rows.map((r) => ({
            Vendor: r.name, Phone: r.phone ?? '', '0-30 (₹)': r.b0_30.toFixed(2), '31-60 (₹)': r.b31_60.toFixed(2),
            '61-90 (₹)': r.b61_90.toFixed(2), '90+ (₹)': r.b90p.toFixed(2), 'Billed (₹)': r.totalBilled.toFixed(2),
            'Paid (₹)': r.totalPaid.toFixed(2), 'Net Due (₹)': r.netDue.toFixed(2),
          })))}
          onPDF={() => exportReportPdf({
            title: 'Payables Aging',
            subtitle: `As of ${fmtDate(data?.asOf)}`,
            metaRows: [['As of', fmtDate(data?.asOf)], ['Vendors', String(rows.length)], ['Net Due', pdfMoney(netPayable)]],
            orientation: 'landscape',
            sections: [{
              columns: [
                { label: 'Vendor', width: 2 }, { label: 'Phone', width: 1.2 },
                { label: '0-30 days', align: 'right', width: 1.2 }, { label: '31-60 days', align: 'right', width: 1.2 },
                { label: '61-90 days', align: 'right', width: 1.2 }, { label: '90+ days', align: 'right', width: 1.2 },
                { label: 'Billed', align: 'right', width: 1.3 }, { label: 'Paid', align: 'right', width: 1.3 },
                { label: 'Net Due', align: 'right', width: 1.3 },
              ],
              rows: rows.map((r) => [r.name, r.phone ?? '-', pdfMoney(r.b0_30), pdfMoney(r.b31_60), pdfMoney(r.b61_90),
                pdfMoney(r.b90p), pdfMoney(r.totalBilled), pdfMoney(r.totalPaid), pdfMoney(r.netDue)]),
              totalsRow: ['TOTAL', '', pdfMoney(t?.b0_30), pdfMoney(t?.b31_60), pdfMoney(t?.b61_90), pdfMoney(t?.b90p),
                '', '', pdfMoney(netPayable)],
            }],
          })}
        />
      </div>

      <SummaryCards cards={[
        { label: 'Net Payable', value: fmt(netPayable), tone: 'warn' },
        { label: '0–30 days', value: fmt(t?.b0_30) },
        { label: '31–90 days', value: fmt((t?.b31_60 ?? 0) + (t?.b61_90 ?? 0)), tone: 'warn' },
        { label: '90+ days', value: fmt(t?.b90p), tone: 'neg' },
      ]} />

      <RTable
        cols={[
          { key: 'name', label: 'Vendor', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'b0_30', label: '0–30', align: 'right', render: (r) => fmt(r.b0_30) },
          { key: 'b31_60', label: '31–60', align: 'right', render: (r) => <span className={r.b31_60 > 0 ? 'text-amber-600' : ''}>{fmt(r.b31_60)}</span> },
          { key: 'b61_90', label: '61–90', align: 'right', render: (r) => <span className={r.b61_90 > 0 ? 'text-orange-600' : ''}>{fmt(r.b61_90)}</span> },
          { key: 'b90p', label: '90+', align: 'right', render: (r) => <span className={r.b90p > 0 ? 'text-red-500 font-bold' : ''}>{fmt(r.b90p)}</span> },
          { key: 'totalBilled', label: 'Billed', align: 'right', render: (r) => fmt(r.totalBilled) },
          { key: 'totalPaid', label: 'Paid', align: 'right', render: (r) => <span className="text-emerald-600">{fmt(r.totalPaid)}</span> },
          { key: 'netDue', label: 'Net Due', align: 'right', render: (r) => <b className="text-amber-700">{fmt(r.netDue)}</b> },
        ] satisfies Col<(typeof rows)[number]>[]}
        rows={rows} loading={isLoading} rowKey={(r) => r.vendorId}
        empty="No outstanding payables"
        footer={['TOTAL', fmt(t?.b0_30), fmt(t?.b31_60), fmt(t?.b61_90), fmt(t?.b90p), '', '', fmt(netPayable)]}
      />
    </div>
  );
}

// ── Section root ──────────────────────────────────────────────────────────────
export default function PartiesSection({ canCustomers = true, canVendors = true }: {
  canCustomers?: boolean;
  canVendors?: boolean;
}) {
  const { canDownload } = usePermission('page:/reports/sales');
  const range = useDateRange('fy');
  const [report, setReport] = useState<PartyReport>('customerStatement');
  // Sub-tabs are permission-gated: customer-side needs 'Customers', vendor-side 'Vendors'
  const isCustomerSide = (r: PartyReport) => r === 'customerStatement' || r === 'receivables';
  const active: PartyReport = (isCustomerSide(report) ? canCustomers : canVendors)
    ? report
    : (canCustomers ? 'customerStatement' : 'vendorStatement');
  return (
    <div className="space-y-4">
      <ReportPicker
        options={[
          ...(canCustomers ? [{ value: 'customerStatement' as const, label: 'Customer Statement' }] : []),
          ...(canVendors ? [{ value: 'vendorStatement' as const, label: 'Vendor Statement' }] : []),
          ...(canCustomers ? [{ value: 'receivables' as const, label: 'Receivables Aging' }] : []),
          ...(canVendors ? [{ value: 'payables' as const, label: 'Payables Aging' }] : []),
        ]}
        value={active} onChange={setReport}
      />
      {active === 'customerStatement' && <Statement kind="customer" range={range} canDownload={canDownload} />}
      {active === 'vendorStatement' && <Statement kind="vendor" range={range} canDownload={canDownload} />}
      {active === 'receivables' && <ReceivablesReport canDownload={canDownload} />}
      {active === 'payables' && <PayablesReport canDownload={canDownload} />}
    </div>
  );
}
