/**
 * Mapping step of the ERP Migration Wizard.
 *
 * Every old-ERP name found in the file (customer, vendor, ledger, item) must
 * be linked to an existing record here or created as a new one — nothing is
 * guessed. Decisions are remembered permanently (Manage Mappings), so the
 * next file with the same names sails straight through.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  useImportBatchMappings, useSaveImportMappings,
  useImportMigrationMappings, useSaveMigrationMappings,
  type ImportMappingInput, type ImportMappingKind, type ImportUnmappedName,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Link2, Loader2, Plus, Sparkles } from 'lucide-react';

const KIND_LABEL: Record<ImportMappingKind, string> = {
  customer: 'Customers', vendor: 'Vendors', ledger: 'Ledgers', product: 'Items',
};
const KIND_ONE: Record<ImportMappingKind, string> = {
  customer: 'customer', vendor: 'vendor', ledger: 'ledger', product: 'item',
};

interface Decision {
  /** 'ledger' (route to a ledger as a journal entry) and 'skip' apply only to
   *  routable receipt/payment names — non-party accounts in old-software files. */
  mode: 'existing' | 'create' | 'ledger' | 'skip';
  /** "id|targetKind" of the chosen existing record. */
  target: string;
  /** mode 'ledger': id of the ledger the rows post to as journal entries. */
  routeLedgerId: string;
  create: {
    gstNumber: string; phone: string;
    unit: string; hsnCode: string; taxRate: string; mrp: string; cost: string;
    parentId: string;
  };
}

const emptyCreate = () => ({ gstNumber: '', phone: '', unit: '', hsnCode: '', taxRate: '', mrp: '', cost: '', parentId: '' });
const keyOf = (u: { kind: string; name: string }) => `${u.kind}|${u.name.toLowerCase()}`;

