import { useState, useMemo, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Save, Loader2, ChevronUp, Eye, Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useListHierarchies, useListPermissions, setPermission } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import type { Hierarchy, Permission } from '@workspace/api-client-react';

// Two top-level segments: Sales and Accounts.
// Each segment has sub-groups; each group has individual module rows with
// granular View / Add / Edit / Delete toggles.
const MODULE_SEGMENTS = [
  {
    segment: 'Sales',
    description: 'Point-of-sale operations at warehouses and outlets',
    groups: [
      {
        title: 'Sales Department',
        modules: ['Sales Dashboard', 'Point of Sale', 'Location Stock', 'Location Transfers', 'Location Expenses', 'Cash Balance'],
      },
    ],
  },
  {
    segment: 'Accounts',
    description: 'Back-office: production, inventory, finance, HR and company settings',
    groups: [
      {
        title: 'Production',
        modules: ['Units', 'Items', 'Purchases', 'Production', 'Stock Transfers'],
      },
      {
        title: 'Inventory',
        modules: ['Warehouses', 'Outlets', 'Stock', 'Inventory Reports', 'Stock Verification', 'HO Transfers', 'Item Prices'],
      },
      {
        title: 'Sales (HO)',
        modules: ['Sales', 'Customers', 'Vendors', 'Coupons'],
      },
      {
        title: 'HR',
        modules: ['Hierarchy', 'Employees', 'Payroll', 'Attendance', 'Leave'],
      },
      {
        title: 'Accounts',
        modules: ['Chart of Accounts', 'Ledger', 'Payments', 'Expenses', 'GST Summary', 'GST Returns', 'Reconciliation', 'Cash Balance', 'Vouchers', 'Books', 'Reports'],
      },
      {
        title: 'Dashboard',
        modules: ['Dashboard'],
      },
      {
        title: 'Company',
        modules: ['Settings', 'Permissions', 'Login History'],
      },
    ],
  },
];

const ALL_MODULES = MODULE_SEGMENTS.flatMap(s => s.groups.flatMap(g => g.modules));

type ActionKey = 'view' | 'add' | 'edit' | 'del';
type ModulePerm = Record<ActionKey, boolean>;
type PermMap = Record<number, Record<string, ModulePerm>>;

const ACTIONS: { key: ActionKey; label: string; icon: React.ElementType }[] = [
  { key: 'view', label: 'View',   icon: Eye },
  { key: 'add',  label: 'Add',    icon: Plus },
  { key: 'edit', label: 'Edit',   icon: Pencil },
  { key: 'del',  label: 'Delete', icon: Trash2 },
];

/** Default access based on hierarchy level: level 1 = top authority, higher = more restricted */
function defaultAccess(level: number, module: string): boolean {
  if (level === 1) return true; // Top level: full access

  // Sales segment modules
  const salesSegmentModules = ['Sales Dashboard', 'Point of Sale', 'Location Stock', 'Location Transfers', 'Location Expenses', 'Cash Balance'];
  const productionModules = ['Units', 'Items', 'Purchases', 'Production', 'Stock Transfers'];
  const inventoryModules = ['Warehouses', 'Outlets', 'Stock', 'HO Transfers', 'Item Prices'];

  if (level === 2) {
    // Manager: everything except company settings & permissions
    return !['Settings', 'Permissions', 'Login History'].includes(module);
  }
  if (level === 3) {
    // Supervisor: sales segment + production + inventory + profile + dashboard
    return [...salesSegmentModules, ...productionModules, ...inventoryModules, 'Dashboard', 'Profile'].includes(module);
  }
  if (level === 4) {
    // Staff: sales segment + basic production/inventory + dashboard
    return [...salesSegmentModules, ...productionModules, 'Dashboard', 'Stock', 'HO Transfers'].includes(module);
  }
  // Level 5+: limited access
  return ['Point of Sale', 'Profile', 'Production', 'Stock', 'Sales', 'Attendance', 'Leave', 'Dashboard'].includes(module);
}

