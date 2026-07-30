/**
 * Branch Transfer report — stock moved between the company's own locations.
 *
 * Read-only, one row per transfer LINE, so item, batch and quantity mean
 * something instead of a challan-level lump.
 *
 * Terminology: the sending side is "Transfer Out", the receiving side is
 * "Transfer In". A transfer behaves operationally like a sale out of one
 * location and a purchase into another, but it is neither — no revenue is
 * earned, nothing is bought, and an internal movement never carries an invoice
 * number. Those figures are deliberately kept out of every sales and purchase
 * total in the Reports Center.
 *
 * Location scope is enforced by the server: the filters below can only narrow
 * what the caller is already entitled to see, never widen it.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  customFetch, useBranchTransfersReport, useListItems,
  type BranchTransferReportRow,
} from '@workspace/api-client-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { usePermission } from '@/lib/usePermission';
import { useEnabledOutlets } from '@/lib/locationStructure';
import { downloadCSV } from '@/lib/download';
import {
  fmt, num, pdfMoney, fmtDate, titleCase, periodLabel,
  useDateRange, RangeBar, SummaryCards, LocationBadge, RTable, ExportButtons,
  type Col, type ReportDoc,
} from '../shared';

// A location is identified by a compound `${type}:${id}` key: warehouse #1 and
// outlet #1 are different places that share an id.
interface LocOption { type: 'warehouse' | 'outlet'; id: number; name: string }

function useTransferLocationOptions() {
  const wh = useQuery({
    queryKey: ['/api/warehouses'],
    queryFn: () => customFetch<{ id: number; name: string }[]>('/api/warehouses'),
  });
  const ou = useEnabledOutlets();
  const options: LocOption[] = [
    ...(wh.data ?? []).map((w) => ({ type: 'warehouse' as const, id: w.id, name: w.name })),
    ...ou.data.map((o) => ({ type: 'outlet' as const, id: o.id, name: o.name })),
  ];
  return { options, loading: wh.isLoading || ou.isLoading };
}

function LocationSelect({ label, value, onChange, options, loading }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: LocOption[];
  loading?: boolean;
}) {
  return (
    <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
      <SelectTrigger className="h-8 text-xs w-44" disabled={loading}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{label}</SelectItem>
        {options.map((o) => (
          <SelectItem key={`${o.type}:${o.id}`} value={`${o.type}:${o.id}`}>{o.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const statusBadge = (s: string) => {
  const map: Record<string, string> = {
    completed: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    in_transit: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    pending: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    rejected: 'bg-red-500/10 text-red-600 border-red-500/20',
  };
  return <Badge className={`text-[10px] capitalize ${map[s] ?? 'bg-muted/20 text-muted-foreground'}`}>{titleCase(s)}</Badge>;
};

function BranchTransferReport({ canDownload, canPrint }: { canDownload: boolean; canPrint: boolean }) {
  const range = useDateRange('month');
  const { options, loading: locLoading } = useTransferLocationOptions();
  const { data: items = [] } = useListItems();
  const [source, setSource] = useState('');
  const [dest, setDest] = useState('');
  const [itemId, setItemId] = useState('');
  const [status, setStatus] = useState('');

  const [sourceType = '', sourceIdRaw = ''] = source ? source.split(':') : [];
  const [destType = '', destIdRaw = ''] = dest ? dest.split(':') : [];

  const { data, isLoading } = useBranchTransfersReport({
    fromDate: range.from || undefined,
    toDate: range.to || undefined,
    sourceType: sourceType || undefined,
    sourceId: Number(sourceIdRaw) || undefined,
    destType: destType || undefined,
    destId: Number(destIdRaw) || undefined,
    itemId: Number(itemId) || undefined,
    // The dropdown lists finished items, and ids overlap across the product
    // tables, so the kind is pinned — otherwise picking item #7 would also
    // match raw material #7's transfer lines.
    materialType: itemId ? 'item' : undefined,
    status: status || undefined,
  });

  const rows = data?.rows ?? [];
  const totals = data?.totals;
  const summary = data?.summary;
  // The server decides whether this role may see what the stock COST, and it
  // simply leaves the figures out when it may not. Default to hidden so a
  // failed or in-flight request can never flash a cost, and never substitute a
  // zero — "₹0.00" would read as free stock rather than as withheld.
  const canSeeValue = data?.canViewValuation === true;
  const locName = (key: string) => options.find((o) => `${o.type}:${o.id}` === key)?.name ?? '';

  const batchLabel = (r: BranchTransferReportRow) => (r.batchNumbers.length ? r.batchNumbers.join(', ') : '');

  const doc = (): ReportDoc => ({
    title: 'Branch Transfer Report',
    subtitle: `Period: ${periodLabel(range.from, range.to)} — internal stock movement, not a sale or a purchase`,
    orientation: 'landscape',
    metaRows: [
      ['Period', periodLabel(range.from, range.to)],
      ['Source', source ? locName(source) : 'All permitted locations'],
      ['Destination', dest ? locName(dest) : 'All permitted locations'],
      ['Status', status ? titleCase(status) : 'All'],
      ['Transfer Out (completed)', `${num(summary?.transferOut.qty)} qty${canSeeValue ? ` · ${pdfMoney(summary?.transferOut.value)}` : ''}`],
      ['Transfer In (completed)', `${num(summary?.transferIn.qty)} qty${canSeeValue ? ` · ${pdfMoney(summary?.transferIn.value)}` : ''}`],
      ['In Transit', `${num(summary?.inTransit.qty)} qty${canSeeValue ? ` · ${pdfMoney(summary?.inTransit.value)}` : ''}`],
    ],
    sections: [{
      columns: [
        { label: 'Challan', width: 1.3 }, { label: 'Date' },
        { label: 'From', width: 1.4 }, { label: 'To', width: 1.4 },
        { label: 'Item', width: 1.8 }, { label: 'Batch', width: 1.2 },
        { label: 'Qty', align: 'right' as const }, { label: 'Unit' },
        ...(canSeeValue
          ? [{ label: 'Unit Cost', align: 'right' as const, width: 1.1 }, { label: 'Value', align: 'right' as const, width: 1.2 }]
          : []),
        { label: 'Status' }, { label: 'Dispatched' }, { label: 'Received' }, { label: 'Handled By', width: 1.2 },
      ],
      rows: rows.map((r) => [
        r.challanNumber, fmtDate(r.transferDate), r.sourceName, r.destName,
        r.itemName, batchLabel(r) || '-', num(r.quantity), r.unit,
        ...(canSeeValue ? [pdfMoney(r.unitCost), pdfMoney(r.lineValue)] : []),
        titleCase(r.status),
        r.dispatchDate ? fmtDate(r.dispatchDate) : '-',
        r.receivedDate ? fmtDate(r.receivedDate) : '-',
        r.handledBy ?? '-',
      ]),
      totalsRow: ['TOTAL', '', '', '', '', '', num(totals?.qty), '',
        ...(canSeeValue ? ['', pdfMoney(totals?.value)] : []),
        '', '', '', ''],
    }],
    footerNote: data?.basisNote,
  });

  return (
    <div className="space-y-4">
      <RangeBar range={range}>
        <LocationSelect label="All sources" value={source} onChange={setSource} options={options} loading={locLoading} />
        <LocationSelect label="All destinations" value={dest} onChange={setDest} options={options} loading={locLoading} />
        <Select value={itemId || 'all'} onValueChange={(v) => setItemId(v === 'all' ? '' : v)}>
          <SelectTrigger className="h-8 text-xs w-44"><SelectValue placeholder="All items" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All items</SelectItem>
            {(items as { id: number; name: string }[]).map((i) => (
              <SelectItem key={i.id} value={String(i.id)}>{i.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status || 'all'} onValueChange={(v) => setStatus(v === 'all' ? '' : v)}>
          <SelectTrigger className="h-8 text-xs w-36"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="in_transit">In Transit</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
        <ExportButtons
          canDownload={canDownload} canPrint={canPrint}
          disabled={isLoading || rows.length === 0}
          doc={doc}
          onCSV={() => downloadCSV('branch-transfers.csv', rows.map((r) => ({
            Challan: r.challanNumber,
            'Transfer Date': r.transferDate,
            'Source Type': titleCase(r.sourceType), Source: r.sourceName,
            'Destination Type': titleCase(r.destType), Destination: r.destName,
            'Product Type': r.materialTypeLabel, Item: r.itemName, Batch: batchLabel(r),
            Qty: r.quantity, 'Qty Basis': r.quantityBasis, Unit: r.unit,
            ...(canSeeValue
              ? { 'Unit Cost (₹)': (r.unitCost ?? 0).toFixed(2), 'Line Value (₹)': (r.lineValue ?? 0).toFixed(2) }
              : {}),
            Status: titleCase(r.status),
            'Dispatch Date': r.dispatchDate ?? '', 'Received Date': r.receivedDate ?? '',
            'Handled By': r.handledBy ?? '', 'Dispatched By': '',
          })))}
        />
      </RangeBar>

      <SummaryCards cards={[
        { label: 'Transfer Out (completed)', value: <>{num(summary?.transferOut.qty)}{canSeeValue && <> · {fmt(summary?.transferOut.value)}</>}</>, tone: 'accent' },
        { label: 'Transfer In (completed)', value: <>{num(summary?.transferIn.qty)}{canSeeValue && <> · {fmt(summary?.transferIn.value)}</>}</>, tone: 'pos' },
        { label: 'In Transit', value: <>{num(summary?.inTransit.qty)}{canSeeValue && <> · {fmt(summary?.inTransit.value)}</>}</>, tone: summary && summary.inTransit.qty > 0 ? 'warn' : 'default' },
        { label: 'Lines', value: num(totals?.lines) },
      ]} />

      <p className="text-xs text-muted-foreground bg-muted/20 border border-border rounded-lg p-3">
        A branch transfer moves the company's own stock between its own locations. Transfer Out behaves like a
        sale out of the source and Transfer In like a purchase into the destination, but a transfer is
        <b> neither revenue nor a purchase</b> and an internal movement carries no invoice number — only a challan.
        Transfer Out and Transfer In count <b>completed</b> transfers only; goods still on the road are reported
        separately as In Transit. Completed lines show the quantity the receiver actually recorded where they
        entered one.
      </p>

      <RTable
        cols={[
          { key: 'challanNumber', label: 'Challan', render: (r) => <span className="font-mono text-xs text-primary font-bold">{r.challanNumber}</span> },
          { key: 'transferDate', label: 'Date', render: (r) => fmtDate(r.transferDate) },
          { key: 'sourceName', label: 'Transfer Out (From)', render: (r) => (
            <span className="flex items-center gap-1.5"><LocationBadge type={r.sourceType} /><span className="font-medium">{r.sourceName}</span></span>
          ) },
          { key: 'destName', label: 'Transfer In (To)', render: (r) => (
            <span className="flex items-center gap-1.5"><LocationBadge type={r.destType} /><span className="font-medium">{r.destName}</span></span>
          ) },
          { key: 'itemName', label: 'Item', render: (r) => (
            <span className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">{r.materialTypeLabel}</Badge>
              <span className="font-medium">{r.itemName}</span>
            </span>
          ) },
          { key: 'batchNumbers', label: 'Batch', render: (r) => r.batchNumbers.length
            ? <span className="font-mono text-xs">{r.batchNumbers.join(', ')}</span>
            : <span className="text-muted-foreground">—</span> },
          { key: 'quantity', label: 'Qty', align: 'right', render: (r) => (
            <span title={r.quantityBasis === 'received' ? 'Quantity actually received' : 'Quantity dispatched'}>
              {num(r.quantity)}
              {r.quantityBasis === 'received' && <span className="text-[10px] text-emerald-600 ml-1">rcvd</span>}
            </span>
          ) },
          { key: 'unit', label: 'Unit', render: (r) => r.unit || <span className="text-muted-foreground">—</span> },
          ...(canSeeValue ? [
            { key: 'unitCost', label: 'Unit Cost', align: 'right' as const, render: (r: BranchTransferReportRow) => fmt(r.unitCost) },
            { key: 'lineValue', label: 'Value', align: 'right' as const, render: (r: BranchTransferReportRow) => <b>{fmt(r.lineValue)}</b> },
          ] : []),
          { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
          { key: 'dispatchDate', label: 'Dispatched', render: (r) => r.dispatchDate ? fmtDate(r.dispatchDate) : <span className="text-muted-foreground">—</span> },
          { key: 'receivedDate', label: 'Received', render: (r) => r.receivedDate ? fmtDate(r.receivedDate) : <span className="text-muted-foreground">—</span> },
          { key: 'handledBy', label: 'Handled By', render: (r) => r.handledBy ?? <span className="text-muted-foreground">—</span> },
          // No dispatcher is recorded on a transfer today — the column states
          // that plainly instead of showing the receiver's name in its place.
          { key: 'dispatchedBy', label: 'Dispatched By', render: () => <span className="text-muted-foreground" title="Not recorded — transfers do not capture a dispatcher yet">—</span> },
        ] satisfies Col<BranchTransferReportRow>[]}
        rows={rows} loading={isLoading}
        rowKey={(r, i) => `${r.transferId}:${r.materialType}:${r.itemId}:${i}`}
        empty="No branch transfers for the selected filters"
        footer={['TOTAL', '', '', '', '', '', num(totals?.qty), '',
          ...(canSeeValue ? ['', fmt(totals?.value)] : []),
          '', '', '', '', '']}
      />
    </div>
  );
}

// ── Section root ──────────────────────────────────────────────────────────────
export default function TransfersSection() {
  const { canDownload, canPrint } = usePermission('page:/reports/sales');
  return (
    <div className="space-y-4">
      <BranchTransferReport canDownload={canDownload} canPrint={canPrint} />
    </div>
  );
}
