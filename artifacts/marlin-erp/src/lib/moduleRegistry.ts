/**
 * Module Registry — Single Source of Truth
 *
 * Every permission-controlled module in the ERP is defined here.
 *
 *   • AppLayout  derives the sidebar navigation from this file.
 *   • Permissions page derives its module list from this file.
 *   • usePermission() checks use the `key` strings defined here.
 *
 * To add a module:    add one entry to MODULE_REGISTRY.
 * To rename a module: change `key` here — it updates everywhere automatically
 *                     (sidebar, permissions page, permission guards).
 *                     NOTE: changing a key invalidates existing DB permission rows
 *                     for that module; run a migration if needed.
 * To reorder sidebar: adjust the position within MODULE_REGISTRY.
 *
 * BRANCH SCOPING NOTE:
 * `branchGroups` has been intentionally removed from this registry.
 * Module visibility is now controlled ONLY by granted permissions (View = ON/OFF).
 * Data scoping (which records a user can see) is enforced server-side via
 * `getUserDataScope()` in the API server, based on the employee's branch_type
 * and branch_id. Admins grant access via the Permissions page; branch type
 * no longer vetoes any nav item.
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
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PermSegment = 'Sales' | 'Accounts';

/**
 * A single sidebar link. One permission module can produce multiple sidebar
 * links (e.g. 'Vouchers' produces Journal, Contra, Credit/Debit Notes).
 */
export interface NavEntry {
  /** Sidebar display name for this specific link */
  name: string;
  href: string;
  matchPrefix?: string;
  /**
   * Override the module-level `navGroup` for this entry only.
   * Use when one permission key's links appear in multiple sidebar sections
   * (e.g. Cash Balance shows in both the Sales segment and Accounts nav).
   */
  navGroup?: string;
}

/** One permission-controlled module — the atomic unit of the registry */
export interface ModuleDef {
  /**
   * Unique permission key.
   * Used by usePermission(), the backend middleware, and audit logs.
   * Also the display label on the Permissions page.
   */
  key: string;

  // ── Permissions page ────────────────────────────────────────────────────────
  /** Which top-level segment ('Sales' | 'Accounts') on the Permissions page */
  permSegment: PermSegment;
  /** Which group heading on the Permissions page (e.g. 'Production', 'HR') */
  permGroup: string;

  // ── Sidebar ─────────────────────────────────────────────────────────────────
  /**
   * Default sidebar section for all navEntries.
   * Special values:
   *   '__sales__'      → flat sales-segment nav (each item needs `icon`)
   *   '__standalone__' → top-level accounts nav item (not in a group)
   * Named values (e.g. 'Production') → grouped accounts sidebar section.
   */
  navGroup: string;
  /** One or more sidebar links this permission key controls */
  navEntries: NavEntry[];
  /**
   * Icon for flat sales-segment items and standalone accounts items.
   * Grouped accounts items use their section icon (defined in NAV_GROUP_META).
   */
  icon?: LucideIcon;
}

// ── Sidebar section metadata ──────────────────────────────────────────────────

export interface NavGroupMeta {
  icon: LucideIcon;
}

/**
 * Metadata (icon) for each named accounts-segment sidebar section.
 * Order here controls the order sections appear in the sidebar.
 */
export const NAV_GROUP_META: Record<string, NavGroupMeta> = {
  'Production': { icon: Factory },
  'Inventory':  { icon: Building2 },
  'Sales (HO)': { icon: Calculator },
  'HR':         { icon: Users },
  'Accounts':   { icon: UsersRound },
  'Company':    { icon: Settings },
};

/** Sidebar section display order */
export const NAV_GROUP_ORDER = [
  'Production', 'Inventory', 'Sales (HO)', 'HR', 'Accounts', 'Company',
] as const;

// ── Permissions page metadata ─────────────────────────────────────────────────

export const SEGMENT_DESCRIPTIONS: Record<PermSegment, string> = {
  Sales:    'Point-of-sale operations at warehouses and outlets',
  Accounts: 'Back-office: production, inventory, finance, HR and company settings',
};

/** Display order of groups within each segment on the Permissions page */
export const PERM_GROUP_ORDER: Record<PermSegment, string[]> = {
  Sales:    ['Sales Department'],
  Accounts: ['Production', 'Inventory', 'Sales (HO)', 'HR', 'Accounts', 'Dashboard', 'Company'],
};

