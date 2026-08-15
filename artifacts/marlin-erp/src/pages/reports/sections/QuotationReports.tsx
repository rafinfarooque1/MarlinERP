/**
 * Quotation Report — register of offers made, with date / customer / location /
 * status / salesperson filters.
 *
 * Deliberately its OWN category: quotations never touch stock or the books, so
 * none of these figures appear in — or reconcile against — the sales, GST or
 * financial reports. The value columns are "quoted", not revenue.
 */
import { useMemo, useState } from 'react';
import {
  usePaginatedQuotations, fetchAllQuotations, useListCustomers, useListWarehouses,
  type QuotationListRow,
} from '@workspace/api-client-react';
import { useEnabledOutlets } from '@/lib/locationStructure';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/app/status-badge';
import { TablePager } from '@/components/ui/table-pager';
import { usePermission } from '@/lib/usePermission';
import { downloadCSV } from '@/lib/download';
import {
  fmt, fmtDate, titleCase, periodLabel,
  useDateRange, RangeBar, SummaryCards, LocationBadge, RTable, ExportButtons,
  useLocationFilter, LocationFilter, type Col, type LocationOption, type ReportDoc,
} from '../shared';

const STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted'] as const;

export function QuotationsSection() {
  const perm = usePermission('page:/sales/quotations');
  const range = useDateRange('month');
  const loc = useLocationFilter();
  const [status, setStatus] = useState<string>('all');
  const [customerId, setCustomerId] = useState<string>('all');
  const [salesperson, setSalesperson] = useState('');
  const [page, setPage] = useState(1);
  const [PAGE_SIZE, setPageSize] = useState(50);

  const { data: customers = [] } = useListCustomers();
  const { data: warehouses = [], isLoading: whLoading } = useListWarehouses();
  const { data: outlets = [], isLoading: outLoading } = useEnabledOutlets();
  // Quotations exist only against a warehouse or an outlet — no head office.
  const locationOptions: LocationOption[] = [
    ...(warehouses as any[]).map((w: any) => ({ type: 'warehouse' as const, id: Number(w.id), name: `🏭 ${w.name}` })),
    ...(outlets as any[]).map((o: any) => ({ type: 'outlet' as const, id: Number(o.id), name: `🏪 ${o.name}` })),
  ];

  const filters = {
    from: range.from || undefined,
    to: range.to || undefined,
    status: status === 'all' ? undefined : status,
    customerId: customerId === 'all' ? undefined : Number(customerId),
    salesperson: salesperson.trim() || undefined,
    ...((loc.type === 'warehouse' || loc.type === 'outlet') && loc.id
      ? { locationType: loc.type, locationId: loc.id }
      : {}),
  };
  const { data: pageData, isLoading } = usePaginatedQuotations(page, PAGE_SIZE, filters);
  const rows = pageData?.rows ?? [];
  const total = pageData?.total ?? 0;

  const summary = useMemo(() => {
    const quotedValue = rows.reduce((s, r) => s + Number(r.totalAmount || 0), 0);
    const converted = rows.filter(r => r.status === 'converted');
    const open = rows.filter(r => r.status === 'draft' || r.status === 'sent' || r.status === 'accepted');
    return {
      quotedValue,
      count: rows.length,
      convertedCount: converted.length,
      convertedValue: converted.reduce((s, r) => s + Number(r.totalAmount || 0), 0),
      openCount: open.length,
      openValue: open.reduce((s, r) => s + Number(r.totalAmount || 0), 0),
    };
  }, [rows]);

  const cols: Col<QuotationListRow>[] = [
    { key: 'quotationNumber', label: 'Quotation', render: r => <span className="font-mono text-primary font-medium">{r.quotationNumber}</span> },
    { key: 'quoteDate', label: 'Date', render: r => fmtDate(r.quoteDate) },
    { key: 'customerName', label: 'Customer', render: r => r.customerName || 'Walk-in' },
    {
      key: 'locationName', label: 'Location',
      render: r => <span className="inline-flex items-center gap-1.5">{r.locationName} <LocationBadge type={r.locationType} /></span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge status={r.status} label={titleCase(r.status)} />
          {r.convertedInvoiceNumber && <span className="text-[10px] text-violet-600 font-mono">→ {r.convertedInvoiceNumber}</span>}
        </span>
      ),
    },
    { key: 'validTill', label: 'Valid Till', render: r => fmtDate(r.validTill) },
    { key: 'salesperson', label: 'Salesperson', render: r => r.salesperson || '—' },
    { key: 'taxTotal', label: 'GST (quoted)', align: 'right', sortValue: r => Number(r.taxTotal), render: r => fmt(Number(r.taxTotal)) },
    { key: 'totalAmount', label: 'Quoted Total', align: 'right', sortValue: r => Number(r.totalAmount), render: r => <span className="font-mono font-semibold">{fmt(Number(r.totalAmount))}</span> },
  ];

  // Export must cover the FULL filtered dataset, not the visible page.
  const csvRows = async () => (await fetchAllQuotations(filters)).map(r => ({
    Quotation: r.quotationNumber, Date: r.quoteDate, Customer: r.customerName || 'Walk-in',
    Location: r.locationName, Type: r.locationType, Status: titleCase(r.status),
    'Valid Till': r.validTill ?? '', Salesperson: r.salesperson ?? '',
    Subtotal: Number(r.subtotal).toFixed(2), GST: Number(r.taxTotal).toFixed(2),
    Discount: Number(r.discountTotal ?? 0).toFixed(2), Total: Number(r.totalAmount).toFixed(2),
    'Converted To': r.convertedInvoiceNumber ?? '',
  }));

  const doc = (): ReportDoc => ({
    title: 'Quotation Report',
    subtitle: periodLabel(range.from, range.to),
    orientation: 'landscape',
    sections: [{
      columns: [
        { label: 'Quotation' }, { label: 'Date' }, { label: 'Customer' }, { label: 'Location' },
        { label: 'Status' }, { label: 'Valid Till' }, { label: 'Salesperson' },
        { label: 'GST', align: 'right' }, { label: 'Total', align: 'right' },
      ],
      rows: rows.map(r => [
        r.quotationNumber, fmtDate(r.quoteDate), r.customerName || 'Walk-in', r.locationName,
        titleCase(r.status) + (r.convertedInvoiceNumber ? ` → ${r.convertedInvoiceNumber}` : ''),
        fmtDate(r.validTill), r.salesperson || '—',
        Number(r.taxTotal).toFixed(2), Number(r.totalAmount).toFixed(2),
      ]),
      totalsRow: ['', '', '', '', '', '', 'Page total',
        rows.reduce((s, r) => s + Number(r.taxTotal || 0), 0).toFixed(2),
        rows.reduce((s, r) => s + Number(r.totalAmount || 0), 0).toFixed(2)],
    }],
    footerNote: 'Quotations are offers only — they do not affect stock, GST or the books.',
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RangeBar range={range}>
          <LocationFilter state={loc} options={locationOptions} loading={whLoading || outLoading} />
          <Select value={status} onValueChange={v => { setStatus(v); setPage(1); }}>
            <SelectTrigger className="w-36 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map(s => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={customerId} onValueChange={v => { setCustomerId(v); setPage(1); }}>
            <SelectTrigger className="w-44 h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All customers</SelectItem>
              {(customers as any[]).map((c: any) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Salesperson…"
            className="w-36 h-9"
            value={salesperson}
            onChange={e => { setSalesperson(e.target.value); setPage(1); }}
          />
          <ExportButtons
            onCSV={async () => downloadCSV('quotation-report.csv', await csvRows())}
            doc={doc}
            disabled={rows.length === 0}
            canDownload={perm.canDownload}
          />
        </RangeBar>
      </div>

      <SummaryCards
        cards={[
          { label: 'Quotations (page)', value: String(summary.count), tone: 'default' },
          { label: 'Quoted Value', value: fmt(summary.quotedValue), tone: 'accent' },
          { label: 'Open (draft/sent/accepted)', value: `${summary.openCount} · ${fmt(summary.openValue)}`, tone: 'warn' },
          { label: 'Converted to Sales', value: `${summary.convertedCount} · ${fmt(summary.convertedValue)}`, tone: 'pos' },
        ]}
      />

      <RTable
        cols={cols}
        rows={rows}
        loading={isLoading}
        empty="No quotations for the selected filters"
        rowKey={r => r.id}
      />

      <TablePager
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        isFetching={isLoading}
      />

      <p className="text-xs text-muted-foreground">
        Quotations are offers only — none of these figures appear in sales, GST, financial or dashboard reports.
      </p>
    </div>
  );
}
