import { useState, useMemo, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ShieldCheck, ShieldOff, Save, Loader2, ChevronUp, Search,
  Eye, Plus, Pencil, Trash2, Download, Printer, BadgeCheck, Share2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useListHierarchies, useListPermissions, setPermission } from '@workspace/api-client-react';
import { usePermission } from '@/lib/usePermission';
import { getPagePermRows, PAGE_PERM_KEYS } from '@/lib/moduleRegistry';
import type { Hierarchy, Permission } from '@workspace/api-client-react';

// ── One row per sidebar link ──────────────────────────────────────────────────
// Deliberately flat and ungrouped. Grouping used to mean one row governed several
// pages — "Books" covered Day Book, Cash Book, Bank Book and Trial Balance — so
// granting a cashier the Cash Book also handed them the Trial Balance. Every link
// in the sidebar now has its own row, in the order the sidebar renders them.
//
// Derived from moduleRegistry.ts, the same source the sidebar renders from, so
// the two can never drift.
const PAGE_ROWS = getPagePermRows();

type ActionKey = 'view' | 'add' | 'edit' | 'del' | 'download' | 'print' | 'approve' | 'share';
type PagePerm = Record<ActionKey, boolean>;
type PermMap = Record<number, Record<string, PagePerm>>;

const ACTIONS: { key: ActionKey; label: string; icon: React.ElementType }[] = [
  { key: 'view',     label: 'View',     icon: Eye },
  { key: 'add',      label: 'Add',      icon: Plus },
  { key: 'edit',     label: 'Edit',     icon: Pencil },
  { key: 'del',      label: 'Delete',   icon: Trash2 },
  { key: 'download', label: 'Download', icon: Download },
  { key: 'print',    label: 'Print',    icon: Printer },
  // Approval is sign-off authority, not editing: approving a month's rent commits
  // it to the books. A role that may correct a draft is not automatically a role
  // that may commit it, so this is granted separately.
  { key: 'approve',  label: 'Approve',  icon: BadgeCheck },
  // Sharing sends a document out of the company: an invoice share link opens with
  // no login, for anyone who receives it. That is a different risk from printing
  // or downloading a copy in the office, so it is granted on its own.
  { key: 'share',    label: 'Share',    icon: Share2 },
];

const GRID = 'grid grid-cols-[1fr_repeat(8,3rem)] gap-x-1';

const NONE: PagePerm = { view: false, add: false, edit: false, del: false, download: false, print: false, approve: false, share: false };
const allActions = (value: boolean): PagePerm =>
  ({ view: value, add: value, edit: value, del: value, download: value, print: value, approve: value, share: value });

/**
 * Build the editable map from DB rows.
 * A missing row is shown as fully denied — the same thing the server does when
 * it cannot find a row. The old page defaulted missing rows to view-allowed,
 * which quietly told admins a role had access the API would refuse.
 */
function buildPermMap(hierarchies: Hierarchy[], dbPerms: Permission[]): PermMap {
  const map: PermMap = {};
  for (const h of hierarchies) {
    map[h.id] = {};
    for (const key of PAGE_PERM_KEYS) {
      const row = dbPerms.find(p => p.hierarchyId === h.id && p.module === key);
      map[h.id][key] = row
        ? {
            view:     row.canView     ?? false,
            add:      row.canAdd      ?? false,
            edit:     row.canEdit     ?? false,
            del:      row.canDelete   ?? false,
            download: row.canDownload ?? false,
            print:    row.canPrint    ?? false,
            approve:  row.canApprove  ?? false,
            share:    row.canShare    ?? false,
          }
        : { ...NONE };
    }
  }
  return map;
}