// ── Module registry ───────────────────────────────────────────────────────────

export const MODULE_REGISTRY: ModuleDef[] = [

  // ── Sales Department (flat sales-segment nav — outlet / location facing) ───
  {
    key: 'Sales Dashboard', permSegment: 'Sales', permGroup: 'Sales Department',
    navGroup: '__sales__',
    navEntries: [{ name: 'Dashboard', href: '/sales/dashboard' }],
    icon: LayoutDashboard,
  },
  {
    key: 'Point of Sale', permSegment: 'Sales', permGroup: 'Sales Department',
    navGroup: '__sales__',
    navEntries: [{ name: 'Point of Sale', href: '/sales/pos' }],
    icon: ShoppingCart,
  },
  {
    key: 'Location Stock', permSegment: 'Sales', permGroup: 'Sales Department',
    navGroup: '__sales__',
    navEntries: [{ name: 'Stock', href: '/sales/stock' }],
    icon: Package,
  },
  {
    key: 'Location Transfers', permSegment: 'Sales', permGroup: 'Sales Department',
    navGroup: '__sales__',
    navEntries: [{ name: 'Transfers', href: '/sales/transfers' }],
    icon: ArrowLeftRight,
  },
  {
    key: 'Location Expenses', permSegment: 'Sales', permGroup: 'Sales Department',
    navGroup: '__sales__',
    navEntries: [{ name: 'Expenses', href: '/sales/expenses' }],
    icon: Receipt,
  },
  {
    key: 'Cash Balance', permSegment: 'Sales', permGroup: 'Sales Department',
    navGroup: '__sales__',
    navEntries: [
      { name: 'Cash Balance', href: '/sales/cash-balance' },
    ],
    icon: Banknote,
  },
  {
    key: 'Accounts Cash Balance', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [
      { name: 'Cash Balance', href: '/accounts/cash-in-outlet' },
    ],
    icon: Banknote,
  },

  // ── Production (permission-gated; no branch restriction in sidebar) ─────────
  {
    key: 'Units', permSegment: 'Accounts', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Units', href: '/production/units' }],
  },
  {
    key: 'Materials', permSegment: 'Accounts', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Materials', href: '/production/materials' }],
  },
  {
    key: 'Raw Materials', permSegment: 'Accounts', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Raw Materials', href: '/production/raw-materials' }],
  },
  {
    key: 'Items', permSegment: 'Accounts', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Item Master', href: '/production/item-master' }],
  },
  {
    key: 'Production', permSegment: 'Accounts', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [
      { name: 'Batches', href: '/production/production' },
      { name: 'Reports', href: '/production/reports' },
    ],
  },
  {
    key: 'Stock Transfers', permSegment: 'Accounts', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Stock Transfers', href: '/production/stock-transfer' }],
  },
  {
    key: 'Purchases', permSegment: 'Accounts', permGroup: 'Production',
    navGroup: 'Production',
    navEntries: [{ name: 'Purchases', href: '/production/purchase' }],
  },

  // ── Inventory ─────────────────────────────────────────────────────────────
  {
    key: 'Stock', permSegment: 'Accounts', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Stock', href: '/headoffice/stock' }],
  },
  {
    key: 'Inventory Reports', permSegment: 'Accounts', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Reports', href: '/headoffice/inventory-reports' }],
  },
  {
    key: 'Stock Verification', permSegment: 'Accounts', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Verification', href: '/headoffice/stock-verification' }],
  },
  {
    key: 'HO Transfers', permSegment: 'Accounts', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Transfers', href: '/headoffice/transfers' }],
  },
  {
    key: 'Warehouses', permSegment: 'Accounts', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Warehouses', href: '/headoffice/warehouses' }],
  },
  {
    key: 'Outlets', permSegment: 'Accounts', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Outlets', href: '/headoffice/outlets' }],
  },
  {
    key: 'Item Prices', permSegment: 'Accounts', permGroup: 'Inventory',
    navGroup: 'Inventory',
    navEntries: [{ name: 'Item Prices', href: '/headoffice/item-price' }],
  },

  // ── Sales (HO) ────────────────────────────────────────────────────────────
  {
    key: 'Sales', permSegment: 'Accounts', permGroup: 'Sales (HO)',
    navGroup: 'Sales (HO)',
    navEntries: [
      { name: 'Orders',      href: '/headoffice/sales' },
      { name: 'Returns',     href: '/returns' },
      { name: 'Outstanding', href: '/outstanding' },
    ],
  },
  {
    key: 'Customers', permSegment: 'Accounts', permGroup: 'Sales (HO)',
    navGroup: 'Sales (HO)',
    navEntries: [{ name: 'Customers', href: '/customers' }],
  },
  {
    key: 'Vendors', permSegment: 'Accounts', permGroup: 'Sales (HO)',
    navGroup: 'Sales (HO)',
    navEntries: [{ name: 'Vendors', href: '/vendors' }],
  },
  {
    key: 'Coupons', permSegment: 'Accounts', permGroup: 'Sales (HO)',
    navGroup: 'Sales (HO)',
    navEntries: [{ name: 'Coupons', href: '/coupons' }],
  },

  // ── HR (permission-gated; admins can grant to any employee) ──────────────
  {
    key: 'Employees', permSegment: 'Accounts', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Employees', href: '/hr/employees' }],
  },
  {
    key: 'Attendance', permSegment: 'Accounts', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Attendance', href: '/hr/attendance' }],
  },
  {
    key: 'Leave', permSegment: 'Accounts', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Leave', href: '/hr/leave' }],
  },
  {
    key: 'Payroll', permSegment: 'Accounts', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Payroll', href: '/hr/payroll' }],
  },
  {
    key: 'Hierarchy', permSegment: 'Accounts', permGroup: 'HR',
    navGroup: 'HR',
    navEntries: [{ name: 'Hierarchy', href: '/hr/hierarchy' }],
  },

  // ── Accounts ──────────────────────────────────────────────────────────────
  {
    key: 'Chart of Accounts', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Chart of Accounts', href: '/accounts/chart' }],
  },
  {
    key: 'Ledger', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Ledger', href: '/accounts/ledger' }],
  },
  {
    key: 'Payments', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [
      { name: 'Payments', href: '/accounts/payments' },
      { name: 'Receipts', href: '/accounts/receipts' },
    ],
  },
  {
    key: 'Cash & Bank', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Cash & Bank', href: '/accounts/cash-bank' }],
  },
  {
    key: 'Vouchers', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [
      { name: 'Journal',            href: '/accounts/journal' },
      { name: 'Contra',             href: '/accounts/contra' },
      { name: 'Credit/Debit Notes', href: '/accounts/notes' },
    ],
  },
  {
    key: 'Books', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [
      { name: 'Day Book',      href: '/accounts/day-book' },
      { name: 'Cash Book',     href: '/accounts/cash-book' },
      { name: 'Bank Book',     href: '/accounts/bank-book' },
      { name: 'Trial Balance', href: '/accounts/trial-balance' },
    ],
  },
  {
    key: 'Expenses', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Expenses', href: '/accounts/expenses' }],
  },
  {
    key: 'GST Summary', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'GST Summary', href: '/accounts/gst' }],
  },
  {
    key: 'GST Returns', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'GST Returns', href: '/accounts/gst-returns' }],
  },
  {
    key: 'Reconciliation', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Reconciliation', href: '/accounts/reconciliation' }],
  },
  {
    key: 'Reports', permSegment: 'Accounts', permGroup: 'Accounts',
    navGroup: 'Accounts',
    navEntries: [{ name: 'Reports', href: '/reports/sales', matchPrefix: '/reports' }],
  },

  // ── Dashboard (standalone top-level in accounts sidebar) ─────────────────
  {
    key: 'Dashboard', permSegment: 'Accounts', permGroup: 'Dashboard',
    navGroup: '__standalone__',
    navEntries: [{ name: 'Dashboard', href: '/' }],
    icon: LayoutDashboard,
  },

  // ── Company ───────────────────────────────────────────────────────────────
  {
    key: 'Settings', permSegment: 'Accounts', permGroup: 'Company',
    navGroup: 'Company',
    navEntries: [
      { name: 'Settings',        href: '/company/settings' },
      { name: 'Company Profile', href: '/company/profile' },
      { name: 'Audit Log',       href: '/company/audit' },
    ],
  },
  {
    key: 'Permissions', permSegment: 'Accounts', permGroup: 'Company',
    navGroup: 'Company',
    navEntries: [{ name: 'Permissions', href: '/company/permissions' }],
  },
  {
    key: 'Login History', permSegment: 'Accounts', permGroup: 'Company',
    navGroup: 'Company',
    navEntries: [{ name: 'Login History', href: '/company/login-history' }],
  },
];

