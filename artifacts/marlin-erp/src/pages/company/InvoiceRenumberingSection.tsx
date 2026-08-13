/**
 * Invoice Renumbering (super-admin only) — migrate ONE location's SB2B/SB2C
 * invoice numbers onto its old physical bill-book series.
 *
 * Flow: pick location + starting numbers → Preview (full old → new mapping,
 * nothing written) → confirm → Apply (one atomic server transaction that
 * renames every invoice and its receipts/quotations, then flips the
 * location's future numbering to the book format: SB2C/26-27/7490 — short
 * financial-year label, no leading zeros, and one running sequence that does
 * NOT restart every April).
 *
 * Amounts, dates, GST, stock and account books are untouched — only the
 * reference numbers change, everywhere at once. A location can be migrated
 * exactly once; the server refuses a second run.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Hash, Loader2, TriangleAlert, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

type Mapping = {
  saleId: number;
  saleDate: string;
  series: 'SB2B' | 'SB2C';
  party: string | null;
  totalAmount: number;
  oldNumber: string;
  newNumber: string;
  cancelled: boolean;
};

type Preview = {
  locationName: string;
  scope: string;
  total: number;
  perSeries: Record<string, { count: number; firstNew: string; lastNew: string; lastSerial: number }>;
  oddShaped: number;
  pairedReceipts: number;
  mappings: Mapping[];
};

type ApplyResult = {
  batchId: string;
  locationName: string;
  renumbered: number;
  receiptsRenamed: number;
  quotationsUpdated: number;
  perSeries: Record<string, { count: number; firstNew: string; lastNew: string }>;
};

const fmtDate = (d: string) => {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export default function InvoiceRenumberingSection() {
  const queryClient = useQueryClient();
  const { data: warehouses = [] } = useQuery<any[]>({
    queryKey: ['/api/warehouses'],
    queryFn: () => customFetch<any[]>('/api/warehouses'),
  });
  const { data: outlets = [] } = useQuery<any[]>({
    queryKey: ['/api/outlets'],
    queryFn: () => customFetch<any[]>('/api/outlets'),
  });

  const [locationKey, setLocationKey] = useState<string>('');
  const [b2cStart, setB2cStart] = useState<string>('7490');
  const [b2bStart, setB2bStart] = useState<string>('130');
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  /** Set when preview is refused because this location was already migrated. */
  const [locked, setLocked] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const locations = useMemo(() => {
    const list = (warehouses as any[]).map((w) => ({
      key: `warehouse:${w.id}`,
      label: `${w.name} (Warehouse)`,
      locationType: 'warehouse',
      locationId: Number(w.id),
    }));
    for (const o of outlets as any[]) {
      list.push({ key: `outlet:${o.id}`, label: `${o.name} (Outlet)`, locationType: 'outlet', locationId: Number(o.id) });
    }
    list.push({ key: 'headoffice:0', label: 'Head Office', locationType: 'headoffice', locationId: 0 });
    return list;
  }, [warehouses, outlets]);

  const selected = locations.find((l) => l.key === locationKey);

  const target = selected && {
    locationType: selected.locationType,
    locationId: selected.locationId,
    b2cStart: Number(b2cStart),
    b2bStart: Number(b2bStart),
  };

  const runPreview = async () => {
    if (!target) return;
    setPreviewing(true);
    setResult(null);
    setLocked(null);
    try {
      const p = await customFetch<Preview>('/api/admin/sales-renumber/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      setPreview(p);
    } catch (e: any) {
      // Already-migrated is not a toast-and-forget error: surface it inline
      // with the (super-admin) escape hatch to clear the migration lock.
      if (e?.data?.code === 'ALREADY_MIGRATED') {
        setLocked(String(e.data.error));
      } else {
        toast.error(e?.data?.error || e.message || 'Preview failed');
      }
    } finally {
      setPreviewing(false);
    }
  };

  const runReset = async () => {
    if (!selected) return;
    setResetting(true);
    try {
      const r = await customFetch<{ locationName: string }>('/api/admin/sales-renumber/reset-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationType: selected.locationType, locationId: selected.locationId, confirm: true }),
      });
      setLocked(null);
      setResetOpen(false);
      toast.success(`Migration lock cleared for ${r.locationName}. Run a new preview when you're ready — until the corrected migration is applied, new bills there use the standard long number format.`);
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Could not clear the migration lock');
    } finally {
      setResetting(false);
    }
  };

  const runApply = async () => {
    if (!target || !preview) return;
    setApplying(true);
    try {
      const r = await customFetch<ApplyResult>('/api/admin/sales-renumber/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, expectedTotal: preview.total }),
      });
      setResult(r);
      setPreview(null);
      setConfirmOpen(false);
      toast.success(`Renumbered ${r.renumbered} invoices at ${r.locationName}`);
      // Every list that shows invoice numbers is now stale.
      await queryClient.invalidateQueries();
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Renumbering failed — nothing was changed');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Hash className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h3 className="font-semibold">Invoice Number Migration</h3>
          <p className="text-xs text-muted-foreground">
            Renumber one location's sales bills onto its old bill-book series (e.g. SB2C/26-27/7490) and continue that series for future bills. Super administrators only — can be done once per location.
          </p>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Location</label>
            <Select value={locationKey} onValueChange={(v) => { setLocationKey(v); setLocked(null); }}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Choose location" /></SelectTrigger>
              <SelectContent>
                {locations.map((l) => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">First B2C (retail) number</label>
            <Input className="mt-1 font-mono" inputMode="numeric" value={b2cStart}
              onChange={(e) => setB2cStart(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">First B2B (GST customer) number</label>
            <Input className="mt-1 font-mono" inputMode="numeric" value={b2bStart}
              onChange={(e) => setB2bStart(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={runPreview}
            disabled={!selected || previewing || !Number(b2cStart) || !Number(b2bStart)}
          >
            {previewing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking…</> : 'Preview changes'}
          </Button>
          <p className="text-xs text-muted-foreground">Nothing changes until you review and confirm the full list.</p>
        </div>

        {locked && selected && (
          <div className="rounded-lg border border-amber-600/30 bg-amber-500/5 p-4 text-sm space-y-2">
            <p className="font-medium flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <TriangleAlert className="w-4 h-4 shrink-0" /> {locked}
            </p>
            <p className="text-xs text-muted-foreground">
              If the previous migration needs to be corrected, a super administrator can clear the migration
              lock for this location only. Nothing else changes — invoices, receipts, ledgers and the
              renumbering audit log all stay exactly as they are — and the location locks again automatically
              once the corrected migration is applied.
            </p>
            <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
              Clear migration lock for {selected.label}…
            </Button>
          </div>
        )}

        {result && (
          <div className="rounded-lg border border-green-600/30 bg-green-500/5 p-4 text-sm space-y-1">
            <p className="font-medium flex items-center gap-1.5 text-green-700 dark:text-green-400">
              <CheckCircle2 className="w-4 h-4" /> Done — {result.renumbered} invoices renumbered at {result.locationName}
            </p>
            {Object.entries(result.perSeries).map(([s, v]) => (
              <p key={s} className="text-muted-foreground font-mono text-xs">{s}: {v.firstNew} → {v.lastNew} ({v.count} bills)</p>
            ))}
            <p className="text-xs text-muted-foreground">
              {result.receiptsRenamed} payment receipts and {result.quotationsUpdated} quotation links were updated to match. New bills will continue this series automatically.
            </p>
          </div>
        )}
      </div>

      {/* ── Preview dialog: the full old → new mapping ─────────────────────── */}
      <Dialog open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Renumber {preview?.total} invoices at {preview?.locationName}?</DialogTitle>
            <DialogDescription>
              Every bill below gets its new number, oldest first. Receipts and quotation references are renamed with them. Amounts, dates, GST and stock are not touched.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(preview.perSeries).map(([s, v]) => (
                  <Badge key={s} variant="secondary" className="font-mono">{s}: {v.firstNew} → {v.lastNew} ({v.count})</Badge>
                ))}
                <Badge variant="outline">{preview.pairedReceipts} linked receipts</Badge>
                {preview.oddShaped > 0 && (
                  <Badge variant="destructive">{preview.oddShaped} bills have unreadable numbers — renumbering is blocked until they're fixed</Badge>
                )}
              </div>
              <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Customer</th>
                      <th className="px-3 py-2 font-medium">Old number</th>
                      <th className="px-3 py-2 font-medium">New number</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.mappings.map((m) => (
                      <tr key={m.saleId} className={m.cancelled ? 'opacity-50' : ''}>
                        <td className="px-3 py-1.5 whitespace-nowrap">{fmtDate(m.saleDate)}</td>
                        <td className="px-3 py-1.5 max-w-[160px] truncate">{m.party || 'Walk-in'}{m.cancelled ? ' (cancelled)' : ''}</td>
                        <td className="px-3 py-1.5 font-mono whitespace-nowrap">{m.oldNumber}</td>
                        <td className="px-3 py-1.5 font-mono whitespace-nowrap font-medium">{m.newNumber}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={!preview?.total}>
              Renumber {preview?.total} invoices…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Final confirmation ─────────────────────────────────────────────── */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="w-5 h-5 text-destructive" /> This can be done only once
            </AlertDialogTitle>
            <AlertDialogDescription>
              {preview?.total} invoices at {preview?.locationName} will be permanently renumbered onto the bill-book series, and all future bills at this location will continue it. The old numbers stay searchable, but this cannot be run again for this location unless a super administrator clears the migration lock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>Go back</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); void runApply(); }}
              disabled={applying}
            >
              {applying ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Renumbering…</> : 'Yes, renumber now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Clear-migration-lock confirmation ──────────────────────────────── */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="w-5 h-5 text-amber-600" /> Clear the migration lock?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This removes only the &ldquo;already migrated&rdquo; lock for{' '}
                  <span className="font-medium text-foreground">{selected?.label}</span> so a corrected
                  renumbering can be run. No invoice numbers, receipts, ledgers or reports change now, and the
                  previous renumbering&rsquo;s audit log is kept.
                </p>
                <p>
                  Until the corrected migration is applied, new bills at this location will print the standard
                  long number format — run the corrected migration soon after clearing. The one-time protection
                  returns automatically once it is applied.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Go back</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void runReset(); }}
              disabled={resetting}
            >
              {resetting ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Clearing…</> : 'Yes, clear the lock'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