export function MappingStep({ batchId = null, migrationId = null, canEdit }: {
  /** Per-batch flow (legacy standalone wizard batches). */
  batchId?: number | null;
  /** Migration flow — the same step over ALL of a migration's files. */
  migrationId?: number | null;
  canEdit: boolean;
}) {
  const batchQ = useImportBatchMappings(migrationId == null ? batchId : null);
  const migQ = useImportMigrationMappings(migrationId);
  const data = migrationId != null ? migQ.data : batchQ.data;
  const isLoading = migrationId != null ? migQ.isLoading : batchQ.isLoading;
  const saveBatchMappings = useSaveImportMappings();
  const saveMigMappings = useSaveMigrationMappings();
  const isSaving = saveBatchMappings.isPending || saveMigMappings.isPending;
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});

  // Prefill exact-name suggestions once the unmapped list arrives.
  useEffect(() => {
    if (!data) return;
    setDecisions((prev) => {
      const next = { ...prev };
      for (const u of data.unmapped) {
        const k = keyOf(u);
        if (next[k]) continue;
        if (u.suggestion) {
          next[k] = { mode: 'existing', target: `${u.suggestion.targetId}|${u.suggestion.targetKind ?? ''}`, routeLedgerId: '', create: emptyCreate() };
        }
      }
      return next;
    });
  }, [data]);

  const grouped = useMemo(() => {
    const g = new Map<ImportMappingKind, ImportUnmappedName[]>();
    for (const u of data?.unmapped ?? []) {
      const list = g.get(u.kind) ?? [];
      list.push(u);
      g.set(u.kind, list);
    }
    return g;
  }, [data]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin inline" />
        </CardContent>
      </Card>
    );
  }
  if (!data || data.unmapped.length === 0) return null;

  const decision = (u: ImportUnmappedName): Decision =>
    decisions[keyOf(u)] ?? { mode: 'existing', target: '', routeLedgerId: '', create: emptyCreate() };
  const setDecision = (u: ImportUnmappedName, d: Decision) =>
    setDecisions((prev) => ({ ...prev, [keyOf(u)]: d }));
  const setCreateField = (u: ImportUnmappedName, field: keyof Decision['create'], value: string) => {
    const d = decision(u);
    setDecision(u, { ...d, mode: 'create', create: { ...d.create, [field]: value } });
  };

  const decidedCount = data.unmapped.filter((u) => {
    const d = decisions[keyOf(u)];
    if (!d) return false;
    if (d.mode === 'existing') return d.target !== '';
    if (d.mode === 'ledger') return d.routeLedgerId !== '';
    if (d.mode === 'skip') return true;
    if (u.kind === 'product') return d.create.unit.trim() !== '';
    if (u.kind === 'ledger') return d.create.parentId !== '';
    return true;
  }).length;

  const handleSave = async () => {
    const mappings: ImportMappingInput[] = [];
    for (const u of data.unmapped) {
      const d = decisions[keyOf(u)];
      if (!d) continue;
      if (d.mode === 'skip') {
        mappings.push({ kind: u.kind, name: u.name, targetKind: 'skip' });
      } else if (d.mode === 'ledger') {
        if (!d.routeLedgerId) continue;
        mappings.push({ kind: u.kind, name: u.name, targetId: Number(d.routeLedgerId), targetKind: 'ledger' });
      } else if (d.mode === 'existing') {
        if (!d.target) continue;
        const [idStr, tk] = d.target.split('|');
        mappings.push({ kind: u.kind, name: u.name, targetId: Number(idStr), targetKind: tk || null });
      } else {
        const c = d.create;
        if (u.kind === 'product') {
          if (!c.unit.trim()) continue;
          mappings.push({
            kind: u.kind, name: u.name,
            create: {
              unit: c.unit.trim(), hsnCode: c.hsnCode.trim() || undefined,
              taxRate: c.taxRate === '' ? undefined : Number(c.taxRate),
              mrp: c.mrp === '' ? undefined : Number(c.mrp),
              cost: c.cost === '' ? undefined : Number(c.cost),
            },
          });
        } else if (u.kind === 'ledger') {
          if (!c.parentId) continue;
          mappings.push({ kind: u.kind, name: u.name, create: { parentId: Number(c.parentId) } });
        } else {
          mappings.push({
            kind: u.kind, name: u.name,
            create: { gstNumber: c.gstNumber.trim() || undefined, phone: c.phone.trim() || undefined },
          });
        }
      }
    }
    if (mappings.length === 0) {
      toast.info('Pick an existing record or fill the create form for at least one name first.');
      return;
    }
    try {
      const r = migrationId != null
        ? await saveMigMappings.mutateAsync({ id: migrationId, mappings })
        : await saveBatchMappings.mutateAsync({ id: batchId!, mappings });
      if (r.errors.length > 0) {
        toast.warning(`${r.saved.length + r.created.length} saved, ${r.errors.length} failed: ${r.errors.map((e) => `${e.name} — ${e.reason}`).join('; ')}`);
      } else {
        const parts = [
          r.saved.length > 0 ? `${r.saved.length} linked to existing records` : '',
          r.created.length > 0 ? `${r.created.length} created new` : '',
        ].filter(Boolean).join(', ');
        toast.success(`Mappings saved — ${parts}. The file has been re-checked.`);
      }
      setDecisions({});
    } catch (e: any) {
      toast.error(e?.message ?? 'The mappings could not be saved.');
    }
  };

  return (
    <Card className="border-blue-200">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Link2 className="w-4 h-4 text-blue-600" />
          Map old-ERP names ({data.unmapped.length} to decide)
        </CardTitle>
        <CardDescription>
          For every name from your old ERP, pick the matching record here or create a new one.
          Your choices are remembered forever — the next file with the same names needs no mapping.
          Nothing is guessed automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {[...grouped.entries()].map(([kind, list]) => (
          <div key={kind} className="space-y-2">
            <div className="text-sm font-semibold">{KIND_LABEL[kind]} <span className="text-muted-foreground font-normal">({list.length})</span></div>
            <div className="space-y-2 max-h-[26rem] overflow-y-auto pr-1">
              {list.map((u) => {
                const d = decision(u);
                const candidates = data.candidates[kind] ?? [];
                return (
                  <div key={keyOf(u)} className="rounded-md border p-2.5 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{u.name}</span>
                      <span className="text-xs text-muted-foreground">{u.rows} row{u.rows === 1 ? '' : 's'}</span>
                      {u.suggestion && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0 text-blue-700 border-blue-300">
                          <Sparkles className="w-3 h-3 mr-0.5" />exact match found
                        </Badge>
                      )}
                      <div className="ml-auto flex flex-wrap gap-1">
                        <Button size="sm" variant={d.mode === 'existing' ? 'default' : 'outline'} className="h-7 text-xs"
                          onClick={() => setDecision(u, { ...d, mode: 'existing' })}>
                          Use existing
                        </Button>
                        <Button size="sm" variant={d.mode === 'create' ? 'default' : 'outline'} className="h-7 text-xs"
                          onClick={() => setDecision(u, { ...d, mode: 'create' })}>
                          <Plus className="w-3 h-3 mr-0.5" />Create new
                        </Button>
                        {u.routable && (
                          <>
                            <Button size="sm" variant={d.mode === 'ledger' ? 'default' : 'outline'} className="h-7 text-xs"
                              onClick={() => setDecision(u, { ...d, mode: 'ledger' })}>
                              To ledger
                            </Button>
                            <Button size="sm" variant={d.mode === 'skip' ? 'destructive' : 'outline'} className="h-7 text-xs"
                              onClick={() => setDecision(u, { ...d, mode: 'skip' })}>
                              Skip
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {d.mode === 'skip' ? (
                      <p className="text-xs text-muted-foreground">
                        Rows with this name will <span className="font-medium text-destructive">not be imported</span> —
                        they stay listed in the skip report so nothing disappears silently.
                      </p>
                    ) : d.mode === 'ledger' ? (
                      <div className="space-y-1">
                        <Select value={d.routeLedgerId} onValueChange={(v) => setDecision(u, { ...d, routeLedgerId: v })}>
                          <SelectTrigger className="h-8 w-full sm:w-96 text-xs">
                            <SelectValue placeholder="Ledger to post these rows to (journal entry)…" />
                          </SelectTrigger>
                          <SelectContent>
                            {(data.routeLedgers ?? []).map((l) => (
                              <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          Not a real {KIND_ONE[kind]}? Each row becomes a journal voucher between the money account and this ledger.
                        </p>
                      </div>
                    ) : d.mode === 'existing' ? (
                      <Select value={d.target} onValueChange={(v) => setDecision(u, { ...d, target: v })}>
                        <SelectTrigger className="h-8 w-full sm:w-96 text-xs">
                          <SelectValue placeholder={`Choose the matching ${KIND_ONE[kind]}…`} />
                        </SelectTrigger>
                        <SelectContent>
                          {candidates.length === 0 && (
                            <div className="px-2 py-1.5 text-xs text-muted-foreground">No {KIND_LABEL[kind].toLowerCase()} exist yet — use Create new.</div>
                          )}
                          {candidates.map((c) => (
                            <SelectItem key={`${c.id}|${c.targetKind ?? ''}`} value={`${c.id}|${c.targetKind ?? ''}`}>
                              {c.name}{c.targetKind && c.targetKind !== 'item' ? ` (${c.targetKind.replace('_', ' ')})` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : kind === 'product' ? (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        <Input className="h-8 text-xs" placeholder="Unit * (kg, pcs…)" value={d.create.unit}
                          onChange={(e) => setCreateField(u, 'unit', e.target.value)} />
                        <Input className="h-8 text-xs" type="number" placeholder="GST %" value={d.create.taxRate}
                          onChange={(e) => setCreateField(u, 'taxRate', e.target.value)} />
                        <Input className="h-8 text-xs" type="number" placeholder="MRP ₹" value={d.create.mrp}
                          onChange={(e) => setCreateField(u, 'mrp', e.target.value)} />
                        <Input className="h-8 text-xs" type="number" placeholder="Cost ₹" value={d.create.cost}
                          onChange={(e) => setCreateField(u, 'cost', e.target.value)} />
                        <Input className="h-8 text-xs" placeholder="HSN code" value={d.create.hsnCode}
                          onChange={(e) => setCreateField(u, 'hsnCode', e.target.value)} />
                      </div>
                    ) : kind === 'ledger' ? (
                      <Select value={d.create.parentId} onValueChange={(v) => setCreateField(u, 'parentId', v)}>
                        <SelectTrigger className="h-8 w-full sm:w-96 text-xs">
                          <SelectValue placeholder="Ledger group for the new ledger * …" />
                        </SelectTrigger>
                        <SelectContent>
                          {data.ledgerGroups.map((g) => (
                            <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="grid grid-cols-2 gap-2 sm:w-96">
                        <Input className="h-8 text-xs" placeholder="GSTIN (optional)" value={d.create.gstNumber}
                          onChange={(e) => setCreateField(u, 'gstNumber', e.target.value)} />
                        <Input className="h-8 text-xs" placeholder="Phone (optional)" value={d.create.phone}
                          onChange={(e) => setCreateField(u, 'phone', e.target.value)} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{decidedCount} of {data.unmapped.length} decided.</p>
          <Button onClick={handleSave} disabled={!canEdit || isSaving || decidedCount === 0}>
            {isSaving
              ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              : <Link2 className="w-4 h-4 mr-1.5" />}
            Save mappings &amp; re-check
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
