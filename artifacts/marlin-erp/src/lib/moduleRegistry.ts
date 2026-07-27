/**
 * Module Registry — Single Source of Truth
 *
 * Every permission-controlled module in the ERP is defined here.
 *
 *   • AppLayout  derives the sidebar navigation from this file.
 *   • Permissions page derives its module list from this file.
 *   • usePermission() checks use the `key` strings defined here.
 *
 * ONE ERP · ONE SIDEBAR · ONE PERMISSION SYSTEM
 * ─────────────────────────────────────────────
 * Permissions decide visibility  (canView = ON → show link in sidebar).
 * Backend decides data scope     (branchType → filter rows returned).
 * No branch-type conditions in the frontend nav.
 *
 * To add a module:    add one entry to MODULE_REGISTRY.
 * To rename a module: change `key` here — updates sidebar + Permissions page.
 *                     NOTE: changing a key invalidates existing DB rows for
 *                     that module; run a migration if needed.
 * To reorder sidebar: adjust the position within MODULE_REGISTRY.
 */

import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  ArrowLeftRight,
  Receipt,
  Banknote,
  Factory,
  Building2,
  Calculator,
  Users,
  UsersRound,
  Settings,
  Store,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single sidebar link. One permission module can produce multiple sidebar
 * links (e.g. 'Vouchers' → Journal, Contra, Credit/Debit Notes).
 */
export interface NavEntry {
  /** Sidebar display name */
  name: string;
  href: string;
  matchPrefix?: string;
  /**
   * Override the module-level `navGroup` for this entry only.
   * Use when one permission key's links appear in multiple sidebar sections
   * (e.g. HO Transfers appears in both Operations and Inventory).
   */
  navGroup?: string;
}

/** One permission-controlled module — the atomic unit of the registry */
export interface ModuleDef {
  /**
   * Unique permission key.
   * Used by usePermission(), backend middleware, and audit logs.
   * Also the display label on the Permissions page.
   */
  key: string;

  // ── Permissions page ────────────────────────────────────────────────────────
  /** Group heading on the Permissions page (e.g. 'Operations', 'Production') */
  permGroup: string;

  // ── Sidebar ─────────────────────────────────────────────────────────────────
  /**
   * Default sidebar section for all navEntries.
   * Special value:
   *   '__standalone__' → leaf item shown directly in the sidebar (no group)
   * Named values (e.g. 'Operations', 'Production') → collapsible sidebar group.
   */
  navGroup: string;
  /** One or more sidebar links this permission key controls */
  navEntries: NavEntry[];
  /** Icon for standalone and Operations items (grouped items use section icon). */
  icon?: LucideIcon;
}

// ── Sidebar section metadata ──────────────────────────────────────────────────

export interface NavGroupMeta {
  icon: LucideIcon;
}

/**
 * Icon metadata for each named sidebar section.
 * Key order does NOT control render order — use NAV_GROUP_ORDER for that.
 */
export const NAV_GROUP_META: Record<string, NavGroupMeta> = {
  'Operations': { icon: Store },
  'Production': { icon: Factory },
  'Inventory':  { icon: Building2 },
  'Sales': { icon: Calculator },
  'HR':         { icon: Users },
  'Accounts':   { icon: UsersRound },
  'Company':    { icon: Settings },
};

/** Sidebar section display order */
export const NAV_GROUP_ORDER = [
  'Operations', 'Production', 'Inventory', 'Sales', 'HR', 'Accounts', 'Company',
] as const;

// ── Permissions page metadata ─────────────────────────────────────────────────

/** Display order of groups on the Permissions page */
export const PERM_GROUP_ORDER: string[] = [
  'Operations', 'Production', 'Inventory', 'Sales', 'HR', 'Accounts', 'Dashboard', 'Company',
];

/** One row in the permissions table — maps to a nav link the user can see */
export interface PermNavRow {
  moduleKey: string;
  /** Primary label — the nav-link name shown in the sidebar */
  displayName: string;
  /** Secondary line when one permission key controls multiple pages e.g. "Day Book · Cash Book · …" */
  subLabel?: string;
}

/** One section in the permissions table — mirrors a sidebar section */
export interface PermNavSection {
  name: string;
  icon: LucideIcon;
  rows: PermNavRow[];
}

