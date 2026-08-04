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
import { CalendarDays, Download, FileText, Loader2, Store, Warehouse, Factory, Printer, Sheet, MapPin } from 'lucide-react';
import { downloadPDFFromEndpoint, downloadFileFromEndpoint, printPDFFromEndpoint } from '@/lib/download';
import { useTableSort, SortableHead } from '@/lib/tableSort';
import { useGetCompanySettings } from '@workspace/api-client-react';
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
export type RangePreset = 'today' | 'yesterday' | 'week' | 'month' | 'quarter' | 'fy' | 'all' | 'custom';

const PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'fy', label: 'This FY' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
];

// Local calendar date, NOT toISOString(): the UTC conversion rolls the date
// back a day for any user east of Greenwich until their local 05:30 (IST).
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function computeRange(
  preset: RangePreset,
  customFrom: string,
  customTo: string,
  fyStartMonth: number,
): { from: string; to: string } {
  const today = new Date();
  const fyStart0 = Math.min(Math.max(Math.round(fyStartMonth) || 4, 1), 12) - 1; // 0-based
  switch (preset) {
    case 'today': return { from: iso(today), to: iso(today) };
    case 'yesterday': {
      const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      return { from: iso(y), to: iso(y) };
    }
    case 'week':  return { from: iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)), to: iso(today) };
    case 'month': return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) };
    case 'quarter': {
      // Quarters are anchored to the financial year start (Apr–Jun, Jul–Sep, …
      // for an April FY), not the calendar year.
      const offset = (((today.getMonth() - fyStart0) % 12) + 12) % 12;
      const qStart = new Date(today.getFullYear(), today.getMonth() - (offset % 3), 1);
      return { from: iso(qStart), to: iso(today) };
    }
    case 'fy': {
      const fyYear = today.getMonth() >= fyStart0 ? today.getFullYear() : today.getFullYear() - 1;
      return { from: iso(new Date(fyYear, fyStart0, 1)), to: iso(today) };
    }
    case 'custom': {
      // A date input mid-edit can briefly hold a partial value — including a
      // year still being typed ('0002-…'), which is date-SHAPED but rejected
      // by the server's calendar validation. Treat anything but a complete,
      // plausible date as unbounded so a keystroke never 400s the list.
      const full = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 1000 ? v : '');
      return { from: full(customFrom), to: full(customTo) };
    }
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
  // FY presets follow the company's configured FY start month (defaults to
  // April). Cached by react-query, so this costs one fetch per session.
  const { data: settings } = useGetCompanySettings();
  const fyStartMonth = Number((settings as Record<string, unknown> | undefined)?.fyStartMonth) || 4;
  const { from, to } = computeRange(preset, customFrom, customTo, fyStartMonth);
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

// ── Warehouse / outlet filter ────────────────────────────────────────────────
/**
 * A report is filtered by ONE location at a time, identified by a compound key
 * `${type}:${id}` because warehouse #1 and outlet #1 are different places that
 * share an id.
 */
export interface LocationOption { type: 'warehouse' | 'outlet' | 'headoffice'; id: number; name: string }
export interface LocationFilterState {
  key: string;                       // '' = all locations
  setKey: (k: string) => void;
  type: '' | 'warehouse' | 'outlet' | 'headoffice';
  id: number;                        // 0 when unset
  label: string;
}

export function useLocationFilter(): LocationFilterState {
  const [key, setKey] = useState('');
  const [type = '', rawId = ''] = key ? key.split(':') : [];
  return {
    key, setKey,
    type: type as LocationFilterState['type'],
    id: Number(rawId) || 0,
    label: key ? key : 'All locations',
  };
}

/**
 * `disabledReason` renders the control greyed out with an explanation instead of
 * hiding it. Balance Sheet and Trial Balance are company-wide by construction —
 * the posting stream carries no location, so a per-warehouse slice of it would
 * be an unbalanced fragment, not a smaller balance sheet. Hiding the control
 * would make that look like an oversight; disabling it states the rule.
 */