// ── Derived exports ───────────────────────────────────────────────────────────

/** All unique permission keys in registry order (used by Permissions page) */
export const ALL_MODULE_KEYS: string[] = MODULE_REGISTRY.map(m => m.key);

// ── Permissions page segment structure ───────────────────────────────────────

export interface PermGroupDef { title: string; modules: string[] }
export interface PermSegmentDef {
  segment: string;
  description: string;
  groups: PermGroupDef[];
}

/**
 * Returns the MODULE_SEGMENTS structure consumed by the Permissions page.
 * Groups appear in the order defined by PERM_GROUP_ORDER.
 */
export function getPermissionSegments(): PermSegmentDef[] {
  // Collect module keys per segment+group, preserving PERM_GROUP_ORDER
  const data: Record<PermSegment, Record<string, string[]>> = { Sales: {}, Accounts: {} };

  for (const seg of (['Sales', 'Accounts'] as PermSegment[])) {
    for (const grp of PERM_GROUP_ORDER[seg]) {
      data[seg][grp] = [];
    }
  }
  for (const mod of MODULE_REGISTRY) {
    if (data[mod.permSegment][mod.permGroup] !== undefined) {
      data[mod.permSegment][mod.permGroup].push(mod.key);
    }
  }

  return (['Sales', 'Accounts'] as PermSegment[]).map(seg => ({
    segment: seg,
    description: SEGMENT_DESCRIPTIONS[seg],
    groups: PERM_GROUP_ORDER[seg]
      .filter(grp => data[seg][grp].length > 0)
      .map(grp => ({ title: grp, modules: data[seg][grp] })),
  }));
}