/**
 * Returns the permissions-page structure derived entirely from the sidebar nav.
 * Sections = sidebar sections; rows = nav link names.
 * One permission key may control multiple nav links (e.g. "Books" → Day Book, Cash Book, …).
 */
export function getPermNavSections(): PermNavSection[] {
  const sections: PermNavSection[] = [];

  // ── 1. Standalone items (Dashboard) ────────────────────────────────────────
  const standaloneRows: PermNavRow[] = MODULE_REGISTRY
    .filter(m => m.navGroup === '__standalone__' && m.navEntries.length > 0)
    .map(m => ({ moduleKey: m.key, displayName: m.navEntries[0].name }));

  if (standaloneRows.length > 0) {
    sections.push({ name: 'General', icon: LayoutDashboard, rows: standaloneRows });
  }

  // ── 2. Sidebar-grouped sections ─────────────────────────────────────────────
  for (const group of getNavGroups()) {
    // Deduplicate by module key; collect all nav-entry names per key.
    const moduleMap = new Map<string, string[]>();
    for (const child of group.children ?? []) {
      if (!moduleMap.has(child.module)) moduleMap.set(child.module, []);
      moduleMap.get(child.module)!.push(child.name);
    }

    const rows: PermNavRow[] = Array.from(moduleMap.entries()).map(([moduleKey, names]) => ({
      moduleKey,
      // Single entry → show its nav link name. Multiple → show module key as label.
      displayName: names.length === 1 ? names[0] : moduleKey,
      subLabel: names.length > 1 ? names.join(' · ') : undefined,
    }));

    sections.push({ name: group.name, icon: group.icon, rows });
  }

  return sections;
}

// ── Module registry ───────────────────────────────────────────────────────────