/** Build a local perm map from DB records + fill gaps with level-based defaults */
function buildPermMap(hierarchies: Hierarchy[], dbPerms: Permission[]): PermMap {
  const map: PermMap = {};
  for (const h of hierarchies) {
    map[h.id] = {};
    for (const mod of ALL_MODULES) {
      const dbRow = dbPerms.find(p => p.hierarchyId === h.id && p.module === mod);
      if (dbRow) {
        map[h.id][mod] = {
          view: dbRow.canView ?? true,
          add:  dbRow.canAdd ?? false,
          edit: dbRow.canEdit ?? false,
          del:  dbRow.canDelete ?? false,
        };
      } else {
        const allowed = defaultAccess(h.level ?? 99, mod);
        map[h.id][mod] = { view: allowed, add: allowed, edit: allowed, del: allowed };
      }
    }
  }
  return map;
}

const allOn  = (p?: ModulePerm) => !!p && p.view && p.add && p.edit && p.del;
const setAllActions = (value: boolean): ModulePerm => ({ view: value, add: value, edit: value, del: value });

export default function Permissions() {
  const selfPerm = usePermission('Permissions');
  const { data: hierarchies = [], isLoading: loadingH } = useListHierarchies();
  const { data: dbPerms = [], isLoading: loadingP, refetch } = useListPermissions();

  // Sort hierarchies by level ascending (level 1 = highest authority first)
  const sortedHierarchies = useMemo(
    () => [...hierarchies].sort((a, b) => (a.level ?? 99) - (b.level ?? 99)),
    [hierarchies],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = selectedId ?? sortedHierarchies[0]?.id ?? null;

  const [perms, setPerms] = useState<PermMap>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync local state from the server whenever fresh data arrives, unless the
  // user has unsaved edits. Waits for BOTH queries so DB rows are never
  // missed when hierarchies resolve before permissions.
  useEffect(() => {
    if (loadingH || loadingP || dirty) return;
    if (sortedHierarchies.length === 0) return;
    setPerms(buildPermMap(sortedHierarchies, dbPerms));
  }, [loadingH, loadingP, dirty, sortedHierarchies, dbPerms]);

  const selectedHierarchy = sortedHierarchies.find(h => h.id === effectiveId);
  const isTopLevel = (selectedHierarchy?.level ?? 99) === 1;

  const rolePerms: Record<string, ModulePerm> = effectiveId ? (perms[effectiveId] ?? {}) : {};
  const enabledCount = ALL_MODULES.filter(m => rolePerms[m]?.view).length;
  const totalCount = ALL_MODULES.length;

  const updateModule = (module: string, next: ModulePerm) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: { ...prev[effectiveId], [module]: next },
    }));
    setDirty(true);
  };

  const toggleAction = (module: string, action: ActionKey) => {
    const cur = rolePerms[module] ?? { view: true, add: false, edit: false, del: false };
    const next = { ...cur, [action]: !cur[action] };
    // Consistency: writes imply view; removing view removes writes.
    if (action === 'view' && !next.view) {
      next.add = false; next.edit = false; next.del = false;
    } else if (action !== 'view' && next[action]) {
      next.view = true;
    }
    updateModule(module, next);
  };

  const setAll = (value: boolean) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: Object.fromEntries(ALL_MODULES.map(m => [m, setAllActions(value)])),
    }));
    setDirty(true);
  };

  /** Toggle all modules in a segment or group */
  const toggleModules = (modules: string[], value: boolean) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: {
        ...prev[effectiveId],
        ...Object.fromEntries(modules.map(m => [m, setAllActions(value)])),
      },
    }));
    setDirty(true);
  };

  const save = async () => {
    if (!effectiveId) return;
    setSaving(true);
    try {
      await Promise.all(
        ALL_MODULES.map(mod => {
          const p = rolePerms[mod] ?? { view: true, add: false, edit: false, del: false };
          return setPermission({
            hierarchyId: effectiveId,
            module: mod,
            canView: p.view,
            canAdd: p.add,
            canEdit: p.edit,
            canDelete: p.del,
            canDownload: p.view,
          });
        }),
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

  if (!selfPerm.isLoading && !selfPerm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">You don't have permission to view this page.<br />Contact your administrator to request access.</p>
          </div>
        </div>
      </AppLayout>
    );
  }
  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-primary" /> Permissions
            </h1>
            <p className="text-muted-foreground mt-1">
              Granular access control — decide who can view, add, edit, or delete in each module
            </p>
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
                {' '}can view{' '}
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
                const segAllOn = segModules.every(m => allOn(rolePerms[m]));
                return (
                  <div key={seg.segment}>
                    {/* Segment header — with master toggle */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex items-center gap-2.5">
                        <span className="text-base font-bold text-foreground">{seg.segment}</span>
                        <Badge variant="secondary" className="text-xs font-semibold">
                          {segModules.filter(m => rolePerms[m]?.view).length} / {segModules.length}
                        </Badge>
                      </div>
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground hidden sm:block mr-2">{seg.description}</span>
                      {/* Master segment switch — grants/revokes everything in the segment */}
                      {!isTopLevel && (
                        <Switch
                          checked={segAllOn}
                          onCheckedChange={v => toggleModules(segModules, v)}
                          className="data-[state=checked]:bg-primary"
                          title={segAllOn ? `Revoke all ${seg.segment} access` : `Grant full ${seg.segment} access`}
                        />
                      )}
                    </div>

                    {/* Groups under this segment */}
                    <div className="space-y-3 pl-0">
                      {seg.groups.map(group => {
                        const grpAllOn = group.modules.every(m => allOn(rolePerms[m]));
                        return (
                          <div key={group.title} className="bg-card border border-border rounded-xl overflow-hidden">
                            <div className="p-3 border-b border-border bg-muted/20 flex items-center justify-between gap-3">
                              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                                {group.title}
                              </h3>
                              <div className="flex items-center gap-3">
                                <Badge variant="outline" className="text-xs">
                                  {group.modules.filter(m => rolePerms[m]?.view).length} / {group.modules.length}
                                </Badge>
                                {/* Group-level master toggle */}
                                {!isTopLevel && (
                                  <Switch
                                    checked={grpAllOn}
                                    onCheckedChange={v => toggleModules(group.modules, v)}
                                    title={grpAllOn ? `Revoke all ${group.title}` : `Grant full ${group.title}`}
                                  />
                                )}
                              </div>
                            </div>

                            {/* Column headers */}
                            <div className="grid grid-cols-[1fr_repeat(4,3.25rem)] sm:grid-cols-[1fr_repeat(4,4rem)] items-center px-4 py-2 border-b border-border/50 bg-muted/5">
                              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Module</span>
                              {ACTIONS.map(a => (
                                <span key={a.key} className="text-[11px] uppercase tracking-wider text-muted-foreground text-center flex items-center justify-center gap-1">
                                  <a.icon className="w-3 h-3" />
                                  <span className="hidden sm:inline">{a.label}</span>
                                </span>
                              ))}
                            </div>

                            <div className="divide-y divide-border/50">
                              {group.modules.map(mod => {
                                const p = rolePerms[mod] ?? { view: false, add: false, edit: false, del: false };
                                return (
                                  <div key={mod} className="grid grid-cols-[1fr_repeat(4,3.25rem)] sm:grid-cols-[1fr_repeat(4,4rem)] items-center px-4 py-2.5 hover:bg-muted/5">
                                    <span className={`text-sm truncate pr-2 ${p.view ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                                      {mod}
                                    </span>
                                    {ACTIONS.map(a => (
                                      <div key={a.key} className="flex justify-center">
                                        <Checkbox
                                          checked={isTopLevel ? true : p[a.key]}
                                          disabled={isTopLevel}
                                          onCheckedChange={() =>
                                            isTopLevel
                                              ? toast.info('Top-level authority always has full access')
                                              : toggleAction(mod, a.key)
                                          }
                                          aria-label={`${a.label} ${mod}`}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-muted-foreground">
              View controls what appears in the sidebar and on pages. Add, Edit, and Delete are enforced by the
              server on every action — unchecking them blocks the operation even via the API.
            </p>
          </>
        )}
      </div>
    </AppLayout>
  );
}
