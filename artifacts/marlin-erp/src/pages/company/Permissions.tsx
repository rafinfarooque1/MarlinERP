import { useState, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Save, Loader2, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { useListHierarchies, useListPermissions, setPermission } from '@workspace/api-client-react';
import type { Hierarchy, Permission } from '@workspace/api-client-react';

// Two top-level segments: Sales and Accounts.
// Each segment has sub-groups; each group has individual module toggles.
const MODULE_SEGMENTS = [
  {
    segment: 'Sales',
    description: 'Point-of-sale operations at warehouses and outlets',
    groups: [
      {
        title: 'Sales Department',
        modules: ['Point of Sale', 'Location Stock', 'Location Transfers', 'Location Expenses'],
      },
    ],
  },
  {
    segment: 'Accounts',
    description: 'Back-office: production, inventory, finance, HR and company settings',
    groups: [
      {
        title: 'Production',
        modules: ['Materials', 'Raw Materials', 'Items', 'Purchases', 'Production', 'Stock Transfers'],
      },
      {
        title: 'Inventory',
        modules: ['Warehouses', 'Outlets', 'Stock', 'HO Transfers', 'Item Prices'],
      },
      {
        title: 'Sales (HO)',
        modules: ['Sales', 'Customers', 'Vendors', 'Coupons', 'Payments'],
      },
      {
        title: 'HR',
        modules: ['Hierarchy', 'Employees', 'Payroll', 'Attendance', 'Leave'],
      },
      {
        title: 'Accounts',
        modules: ['Chart of Accounts', 'Ledger', 'Cash & Bank', 'Expenses', 'GST Summary', 'Reconciliation', 'Cash Balance', 'Vouchers', 'Books'],
      },
      {
        title: 'Company',
        modules: ['Settings', 'Permissions', 'Profile'],
      },
    ],
  },
];

const ALL_MODULES = MODULE_SEGMENTS.flatMap(s => s.groups.flatMap(g => g.modules));

/** Default access based on hierarchy level: level 1 = top authority, higher = more restricted */
function defaultAccess(level: number, module: string): boolean {
  if (level === 1) return true; // Top level: full access

  // Sales segment modules
  const salesSegmentModules = ['Point of Sale', 'Location Stock', 'Location Transfers', 'Location Expenses'];
  const productionModules = ['Materials', 'Raw Materials', 'Items', 'Purchases', 'Production', 'Stock Transfers'];
  const inventoryModules = ['Warehouses', 'Outlets', 'Stock', 'HO Transfers', 'Item Prices'];
  const salesModules = ['Sales', 'Customers', 'Vendors', 'Coupons'];

  if (level === 2) {
    // Manager: everything except company settings & permissions
    return !['Settings', 'Permissions'].includes(module);
  }
  if (level === 3) {
    // Supervisor: sales segment + production + inventory + profile
    return [...salesSegmentModules, ...productionModules, ...inventoryModules, 'Profile'].includes(module);
  }
  if (level === 4) {
    // Staff: sales segment + basic production/inventory
    return [...salesSegmentModules, ...productionModules, 'Stock', 'HO Transfers'].includes(module);
  }
  // Level 5+: limited access
  return ['Point of Sale', 'Profile', 'Production', 'Stock', 'Sales', 'Attendance', 'Leave'].includes(module);
}

/** Build a local perm map from DB records + fill gaps with defaults */
function buildPermMap(
  hierarchies: Hierarchy[],
  dbPerms: Permission[],
): Record<number, Record<string, boolean>> {
  const map: Record<number, Record<string, boolean>> = {};
  for (const h of hierarchies) {
    map[h.id] = {};
    for (const mod of ALL_MODULES) {
      const dbRow = dbPerms.find(p => p.hierarchyId === h.id && p.module === mod);
      if (dbRow) {
        map[h.id][mod] = !!(dbRow.canView || dbRow.canAdd || dbRow.canEdit);
      } else {
        map[h.id][mod] = defaultAccess(h.level ?? 99, mod);
      }
    }
  }
  return map;
}

export default function Permissions() {
  const { data: hierarchies = [], isLoading: loadingH } = useListHierarchies();
  const { data: dbPerms = [], isLoading: loadingP, refetch } = useListPermissions();

  // Sort hierarchies by level ascending (level 1 = highest authority first)
  const sortedHierarchies = useMemo(
    () => [...hierarchies].sort((a, b) => (a.level ?? 99) - (b.level ?? 99)),
    [hierarchies],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = selectedId ?? sortedHierarchies[0]?.id ?? null;

  const [perms, setPerms] = useState<Record<number, Record<string, boolean>>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Initialise local state once data loads
  useMemo(() => {
    if (sortedHierarchies.length > 0 && dbPerms.length >= 0 && Object.keys(perms).length === 0) {
      setPerms(buildPermMap(sortedHierarchies, dbPerms));
    }
  }, [sortedHierarchies, dbPerms]);

  const selectedHierarchy = sortedHierarchies.find(h => h.id === effectiveId);
  const isTopLevel = (selectedHierarchy?.level ?? 99) === 1;

  const rolePerms = effectiveId ? (perms[effectiveId] ?? {}) : {};
  const enabledCount = Object.values(rolePerms).filter(Boolean).length;
  const totalCount = ALL_MODULES.length;

  const toggle = (module: string) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: { ...prev[effectiveId], [module]: !prev[effectiveId]?.[module] },
    }));
    setDirty(true);
  };

  const setAll = (value: boolean) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: Object.fromEntries(ALL_MODULES.map(m => [m, value])),
    }));
    setDirty(true);
  };

  /** Toggle all modules in a segment (Sales / Accounts) */
  const toggleSegment = (modules: string[], value: boolean) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: { ...prev[effectiveId], ...Object.fromEntries(modules.map(m => [m, value])) },
    }));
    setDirty(true);
  };

  /** Toggle all modules in a group */
  const toggleGroup = (modules: string[], value: boolean) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: { ...prev[effectiveId], ...Object.fromEntries(modules.map(m => [m, value])) },
    }));
    setDirty(true);
  };

  const save = async () => {
    if (!effectiveId) return;
    setSaving(true);
    try {
      await Promise.all(
        ALL_MODULES.map(mod =>
          setPermission({
            hierarchyId: effectiveId,
            module: mod,
            canView: !!rolePerms[mod],
            canAdd: !!rolePerms[mod],
            canEdit: !!rolePerms[mod],
            canDelete: !!rolePerms[mod],
            canDownload: !!rolePerms[mod],
          }),
        ),
      );
      await refetch();
      setDirty(false);
      toast.success('Permissions saved');
    } catch {
      toast.error('Failed to save permissions');
    } finally {
      setSaving(false);
    }
  };

  const isLoading = loadingH || loadingP;

  return (
    <AppLayout>
      <div className="space-y-6 max-w-4xl">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-primary" /> Permissions
            </h1>
            <p className="text-muted-foreground mt-1">Module access control by hierarchy level</p>
          </div>
          <Button size="sm" onClick={save} disabled={saving || !dirty || isTopLevel}>
            {saving
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</>
              : <><Save className="w-4 h-4 mr-2" /> Save</>}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : sortedHierarchies.length === 0 ? (
          <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
            No hierarchy levels found. Add roles in <strong>HR → Hierarchy</strong> first.
          </div>
        ) : (
          <>
            {/* Hierarchy Tabs — ordered by level (most senior first) */}
            <div className="flex flex-wrap gap-2">
              {sortedHierarchies.map(h => (
                <button
                  key={h.id}
                  onClick={() => { setSelectedId(h.id); setDirty(false); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                    effectiveId === h.id
                      ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                      : 'bg-card border-border text-muted-foreground hover:text-foreground hover:border-primary/30'
                  }`}
                >
                  {(h.level ?? 99) === 1 && <ChevronUp className="w-3 h-3" />}
                  {h.name}
                  <span className="opacity-60 text-xs">L{h.level}</span>
                </button>
              ))}
            </div>

            {/* Info row */}
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{selectedHierarchy?.name}</span>
                {' '}has access to{' '}
                <span className="font-bold text-foreground">{enabledCount}</span> of {totalCount} modules
                {isTopLevel && (
                  <span className="ml-2 text-primary text-xs">(Top level — always full access)</span>
                )}
              </span>
              {!isTopLevel && (
                <div className="flex gap-2">
                  <button onClick={() => setAll(true)} className="text-xs text-primary hover:underline">Enable all</button>
                  <span className="text-muted-foreground">·</span>
                  <button onClick={() => setAll(false)} className="text-xs text-muted-foreground hover:text-foreground hover:underline">Disable all</button>
                </div>
              )}
            </div>

            {/* Module grid — two top-level segments: Sales and Accounts */}
            <div className="space-y-6">
              {MODULE_SEGMENTS.map(seg => {
                const segModules = seg.groups.flatMap(g => g.modules);
                const segEnabled = segModules.filter(m => rolePerms[m]).length;
                const segAllOn  = segEnabled === segModules.length;
                const segAllOff = segEnabled === 0;
                return (
                  <div key={seg.segment}>
                    {/* Segment header — with master toggle */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex items-center gap-2.5">
                        <span className="text-base font-bold text-foreground">{seg.segment}</span>
                        <Badge variant="secondary" className="text-xs font-semibold">
                          {segEnabled} / {segModules.length}
                        </Badge>
                      </div>
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground hidden sm:block mr-2">{seg.description}</span>
                      {/* Master segment switch */}
                      {!isTopLevel && (
                        <Switch
                          checked={segAllOn}
                          onCheckedChange={v => toggleSegment(segModules, v)}
                          className="data-[state=checked]:bg-primary"
                          title={segAllOn ? `Disable all ${seg.segment} modules` : `Enable all ${seg.segment} modules`}
                        />
                      )}
                    </div>

                    {/* Groups under this segment */}
                    <div className="space-y-3 pl-0">
                      {seg.groups.map(group => {
                        const grpEnabled = group.modules.filter(m => rolePerms[m]).length;
                        const grpAllOn   = grpEnabled === group.modules.length;
                        return (
                          <div key={group.title} className="bg-card border border-border rounded-xl overflow-hidden">
                            <div className="p-3 border-b border-border bg-muted/20 flex items-center justify-between">
                              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                                {group.title}
                              </h3>
                              <div className="flex items-center gap-3">
                                <Badge variant="outline" className="text-xs">
                                  {grpEnabled} / {group.modules.length}
                                </Badge>
                                {/* Group-level master toggle */}
                                {!isTopLevel && (
                                  <Switch
                                    checked={grpAllOn}
                                    onCheckedChange={v => toggleGroup(group.modules, v)}
                                    title={grpAllOn ? `Disable all ${group.title}` : `Enable all ${group.title}`}
                                  />
                                )}
                              </div>
                            </div>
                            <div className="divide-y divide-border/50">
                              {group.modules.map(mod => (
                                <div key={mod} className="flex items-center justify-between px-4 py-3 hover:bg-muted/5">
                                  <span className={`text-sm ${rolePerms[mod] ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                                    {mod}
                                  </span>
                                  <Switch
                                    checked={!!rolePerms[mod]}
                                    onCheckedChange={() =>
                                      isTopLevel
                                        ? toast.info('Top-level authority always has full access')
                                        : toggle(mod)
                                    }
                                    disabled={isTopLevel}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