export const MODULE_REGISTRY: ModuleDef[] = [

  // ── Operations ───────────────────────────────────────────────────────────
  // Branch-facing: POS, stock, transfers, expenses, cash.
  // Also visible to any employee whose admin grants them access.
  // NOTE: Dashboard is a standalone top-level item (see below) — not inside Operations.
  {
    key: 'Point of Sale', permGroup: 'Operations',
    navGroup: 'Operations',
    navEntries: [{ name: 'Point of Sale', href: '/sales/pos' }],
    icon: ShoppingCart,
  },
  {
    key: 'Location Stock', permGroup: 'Operations',
    navGroup: 'Operations',
    // navEntries intentionally empty — stock access is provided through the
    // 'Stock' module below, which appears in both Operations and Inventory.
    // This key is kept for backward-compatible permission rows.
    navEntries: [],
  },
  {
    // HO Transfers sits in the Inventory permGroup (admin concern)
    // but also appears in the Operations sidebar section so branch
    // employees can access it without needing any Inventory permission.
    key: 'HO Transfers', permGroup: 'Inventory',
    navGroup: 'Stock',
    navEntries: [
      { name: 'Transfers', href: '/transfers' },
    ],
    icon: ArrowLeftRight,
  },
  {
    key: 'Location Expenses', permGroup: 'Operations',
    navGroup: 'Operations',
    navEntries: [{ name: 'Expenses', href: '/sales/expenses' }],
    icon: Receipt,
  },
  {
    key: 'Cash Balance', permGroup: 'Operations',
    navGroup: 'Operations',
    navEntries: [
      { name: 'Cash Balance', href: '/accounts/cash-in-outlet' },
    ],
    icon: Banknote,
  },

  // ── Production ─────────────────────────────────────────────────────────────
  {
    key: 'Units', permGroup: 'Production',
    navGroup: 'Item Master',
    navEntries: [{ name: 'Units', href: '/production/units' }],
  },
  {
    key: 'Items', permGroup: 'Production',
    navGroup: 'Item Master',
    navEntries: [{ name: 'Item Master', href: '/production/item-master' }],
  },
  {
    key: 'Production', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [
      { name: 'Batches', href: '/production/production' },
      { name: 'Reports', href: '/production/reports' },
    ],
  },
  {
    key: 'Purchases', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Purchases', href: '/production/purchase' }],
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  {
    // Appears in Operations (branch view) AND Inventory (HO view) —
    // same pattern as HO Transfers. One "Stock" entry per section.
    key: 'Stock', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [
      { name: 'Stock Transfers', href: '/headoffice/stock', navGroup: 'Stock' },
    ],
    icon: Package,
  },
  {
    key: 'Stock Ledger', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Stock Ledger', href: '/headoffice/stock-ledger' }],
  },
  {
    key: 'Inventory Reports', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Reports', href: '/headoffice/inventory-reports' }],
  },
  {
    key: 'Stock Verification', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Verification', href: '/headoffice/stock-verification' }],
  },
  {
    key: 'Warehouses', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Warehouses', href: '/headoffice/warehouses' }],
  },
  {
    key: 'Outlets', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Outlets', href: '/headoffice/outlets' }],
  },
  {
    key: 'Item Prices', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Item Prices', href: '/headoffice/item-price' }],
  },

  // ── Sales ─────────────────────────────────────────────────────────────────
  {
    key: 'Sales', permGroup: 'Sales',
    navGroup: 'Sales',
    navEntries: [
      { name: 'Returns',     href: '/returns' },
      { name: 'Outstanding', href: '/outstanding' },
    ],
  },
  {
    key: 'Customers', permGroup: 'Sales',
    navGroup: 'Operations',
    navEntries: [{ name: 'Customers', href: '/customers' }],
  },
  {
    key: 'Vendors', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Vendors', href: '/vendors' }],
  },
  {
    key: 'Coupons', permGroup: 'Sales',
    navGroup: 'Sales',
    navEntries: [{ name: 'Coupons', href: '/coupons' }],
  },

  // ── HR ────────────────────────────────────────────────────────────────────
  {
    key: 'Employees', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Employees', href: '/hr/employees' }],
  },
  {
    key: 'Attendance', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Attendance', href: '/hr/attendance' }],
  },
  {
    key: 'Leave', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [],  // Leave management is accessed from Attendance page
  },
  {
    key: 'Payroll', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Payroll', href: '/hr/payroll' }, { name: 'Advances', href: '/hr/advances' }],
  },
  {
    key: 'Hierarchy', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Hierarchy', href: '/hr/hierarchy' }],
  },

  // ── Accounts ──────────────────────────────────────────────────────────────
  {
    key: 'Chart of Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Chart of Accounts', href: '/accounts/chart' }],
  },
  {
    key: 'Ledger', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Ledger Statement', href: '/accounts/ledger' }],
  },
  {
    key: 'Payments', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [],
  },
  {
    key: 'Cash & Bank', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Cash & Bank', href: '/accounts/cash-bank' }],
  },
  {
    key: 'Vouchers', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [
      { name: 'Vouchers', href: '/accounts/vouchers' },
    ],
  },
  {
    key: 'Books', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [
      { name: 'Day Book',      href: '/accounts/day-book' },
      { name: 'Cash Book',     href: '/accounts/cash-book' },
      { name: 'Bank Book',     href: '/accounts/bank-book' },
      { name: 'Trial Balance', href: '/accounts/trial-balance' },
    ],
  },
  {
    key: 'Expenses', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Expenses', href: '/accounts/expenses' }],
  },
  {
    key: 'GST Summary', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'GST Summary', href: '/accounts/gst' }],
  },
  {
    key: 'GST Returns', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'GST Returns', href: '/accounts/gst-returns' }],
  },
  {
    key: 'Reconciliation', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Reconciliation', href: '/accounts/reconciliation' }],
  },
  {
    // 'Cash Balance' in Operations now covers both the branch view (/sales/cash-balance)
    // and the HO aggregate view (/accounts/cash-in-outlet), following the HO Transfers
    // pattern. This module key is kept for backward-compatible permission rows only;
    // its nav entry is intentionally empty to avoid a duplicate "Cash in Outlet" in Accounts.
    key: 'Accounts Cash Balance', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [],
  },
  {
    key: 'Reports', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Reports', href: '/reports/sales', matchPrefix: '/reports' }],
  },

  // ── Dashboard (standalone — always the first item) ────────────────────────
  {
    key: 'Dashboard', permGroup: 'Dashboard',
    navGroup: '__standalone__',
    navEntries: [{ name: 'Dashboard', href: '/' }],
    icon: LayoutDashboard,
  },

  // ── Company ───────────────────────────────────────────────────────────────
  {
    key: 'Settings', permGroup: 'Company',
    navGroup: 'Company',
    navEntries: [
      { name: 'Settings',        href: '/company/settings' },
      { name: 'Company Profile', href: '/company/profile' },
      { name: 'Audit Log',       href: '/company/audit' },
    ],
  },
  {
    key: 'Permissions', permGroup: 'Company',
    navGroup: 'Company',
    navEntries: [{ name: 'Permissions', href: '/company/permissions' }],
  },
  {
    key: 'Login History', permGroup: 'Company',
    navGroup: 'Company',
    navEntries: [{ name: 'Login History', href: '/company/login-history' }],
  },
];