export default function Permissions() {
  const selfPerm = usePermission('page:/company/permissions');
  const { data: hierarchies = [], isLoading: loadingH } = useListHierarchies();
  const { data: dbPerms = [],    isLoading: loadingP, refetch } = useListPermissions();

  const sortedHierarchies = useMemo(
    () => [...hierarchies as Hierarchy[]].sort((a, b) => (a.level ?? 99) - (b.level ?? 99)),
    [hierarchies],
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const effectiveId = selectedId ?? sortedHierarchies[0]?.id ?? null;

  const [perms,  setPerms]  = useState<PermMap>({});
  const [dirty,  setDirty]  = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (loadingH || loadingP || dirty) return;
    if (sortedHierarchies.length === 0) return;
    setPerms(buildPermMap(sortedHierarchies, dbPerms as Permission[]));
  }, [loadingH, loadingP, dirty, sortedHierarchies, dbPerms]);

  const selectedHierarchy = sortedHierarchies.find(h => h.id === effectiveId);
  const isTopLevel = (selectedHierarchy?.level ?? 99) === 1;
  const rolePerms: Record<string, PagePerm> = effectiveId ? (perms[effectiveId] ?? {}) : {};

  const visibleCount = PAGE_PERM_KEYS.filter(k => rolePerms[k]?.view).length;

  const q = filter.trim().toLowerCase();
  const shownRows = q
    ? PAGE_ROWS.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.section.toLowerCase().includes(q) ||
        r.href.toLowerCase().includes(q))
    : PAGE_ROWS;

  // ── Mutators ──────────────────────────────────────────────────────────────
  const patch = (changes: Record<string, PagePerm>) => {
    if (!effectiveId || isTopLevel) return;
    setPerms(prev => ({ ...prev, [effectiveId]: { ...prev[effectiveId], ...changes } }));
    setDirty(true);
  };

  const toggleAction = (key: string, action: ActionKey) => {
    const cur = rolePerms[key] ?? { ...NONE };
    const next = { ...cur, [action]: !cur[action] };
    // View is the gate: a page you cannot open cannot be added to, exported or
    // printed either. Keep the row internally consistent so the checkboxes never
    // promise something the server will refuse.
    if (action === 'view' && !next.view) Object.assign(next, NONE);
    else if (action !== 'view' && next[action]) next.view = true;
    patch({ [key]: next });
  };

  const setAll = (value: boolean) =>
    patch(Object.fromEntries(PAGE_PERM_KEYS.map(k => [k, allActions(value)])));

  /** Grant or revoke one action across every page currently shown. */
  const toggleColumn = (action: ActionKey) => {
    const keys = shownRows.map(r => r.key);
    const turningOn = !keys.every(k => rolePerms[k]?.[action]);
    patch(Object.fromEntries(keys.map(k => {
      const cur = rolePerms[k] ?? { ...NONE };
      const next = { ...cur, [action]: turningOn };
      if (action === 'view' && !turningOn) Object.assign(next, NONE);
      else if (action !== 'view' && turningOn) next.view = true;
      return [k, next];
    })));
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!effectiveId) return;
    setSaving(true);
    try {
      await Promise.all(
        PAGE_PERM_KEYS.map(key => {
          const p = rolePerms[key] ?? NONE;
          return setPermission({
            hierarchyId: effectiveId,
            module: key,
            canView: p.view, canAdd: p.add, canEdit: p.edit, canDelete: p.del,
            canDownload: p.download, canPrint: p.print, canApprove: p.approve,
            canShare: p.share,
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
              One row for every page in the sidebar, in the order they appear there.
              View decides whether the page is listed at all; the rest are enforced
              by the server on every action.
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

            {/* ── Summary + search ──────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{selectedHierarchy?.name}</span>
                {' '}can open{' '}
                <span className="font-bold text-foreground">{visibleCount}</span>
                {' '}of {PAGE_PERM_KEYS.length} pages
                {isTopLevel && (
                  <span className="ml-2 text-primary text-xs font-medium">(Top level — always full access)</span>
                )}
              </span>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder="Find a page…"
                    className="h-8 w-44 pl-8 text-sm"
                  />
                </div>
                {!isTopLevel && (
                  <div className="flex gap-2 shrink-0">
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
            </div>

            {/* ── Permission table — one flat row per sidebar link ───────────── */}
            <div className="bg-card border border-border rounded-xl overflow-hidden">

              {/* Column headers — click one to set that action on every listed page */}
              <div className={`${GRID} items-center px-4 py-2.5 border-b border-border bg-muted/20 sticky top-0 z-10`}>
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Page
                </span>
                {ACTIONS.map(a => (
                  <button
                    key={a.key}
                    type="button"
                    disabled={isTopLevel}
                    onClick={() => toggleColumn(a.key)}
                    title={isTopLevel ? undefined : `Toggle ${a.label} for every page listed`}
                    className="uppercase text-muted-foreground flex flex-col items-center gap-0.5 disabled:cursor-default enabled:hover:text-foreground"
                  >
                    <a.icon className="w-3.5 h-3.5" />
                    {/* Eight columns in the width that used to hold seven: the labels
                        have to stay inside their own cell or they read as one word. */}
                    <span className="hidden sm:inline text-[9px] leading-none tracking-tight">{a.label}</span>
                  </button>
                ))}
              </div>

              {/* Rows */}
              <div className="divide-y divide-border/40">
                {shownRows.map(row => {
                  const p = rolePerms[row.key] ?? NONE;
                  return (
                    <div key={row.key} className={`${GRID} items-center px-4 py-2 hover:bg-muted/5`}>
                      <div className="pr-2 min-w-0">
                        <span className={`text-sm truncate block ${p.view || isTopLevel ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                          {row.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground/70 truncate block">
                          {row.section ? `${row.section} · ${row.href}` : row.href}
                        </span>
                      </div>
                      {ACTIONS.map(a => (
                        <div key={a.key} className="flex justify-center">
                          <Checkbox
                            checked={isTopLevel ? true : p[a.key]}
                            disabled={isTopLevel}
                            onCheckedChange={() =>
                              isTopLevel
                                ? toast.info('Top-level authority always has full access')
                                : toggleAction(row.key, a.key)
                            }
                            aria-label={`${a.label} ${row.name}`}
                          />
                        </div>
                      ))}
                    </div>
                  );
                })}
                {shownRows.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No page matches “{filter}”.
                  </div>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground pb-4">
              View controls whether the page appears in the sidebar and loads.
              Add, Edit and Delete are enforced by the server on every write, so
              unchecking them blocks the action even through direct API calls.
              Download covers CSV and PDF exports; Print covers printing the same
              documents — a role can be allowed to print an invoice without being
              able to take a copy of the file away.
            </p>
          </>
        )}
      </div>
    </AppLayout>
  );
}