export function LocationFilter({ state, options, loading, disabledReason }: {
  state: LocationFilterState;
  options: LocationOption[];
  loading?: boolean;
  disabledReason?: string;
}) {
  if (disabledReason) {
    // A real disabled <select>, not a lookalike chip: assistive tech and
    // keyboard users need to perceive this as a control that is switched off,
    // otherwise the rule reads as a missing feature.
    return (
      <div className="flex items-center gap-1.5">
        <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <select
          disabled
          aria-disabled="true"
          aria-label={`Location filter unavailable — ${disabledReason}`}
          title={`This report is ${disabledReason.toLowerCase()} and cannot be filtered by location.`}
          value="__disabled__"
          onChange={() => {}}
          className="h-8 rounded-md border border-dashed border-border bg-muted/20 px-2 text-xs text-muted-foreground disabled:opacity-70 disabled:cursor-not-allowed"
        >
          <option value="__disabled__">{disabledReason}</option>
        </select>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <select
        value={state.key}
        onChange={(e) => state.setKey(e.target.value)}
        disabled={loading}
        className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
      >
        <option value="">All locations</option>
        {options.map((o) => (
          <option key={`${o.type}:${o.id}`} value={`${o.type}:${o.id}`}>{o.name}</option>
        ))}
      </select>
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
export type CardTone = 'default' | 'pos' | 'neg' | 'warn' | 'accent' | 'info';
const TONE_CLS: Record<CardTone, string> = {
  default: '',
  pos: 'text-emerald-600',
  neg: 'text-red-500',
  warn: 'text-amber-600',
  accent: 'text-primary',
  info: 'text-blue-600',
};

export interface SummaryCard {
  label: string;
  value: ReactNode;
  tone?: CardTone;
  // `hint` is for a total made of parts the reader would otherwise have to
  // guess at — it breaks the figure down without competing with it.
  hint?: ReactNode;
  /** Extra classes on the card itself (e.g. col-span for custom grids). */
  className?: string;
  /** Makes the card a real button — used for drill-down navigation. */
  onClick?: () => void;
}

export function SummaryCards({
  cards,
  gridClassName,
}: {
  cards: SummaryCard[];
  /** Overrides the default responsive grid, e.g. for fixed row layouts. */
  gridClassName?: string;
}) {
  return (
    <div className={gridClassName ?? 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3'}>
      {cards.map((c) => {
        const body = (
          <>
            <p className="text-xs text-muted-foreground mb-1">{c.label}</p>
            <p className={`font-bold font-mono text-sm ${TONE_CLS[c.tone ?? 'default']}`}>{c.value}</p>
            {c.hint ? (
              <p className="text-[10px] text-muted-foreground/70 mt-1 leading-tight">{c.hint}</p>
            ) : null}
          </>
        );
        const base = `bg-card border border-border rounded-lg p-3 text-center ${c.className ?? ''}`;
        return c.onClick ? (
          <button
            key={c.label}
            type="button"
            onClick={c.onClick}
            className={`${base} cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            {body}
          </button>
        ) : (
          <div key={c.label} className={base}>
            {body}
          </div>
        );
      })}
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
  /** Raw value used for column sorting. Defaults to `row[key]`. */
  sortValue?: (row: T) => unknown;
  /** Set false for non-data columns (actions, serial numbers). Default true. */
  sortable?: boolean;
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
  const accessors = Object.fromEntries(
    cols.filter(c => c.sortable !== false)
      .map(c => [c.key, c.sortValue ?? ((r: T) => (r as Record<string, unknown>)[c.key])]),
  ) as Record<string, (row: T) => unknown>;
  const { sorted, sort } = useTableSort(rows, accessors);
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/10">
            {cols.map((c) => (
              c.sortable === false
                ? <TableHead key={c.key} className={`whitespace-nowrap ${alignCls(c)}`}>{c.label}</TableHead>
                : <SortableHead key={c.key} k={c.key} sort={sort} className={`whitespace-nowrap ${alignCls(c)}`}>{c.label}</SortableHead>
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
            sorted.map((r, i) => (
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

export interface ReportDoc {
  title: string;
  subtitle?: string;
  metaRows?: [string, string][];
  orientation?: 'portrait' | 'landscape';
  sections: PdfSection[];
  footerNote?: string;
  filename?: string;
}

const slug = (d: ReportDoc) =>
  (d.filename ?? d.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * POST to the server-side renderer. MUST be invoked synchronously from the
 * click handler — downloadPDFFromEndpoint opens the preview window immediately
 * so popup blockers don't eat it.
 */
export function exportReportPdf(opts: ReportDoc): Promise<void> {
  const { filename: _f, ...payload } = opts;
  return downloadPDFFromEndpoint('/api/pdf/report', { ...payload, intent: 'download' }, `${slug(opts)}.pdf`);
}

/** Same document, sent to the printer instead of the disk. Covered by the same
 *  Download right — it gates every output channel, printing included. */
export function printReportPdf(opts: ReportDoc): Promise<void> {
  const { filename: _f, ...payload } = opts;
  return printPDFFromEndpoint('/api/pdf/report', { ...payload, intent: 'print' });
}

/** Same document as a real .xlsx — numbers stay numbers so the recipient can
 *  sum a column. */
export function exportReportXlsx(opts: ReportDoc): Promise<void> {
  const { filename: _f, ...payload } = opts;
  return downloadFileFromEndpoint('/api/xlsx/report', payload, `${slug(opts)}.xlsx`);
}

// ── Export buttons ────────────────────────────────────────────────────────────
// `canDownload` is the caller's capability — the parent page owns its own
// permission key and passes the resolved flag here, so this shared toolbar
// never hardcodes a module name. One flag gates every button: Download covers
// all output channels (CSV, Excel, PDF and Print) under the five-action model.
//
// `doc` is the preferred API: give the toolbar the report document once and it
// renders CSV, Excel, PDF and Print off it. The older onPDF/onCSV callbacks are
// still honoured for callers that build their payload differently.
export function ExportButtons({ onCSV, onPDF, doc, disabled, canDownload = true }: {
  onCSV?: () => void;
  onPDF?: () => Promise<void> | void;
  doc?: () => ReportDoc;
  disabled?: boolean;
  canDownload?: boolean;
}) {
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | 'print' | null>(null);

  const run = (kind: 'pdf' | 'xlsx' | 'print', p: Promise<void> | void) => {
    if (!p || typeof (p as Promise<void>).then !== 'function') return;
    setBusy(kind);
    (p as Promise<void>)
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Export failed'))
      .finally(() => setBusy(null));
  };

  // Called synchronously so the popup window opens inside the click gesture.
  const handlePdf = () => run('pdf', onPDF ? onPDF() : doc ? exportReportPdf(doc()) : undefined);
  const handleXlsx = () => { if (doc) run('xlsx', exportReportXlsx(doc())); };
  const handlePrint = () => { if (doc) run('print', printReportPdf(doc())); };

  const showPdf = Boolean(onPDF || doc);
  if (!canDownload) return null;
  return (
    <div className="flex items-center gap-2 ml-auto">
      {canDownload && onCSV && (
        <Button variant="outline" size="sm" onClick={onCSV} disabled={disabled}>
          <Download className="w-4 h-4 mr-2" /> CSV
        </Button>
      )}
      {canDownload && doc && (
        <Button variant="outline" size="sm" onClick={handleXlsx} disabled={disabled || busy !== null}>
          {busy === 'xlsx' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sheet className="w-4 h-4 mr-2" />} Excel
        </Button>
      )}
      {canDownload && showPdf && (
        <Button variant="outline" size="sm" onClick={handlePdf} disabled={disabled || busy !== null}>
          {busy === 'pdf' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />} PDF
        </Button>
      )}
      {doc && (
        <Button variant="outline" size="sm" onClick={handlePrint} disabled={disabled || busy !== null}>
          {busy === 'print' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Printer className="w-4 h-4 mr-2" />} Print
        </Button>
      )}
    </div>
  );
}