// ── Derived exports ───────────────────────────────────────────────────────────

/** All unique permission keys in registry order (used by Permissions page) */
export const ALL_MODULE_KEYS: string[] = MODULE_REGISTRY.map(m => m.key);

// ── Permissions page helpers ──────────────────────────────────────────────────

export interface PermGroupDef { title: string; modules: string[] }

/**
 * Returns all module groups in PERM_GROUP_ORDER, consumed by the Permissions page.
 * One flat list — no Sales/Accounts tab split.
 */
export function getPermissionGroups(): PermGroupDef[] {
  const groupMap = new Map<string, string[]>();
  for (const grp of PERM_GROUP_ORDER) groupMap.set(grp, []);

  for (const mod of MODULE_REGISTRY) {
    if (groupMap.has(mod.permGroup)) {
      groupMap.get(mod.permGroup)!.push(mod.key);
    } else {
      groupMap.set(mod.permGroup, [mod.key]);
    }
  }

  return Array.from(groupMap.entries())
    .filter(([, mods]) => mods.length > 0)
    .map(([title, modules]) => ({ title, modules }));
}

/**
 * @deprecated Kept for backward compatibility — returns a single-element array
 * wrapping getPermissionGroups(). Prefer getPermissionGroups() directly.
 */
export interface PermSegmentDef {
  segment: string;
  description: string;
  groups: PermGroupDef[];
}
export function getPermissionSegments(): PermSegmentDef[] {
  return [{
    segment: 'ERP',
    description: 'All modules — visibility controlled by granted permissions',
    groups: getPermissionGroups(),
  }];
}

// ── Sidebar nav helpers ───────────────────────────────────────────────────────

export interface AccountsNavChildDef {
  name: string;
  href: string;
  module: string;
  matchPrefix?: string;
}

/**
 * A single item in the sidebar.
 * Standalone items have `href`; grouped sections have `children`.
 */
export interface SidebarNavItem {
  name: string;
  icon: LucideIcon;
  /** Present for standalone (leaf) nav items */
  href?: string;
  /** Permission key for standalone items */
  module?: string;
  /** Present for grouped nav sections */
  children?: AccountsNavChildDef[];
}

/** @deprecated Use SidebarNavItem */
export type AccountsNavGroupDef = SidebarNavItem;

/**
 * Returns the complete sidebar nav: grouped sections in NAV_GROUP_ORDER.
 * Sections with no visible children are omitted.
 * The Transfers link (HO Transfers module) appears in BOTH Operations and
 * Inventory sections because the module has two navEntries with different navGroups.
 * Duplicate hrefs within the same group are deduplicated automatically.
 */
export function getNavGroups(): SidebarNavItem[] {
  const groupMap = new Map<string, AccountsNavChildDef[]>();
  const seenHref  = new Map<string, Set<string>>(); // group → Set<href>
  for (const groupName of NAV_GROUP_ORDER) {
    groupMap.set(groupName, []);
    seenHref.set(groupName, new Set());
  }

  for (const mod of MODULE_REGISTRY) {
    for (const entry of mod.navEntries) {
      const group = entry.navGroup ?? mod.navGroup;
      if (!groupMap.has(group)) continue;
      const seen = seenHref.get(group)!;
      if (seen.has(entry.href)) continue; // deduplicate same href in same group
      seen.add(entry.href);
      groupMap.get(group)!.push({
        name:        entry.name,
        href:        entry.href,
        module:      mod.key,
        ...(entry.matchPrefix ? { matchPrefix: entry.matchPrefix } : {}),
      });
    }
  }

  return NAV_GROUP_ORDER
    .map(groupName => ({
      name:     groupName,
      icon:     NAV_GROUP_META[groupName].icon,
      children: groupMap.get(groupName) ?? [],
    }))
    .filter(g => g.children.length > 0);
}

/** @deprecated Use getNavGroups() */
export function getAccountsNavGroups(): SidebarNavItem[] {
  return getNavGroups();
}