// ── Sidebar nav helpers ───────────────────────────────────────────────────────

/** Sales segment keys (used by AppLayout hasSalesAccess check) */
export const SALES_SEGMENT_MODULE_KEYS: string[] = MODULE_REGISTRY
  .filter(m => m.permSegment === 'Sales')
  .map(m => m.key);

export interface SalesNavItemDef {
  name: string;
  icon: LucideIcon;
  href: string;
  module: string;
}

/**
 * Returns the flat sales-segment nav items (with icons).
 * Only entries that belong to the __sales__ navGroup are included.
 */
export function getSalesNavItems(): SalesNavItemDef[] {
  return MODULE_REGISTRY
    .filter(m => m.navGroup === '__sales__')
    .flatMap(m =>
      m.navEntries
        .filter(e => !e.navGroup) // entries without navGroup override stay in sales
        .map(e => ({ name: e.name, icon: m.icon!, href: e.href, module: m.key }))
    );
}

export interface AccountsNavChildDef {
  name: string;
  href: string;
  module: string;
  matchPrefix?: string;
}

/**
 * A single item in the accounts-segment sidebar.
 * Standalone items have `href`; grouped sections have `children`.
 * Both fields are optional so AppLayout can use duck-typing narrowing
 * (`if (item.href)` / `if (item.children)`) without TypeScript complaints.
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
 * Returns the grouped accounts-segment nav sections.
 * Sections appear in NAV_GROUP_ORDER order.
 */
export function getAccountsNavGroups(): AccountsNavGroupDef[] {
  const groupMap = new Map<string, AccountsNavChildDef[]>();
  for (const groupName of NAV_GROUP_ORDER) groupMap.set(groupName, []);

  for (const mod of MODULE_REGISTRY) {
    for (const entry of mod.navEntries) {
      const group = entry.navGroup ?? mod.navGroup;
      if (groupMap.has(group)) {
        groupMap.get(group)!.push({
          name:  entry.name,
          href:  entry.href,
          module: mod.key,
          ...(entry.matchPrefix ? { matchPrefix: entry.matchPrefix } : {}),
        });
      }
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
