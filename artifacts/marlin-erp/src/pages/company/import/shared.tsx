/**
 * Shared metadata and small widgets for the ERP Migration Wizard
 * (Company › Import Data).
 */
import type { ImportBatch, ImportModule, ImportRow } from '@workspace/api-client-react';
import { Badge } from '@/components/ui/badge';
import {
  Users, Truck, BookOpen, ShoppingCart, Package, Receipt, Banknote,
  Boxes, NotebookPen, Warehouse,
} from 'lucide-react';

// ── Module metadata ─────────────────────────────────────────────────────────

export const MODULE_META: Record<ImportModule, { label: string; icon: typeof Users; blurb: string }> = {
  customers: {
    label: 'Customers', icon: Users,
    blurb: 'Creates customers with their debtor ledgers, credit limits and opening balances.',
  },
  vendors: {
    label: 'Vendors', icon: Truck,
    blurb: 'Creates vendors with their creditor ledgers and opening balances.',
  },
  ledgers: {
    label: 'Ledgers', icon: BookOpen,
    blurb: 'Creates chart-of-accounts ledgers under a valid group, with opening balances.',
  },
  items: {
    label: 'Items', icon: Boxes,
    blurb: 'Creates finished products with unit, HSN, GST rate, MRP and cost.',
  },
  sales: {
    label: 'Sales', icon: ShoppingCart,
    blurb: 'Old-ERP sales invoices with full stock, GST and settlement effects at a chosen location.',
  },
  purchases: {
    label: 'Purchases', icon: Package,
    blurb: 'Old-ERP purchase bills with stock, average cost, GST and vendor settlement effects.',
  },
  receipts: {
    label: 'Receipts', icon: Receipt,
    blurb: 'Money received from customers — allocated against outstanding invoices, excess parked as advances.',
  },
  payments: {
    label: 'Payments', icon: Banknote,
    blurb: 'Money paid to vendors — allocated against outstanding bills, excess parked as advances.',
  },
  daybook: {
    label: 'Day Book', icon: NotebookPen,
    blurb: 'Journal and contra vouchers — rows sharing a voucher number become one balanced voucher.',
  },
  opening_stock: {
    label: 'Opening Stock', icon: Warehouse,
    blurb: 'As-on-date stock quantities and unit costs, recorded as a stock verification at the chosen location.',
  },
};

export const MASTER_MODULES: ImportModule[] = ['customers', 'vendors', 'ledgers', 'items'];
export const WIZARD_MODULES: ImportModule[] = ['sales', 'purchases', 'receipts', 'payments', 'daybook', 'opening_stock'];

/** Line-based document imports (invoices/bills). */
export const isTxn = (m: ImportModule) => m === 'sales' || m === 'purchases';
/** Money voucher imports with invoice allocation. */
export const isVoucher = (m: ImportModule) => m === 'receipts' || m === 'payments';
/** Everything that goes through the mapping → demo → approve wizard. */
export const isWizard = (m: ImportModule) => WIZARD_MODULES.includes(m);
/** Whose party master the import references. */
export const partyIsCustomer = (m: ImportModule) => m === 'sales' || m === 'receipts';

export const MODULE_LABEL = (m: string) => MODULE_META[m as ImportModule]?.label ?? m;

/** What to show in the "Name" column — masters have a name, documents don't. */
export const rowLabel = (m: ImportModule, r: ImportRow) => {
  if (isVoucher(m)) return [r.values.voucherNo, r.values.party, r.values.amount && `₹${r.values.amount}`].filter(Boolean).join(' · ') || '—';
  if (isTxn(m)) return [r.values.invoiceNo, r.values.party, r.values.item].filter(Boolean).join(' · ') || '—';
  if (m === 'daybook') {
    const side = r.values.debit && Number(r.values.debit) !== 0 ? `Dr ₹${r.values.debit}` : r.values.credit ? `Cr ₹${r.values.credit}` : '';
    return [r.values.voucherNo, r.values.ledger, side].filter(Boolean).join(' · ') || '—';
  }
  if (m === 'opening_stock') return [r.values.item, r.values.quantity && `${r.values.quantity}`].filter(Boolean).join(' · ') || '—';
  return r.values.name ?? '—';
};

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

export const fmtMoney = (n: number) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Status badges ───────────────────────────────────────────────────────────

export function RowStatusBadge({ status }: { status: ImportRow['status'] }) {
  switch (status) {
    case 'valid':         return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Valid</Badge>;
    case 'warning':       return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Warning</Badge>;
    case 'needs_party':   return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Needs mapping</Badge>;
    case 'needs_mapping': return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Needs mapping</Badge>;
    case 'error':         return <Badge variant="destructive">Error</Badge>;
    case 'imported':      return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Imported</Badge>;
    case 'updated':       return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Updated</Badge>;
    case 'skipped':       return <Badge variant="secondary">Skipped</Badge>;
    case 'failed':        return <Badge variant="destructive">Failed</Badge>;
    case 'rolled_back':   return <Badge variant="outline">Rolled back</Badge>;
    default:              return <Badge variant="outline">{status}</Badge>;
  }
}

export function BatchStatusBadge({ b }: { b: ImportBatch }) {
  switch (b.status) {
    case 'validated':   return <Badge variant="secondary">{isWizard(b.module) ? 'At mapping / demo' : 'Awaiting commit'}</Badge>;
    case 'demo_ready':  return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Demo ready</Badge>;
    case 'committing':  return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Importing…</Badge>;
    case 'committed':   return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Imported</Badge>;
    case 'rolled_back': return <Badge variant="outline">Rolled back</Badge>;
    case 'discarded':   return <Badge variant="outline">Discarded</Badge>;
    default:            return <Badge variant="outline">{b.status}</Badge>;
  }
}

/** Planned (preview) or recorded (post-import) allocation for a voucher row. */
export function AllocationCell({ r }: { r: ImportRow }) {
  const created = r.created as { allocations?: Array<{ id: number; invoiceNumber: string | null; amount: number }>; advanceAmount?: number } | null;
  const allocations = created?.allocations ?? r.plan?.allocations ?? null;
  const advance = created?.advanceAmount ?? r.plan?.advance ?? 0;
  if (!allocations) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-0.5 text-xs">
      {allocations.map((a) => (
        <div key={a.id} className="whitespace-nowrap">
          {a.invoiceNumber ?? `#${a.id}`} — {fmtMoney(a.amount)}
        </div>
      ))}
      {advance > 0 && (
        <div className="whitespace-nowrap font-medium text-amber-700">Advance {fmtMoney(advance)}</div>
      )}
      {allocations.length === 0 && advance <= 0 && <span className="text-muted-foreground">—</span>}
    </div>
  );
}
