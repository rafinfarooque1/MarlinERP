/**
 * Reports Center — shared filter bar, table, cards, export helpers.
 *
 * Every report follows the same recipe:
 *   <ReportPicker/> → <RangeBar/> → <SummaryCards/> → <RTable/> + <ExportButtons/>
 *
 * PDF exports POST preformatted rows to /api/pdf/report (server-side jsPDF,
 * brand-styled). Money in PDFs uses "Rs." — the helvetica base-14 font has no
 * ₹ glyph. CSV/UI keep ₹.
 */
import { useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CalendarDays, Download, FileText, Loader2, Store, Warehouse, Factory } from 'lucide-react';
import { downloadPDFFromEndpoint } from '@/lib/download';
import { toast } from 'sonner';

// ── Formatters ────────────────────────────────────────────────────────────────
export const fmt = (n: number | null | undefined) =>
  `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const num = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
export const pdfMoney = (n: number | null | undefined) =>
  `Rs. ${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDate = (d?: string | null) =>
  d ? new Date(String(d).length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-IN') : '—';
export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function periodLabel(from?: string, to?: string): string {
  const f = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  if (from && to) return `${f(from)} – ${f(to)}`;
  if (from) return `From ${f(from)}`;
  if (to) return `Up to ${f(to)}`;
  return 'All time';
}

// ── Date range state ──────────────────────────────────────────────────────────
export type RangePreset = 'today' | 'week' | 'month' | 'fy' | 'all' | 'custom';

const PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
  { value: 'fy', label: 'This FY' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

const iso = (d: Date) => d.toISOString().split('T')[0];

function computeRange(preset: RangePreset, customFrom: string, customTo: string): { from: string; to: string } {
  const today = new Date();
  switch (preset) {
    case 'today': return { from: iso(today), to: iso(today) };
    case 'week':  return { from: iso(new Date(Date.now() - 6 * 86400_000)), to: iso(today) };
    case 'month': return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) };
    case 'fy': {
      const fyYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
      return { from: `${fyYear}-04-01`, to: iso(today) };
    }
    case 'custom': return { from: customFrom, to: customTo };
    default: return { from: '', to: '' };
  }
}

export interface RangeState {
  preset: RangePreset;
  setPreset: (p: RangePreset) => void;
  customFrom: string;
  customTo: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  /** Effective range (YYYY-MM-DD or '' = unbounded). */
  from: string;
  to: string;
}

export function useDateRange(initial: RangePreset = 'month'): RangeState {
  const [preset, setPreset] = useState<RangePreset>(initial);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const { from, to } = computeRange(preset, customFrom, customTo);
  return { preset, setPreset, customFrom, customTo, setFrom: setCustomFrom, setTo: setCustomTo, from, to };
}

export function RangeBar({ range, children }: { range: RangeState; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 bg-muted/20 border border-border rounded-lg p-1">
        <CalendarDays className="w-3.5 h-3.5 text-muted-foreground ml-1 shrink-0" />
        {PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => range.setPreset(p.value)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              range.preset === p.value
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {range.preset === 'custom' && (
        <div className="flex items-center gap-1.5">
          <Input type="date" value={range.customFrom} onChange={(e) => range.setFrom(e.target.value)} className="h-8 text-xs w-36" />
          <span className="text-muted-foreground text-xs">to</span>
          <Input type="date" value={range.customTo} onChange={(e) => range.setTo(e.target.value)} className="h-8 text-xs w-36" />
        </div>
      )}
      {children}
    </div>
  );
}

// ── Report picker (sub-report pills) ─────────────────────────────────────────
export function ReportPicker<const T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: NoInfer<T>;
  // NoInfer: otherwise Dispatch<SetStateAction<T>> pollutes inference and T collapses to string.
  onChange: (v: NoInfer<T>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
            value === o.value
              ? 'bg-primary text-primary-foreground border-primary shadow-sm'
              : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/40'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Summary cards ─────────────────────────────────────────────────────────────
export type CardTone = 'default' | 'pos' | 'neg' | 'warn' | 'accent';
const TONE_CLS: Record<CardTone, string> = {
  default: '',
  pos: 'text-emerald-600',
  neg: 'text-red-500',
  warn: 'text-amber-600',
  accent: 'text-primary',
};

export function SummaryCards({ cards }: { cards: { label: string; value: ReactNode; tone?: CardTone }[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-card border border-border rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground mb-1">{c.label}</p>
          <p className={`font-bold font-mono text-sm ${TONE_CLS[c.tone ?? 'default']}`}>{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// ── Location badge ────────────────────────────────────────────────────────────
export function LocationBadge({ type }: { type: string }) {
  if (type === 'warehouse')
    return (
      <Badge variant="outline" className="text-[10px] capitalize gap-1 border-blue-500/40 text-blue-600">
        <Warehouse className="w-2.5 h-2.5" /> Warehouse
      </Badge>
    );
  if (type === 'outlet')
    return (
      <Badge variant="outline" className="text-[10px] capitalize gap-1 border-emerald-500/40 text-emerald-600">
        <Store className="w-2.5 h-2.5" /> Outlet
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-[10px] capitalize gap-1 border-orange-500/40 text-orange-600">
      <Factory className="w-2.5 h-2.5" /> Production
    </Badge>
  );
}

// ── Generic report table ──────────────────────────────────────────────────────
export interface Col<T> {
  key: string;
  label: string;
  align?: 'right' | 'center';
  render?: (row: T) => ReactNode;
}

export function RTable<T>({ cols, rows, loading, empty = 'No records for the selected period', rowKey, footer }: {
  cols: Col<T>[];
  rows: T[];
  loading?: boolean;
  empty?: string;
  rowKey: (row: T, i: number) => string | number;
  /** Bold totals row — one cell per column. */
  footer?: ReactNode[];
}) {
  const alignCls = (c: Col<T>) => (c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : '');
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/10">
            {cols.map((c) => (
              <TableHead key={c.key} className={`whitespace-nowrap ${alignCls(c)}`}>{c.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            [...Array(5)].map((_, i) => (
              <TableRow key={i}>
                <TableCell colSpan={cols.length}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell>
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={cols.length} className="text-center py-14 text-muted-foreground">{empty}</TableCell>
            </TableRow>
          ) : (
            rows.map((r, i) => (
              <TableRow key={rowKey(r, i)} className="hover:bg-muted/10">
                {cols.map((c) => (
                  <TableCell key={c.key} className={`text-sm whitespace-nowrap ${alignCls(c)} ${c.align === 'right' ? 'font-mono' : ''}`}>
                    {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
          {!loading && rows.length > 0 && footer && (
            <TableRow className="bg-muted/20 border-t-2 border-border hover:bg-muted/20">
              {footer.map((f, i) => (
                <TableCell key={i} className={`font-bold text-sm whitespace-nowrap ${alignCls(cols[i] ?? {} as Col<T>)} ${cols[i]?.align === 'right' ? 'font-mono' : ''}`}>
                  {f}
                </TableCell>
              ))}
            </TableRow>
          )}
        </TableBody>
      </Table>
      {!loading && rows.length > 0 && (
        <div className="p-2.5 border-t border-border text-xs text-muted-foreground">
          {rows.length} record{rows.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

// ── PDF export ────────────────────────────────────────────────────────────────
export interface PdfCol { label: string; width?: number; align?: 'left' | 'right' | 'center' }
export interface PdfSection {
  heading?: string;
  columns: PdfCol[];
  rows: (string | number)[][];
  totalsRow?: (string | number)[];
}

/**
 * POST to the server-side renderer. MUST be invoked synchronously from the
 * click handler — downloadPDFFromEndpoint opens the preview window immediately
 * so popup blockers don't eat it.
 */
export function exportReportPdf(opts: {
  title: string;
  subtitle?: string;
  metaRows?: [string, string][];
  orientation?: 'portrait' | 'landscape';
  sections: PdfSection[];
  footerNote?: string;
  filename?: string;
}): Promise<void> {
  const filename = `${(opts.filename ?? opts.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.pdf`;
  const { filename: _f, ...payload } = opts;
  return downloadPDFFromEndpoint('/api/pdf/report', payload, filename);
}

// ── Export buttons ────────────────────────────────────────────────────────────
export function ExportButtons({ onCSV, onPDF, disabled }: {
  onCSV?: () => void;
  onPDF?: () => Promise<void> | void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const handlePdf = () => {
    if (!onPDF) return;
    // Call synchronously so the popup window opens inside the click gesture.
    const p = onPDF();
    if (p && typeof (p as Promise<void>).then === 'function') {
      setBusy(true);
      (p as Promise<void>)
        .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'PDF export failed'))
        .finally(() => setBusy(false));
    }
  };
  return (
    <div className="flex items-center gap-2 ml-auto">
      {onCSV && (
        <Button variant="outline" size="sm" onClick={onCSV} disabled={disabled}>
          <Download className="w-4 h-4 mr-2" /> CSV
        </Button>
      )}
      {onPDF && (
        <Button variant="outline" size="sm" onClick={handlePdf} disabled={disabled || busy}>
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />} PDF
        </Button>
      )}
    </div>
  );
}
