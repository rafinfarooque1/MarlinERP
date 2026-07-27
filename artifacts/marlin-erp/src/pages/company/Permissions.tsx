import { useState, useMemo, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { ShieldCheck, ShieldOff, Save, Loader2, ChevronUp, Eye, Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useListHierarchies, useListPermissions, setPermission } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { getPermNavSections, ALL_MODULE_KEYS } from '@/lib/moduleRegistry';
import type { Hierarchy, Permission } from '@workspace/api-client-react';

// ── Sidebar-driven permission structure ────────────────────────────────────────
// Sections mirror the sidebar exactly — same names, same order, same items.
// To add or rename a module, edit moduleRegistry.ts only.
const PERM_SECTIONS = getPermNavSections();

// All unique module keys that appear in the sidebar nav (used for counts)
const NAV_MODULE_KEYS = [...new Set(PERM_SECTIONS.flatMap(s => s.rows.map(r => r.moduleKey)))];

type ActionKey = 'view' | 'add' | 'edit' | 'del';
type ModulePerm = Record<ActionKey, boolean>;
type PermMap = Record<number, Record<string, ModulePerm>>;

const ACTIONS: { key: ActionKey; label: string; icon: React.ElementType }[] = [
  { key: 'view', label: 'View',   icon: Eye },
  { key: 'add',  label: 'Add',    icon: Plus },
  { key: 'edit', label: 'Edit',   icon: Pencil },
  { key: 'del',  label: 'Delete', icon: Trash2 },
];

/** Build a local perm map from DB records.
 *  Missing rows → view-only default (matches the enforced runtime default). */
function buildPermMap(hierarchies: Hierarchy[], dbPerms: Permission[]): PermMap {
  const map: PermMap = {};
  for (const h of hierarchies) {
    map[h.id] = {};
    for (const mod of ALL_MODULE_KEYS) {
      const dbRow = dbPerms.find(p => p.hierarchyId === h.id && p.module === mod);
      if (dbRow) {
        map[h.id][mod] = {
          view: dbRow.canView  ?? true,
          add:  dbRow.canAdd   ?? false,
          edit: dbRow.canEdit  ?? false,
          del:  dbRow.canDelete ?? false,
        };
      } else {
        map[h.id][mod] = { view: true, add: false, edit: false, del: false };
      }
    }
  }
  return map;
}

const allOn = (p?: ModulePerm) => !!p && p.view && p.add && p.edit && p.del;
const setAllActions = (value: boolean): ModulePerm => ({ view: value, add: value, edit: value, del: value });

export default function Permissions() {
  const selfPerm = usePermission('Permissions');
  const { data: hierarchies = [], isLoading: loadingH } = useListHierarchies();
  const { data: dbPerms = [],    isLoading: loadingP, refetch } = useListPermissions();

  const sortedHierarchies = useMemo(
    () => [...hierarchies as Hierarchy[]].sort((a, b) => (a.level ?? 99) - (b.level ?? 99)),
    [hierarchies],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = selectedId ?? sortedHierarchies[0]?.id ?? null;

  const [perms, setPerms] = useState<PermMap>({});
  const [dirty,  setDirty]  = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loadingH || loadingP || dirty) return;
    if (sortedHierarchies.length === 0) return;
    setPerms(buildPermMap(sortedHierarchies, dbPerms as Permission[]));
  }, [loadingH, loadingP, dirty, sortedHierarchies, dbPerms]);

  const selectedHierarchy = sortedHierarchies.find(h => h.id === effectiveId);
  const isTopLevel = (selectedHierarchy?.level ?? 99) === 1;

  const rolePerms: Record<string, ModulePerm> = effectiveId ? (perms[effectiveId] ?? {}) : {};

  // Count only nav-visible modules for the summary
  const visibleCount = NAV_MODULE_KEYS.filter(m => rolePerms[m]?.view).length;

  // ── Mutators ──────────────────────────────────────────────────────────────
  const updateModule = (module: string, next: ModulePerm) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({ ...prev, [effectiveId]: { ...prev[effectiveId], [module]: next } }));
    setDirty(true);
  };

  const toggleAction = (module: string, action: ActionKey) => {
    const cur = rolePerms[module] ?? { view: true, add: false, edit: false, del: false };
    const next = { ...cur, [action]: !cur[action] };
    if (action === 'view' && !next.view) { next.add = false; next.edit = false; next.del = false; }
    else if (action !== 'view' && next[action]) { next.view = true; }
    updateModule(module, next);
  };

  const setAll = (value: boolean) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({
      ...prev,
      [effectiveId]: Object.fromEntries(ALL_MODULE_KEYS.map(m => [m, setAllActions(value)])),
    }));
    setDirty(true);
  };

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

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!effectiveId) return;
    setSaving(true);
    try {
      await Promise.all(
        ALL_MODULE_KEYS.map(mod => {
          const p = rolePerms[mod] ?? { view: true, add: false, edit: false, del: false };
          return setPermission({
            hierarchyId: effectiveId,
            module: mod,
            canView: p.view, canAdd: p.add, canEdit: p.edit, canDelete: p.del,
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

  // ── Access denied ─────────────────────────────────────────────────────────
  if (!selfPerm.isLoading && !selfPerm.canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
            <ShieldOff className="w-8 h-8 text-destructive" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Access Denied</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You don't have permission to view this page.<br />
              Contact your administrator to request access.
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl">

        {/* ── Header ────────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-primary" /> Permissions
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Controls what each role can see and do.
              View = section visible in the sidebar and shows data.
              Add / Edit / Delete are enforced on every action.
            </p>
          </div>
          <Button size="sm" onClick={save} disabled={saving || !dirty || isTopLevel}>
            {saving
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
              : <><Save className="w-4 h-4 mr-2" />Save</>}
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
            {/* ── Role tabs ─────────────────────────────────────────────────── */}
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

            {/* ── Summary row ───────────────────────────────────────────────── */}
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{selectedHierarchy?.name}</span>
                {' '}can view{' '}
                <span className="font-bold text-foreground">{visibleCount}</span>
                {' '}of {NAV_MODULE_KEYS.length} sections
                {isTopLevel && (
                  <span className="ml-2 text-primary text-xs font-medium">(Top level — always full access)</span>
                )}
              </span>
              {!isTopLevel && (
                <div className="flex gap-2">
                  <button onClick={() => setAll(true)} className="text-xs text-primary hover:underline">
                    Enable all
                  </button>
                  <span className="text-muted-foreground">·</span>
                  <button onClick={() => setAll(false)} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
                    Disable all
                  </button>
                </div>
              )}
            </div>

            {/* ── Permission table — one card per sidebar section ────────────── */}
            <div className="space-y-3">
              {PERM_SECTIONS.map(section => {
                const sectionKeys = [...new Set(section.rows.map(r => r.moduleKey))];
                const sectionAllOn = sectionKeys.every(k => allOn(rolePerms[k]));
                const sectionViewCount = sectionKeys.filter(k => rolePerms[k]?.view).length;

                return (
                  <div key={section.name} className="bg-card border border-border rounded-xl overflow-hidden">

                    {/* Section header */}
                    <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <section.icon className="w-4 h-4 text-muted-foreground" />
                        <h3 className="text-sm font-semibold text-foreground">{section.name}</h3>
                        <span className="text-xs text-muted-foreground">
                          {sectionViewCount}/{sectionKeys.length} visible
                        </span>
                      </div>
                      {!isTopLevel && (
                        <Switch
                          checked={sectionAllOn}
                          onCheckedChange={v => toggleModules(sectionKeys, v)}
                          title={sectionAllOn ? `Revoke all ${section.name}` : `Grant full ${section.name}`}
                        />
                      )}
                    </div>

                    {/* Column headers */}
                    <div className="grid grid-cols-[1fr_repeat(4,3.5rem)] items-center px-4 py-2 border-b border-border/40 bg-muted/5">
                      <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        Section / Page
                      </span>
                      {ACTIONS.map(a => (
                        <span
                          key={a.key}
                          className="text-[11px] uppercase tracking-wider text-muted-foreground text-center flex items-center justify-center gap-1"
                        >
                          <a.icon className="w-3 h-3" />
                          <span className="hidden sm:inline">{a.label}</span>
                        </span>
                      ))}
                    </div>

                    {/* Rows */}
                    <div className="divide-y divide-border/40">
                      {section.rows.map(row => {
                        const p = rolePerms[row.moduleKey] ?? { view: false, add: false, edit: false, del: false };
                        return (
                          <div
                            key={`${section.name}-${row.moduleKey}`}
                            className="grid grid-cols-[1fr_repeat(4,3.5rem)] items-center px-4 py-2.5 hover:bg-muted/5"
                          >
                            <div className="pr-2 min-w-0">
                              <span className={`text-sm truncate block ${p.view ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                                {row.displayName}
                              </span>
                              {row.subLabel && (
                                <span className="text-[11px] text-muted-foreground/70 truncate block">
                                  {row.subLabel}
                                </span>
                              )}
                            </div>
                            {ACTIONS.map(a => (
                              <div key={a.key} className="flex justify-center">
                                <Checkbox
                                  checked={isTopLevel ? true : p[a.key]}
                                  disabled={isTopLevel}
                                  onCheckedChange={() =>
                                    isTopLevel
                                      ? toast.info('Top-level authority always has full access')
                                      : toggleAction(row.moduleKey, a.key)
                                  }
                                  aria-label={`${a.label} ${row.displayName}`}
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

            <p className="text-xs text-muted-foreground pb-4">
              View controls what appears in the sidebar and what data is loaded on each page.
              Add, Edit, and Delete are enforced by the server on every write action —
              unchecking them blocks the operation even via direct API calls.
            </p>
          </>
        )}
      </div>
    </AppLayout>
  );
}
