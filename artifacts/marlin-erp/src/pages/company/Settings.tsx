import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { usePermission } from '@/lib/usePermission';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Settings2, Save, Loader2, Bell, Receipt, DollarSign, Globe, Store, ScanBarcode, Trash2, TriangleAlert, CalendarRange, CalendarOff, FileText, Plus, ShieldCheck, ShieldOff, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { customFetch } from '@workspace/api-client-react';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/app/page-header';

interface SettingGroup {
  icon: React.ElementType;
  title: string;
  description: string;
  settings: Setting[];
}

interface Setting {
  key: string;
  label: string;
  type: 'toggle' | 'text' | 'select' | 'number';
  /** Plain strings store as-is; {value,label} pairs store the value and show the label. */
  options?: Array<string | { value: string; label: string }>;
  defaultValue: any;
  /** Shown under the label — for settings whose consequences aren't obvious. */
  description?: string;
}

const SETTING_GROUPS: SettingGroup[] = [
  {
    icon: Receipt,
    title: 'Invoice & Billing',
    description: 'Invoice numbering, tax defaults, and payment terms',
    settings: [
      { key: 'invoicePrefix', label: 'Invoice Prefix', type: 'text', defaultValue: 'INV' },
      { key: 'defaultTaxRate', label: 'Default GST Rate (%)', type: 'number', defaultValue: 18 },
      { key: 'paymentTermsDays', label: 'Payment Terms (days)', type: 'number', defaultValue: 30 },
      { key: 'showTaxBreakdown', label: 'Show CGST/SGST Breakdown', type: 'toggle', defaultValue: true },
      { key: 'autoGenerateInvoice', label: 'Auto-generate Invoice on Sale', type: 'toggle', defaultValue: true },
    ],
  },
  {
    icon: DollarSign,
    title: 'Payroll',
    description: 'Salary cycle and working-hours settings',
    settings: [
      // PF and ESI deliberately live in their own section below, not here.
      // This group is a preferences blob; payroll computes contributions from
      // dedicated fields, so a toggle here would look authoritative and change
      // nothing.
      { key: 'salaryDay', label: 'Salary Credit Day', type: 'number', defaultValue: 28 },
      { key: 'fullDayHours', label: 'Full-Day Work Hours', type: 'number', defaultValue: 9 },
      { key: 'halfDayHours', label: 'Half-Day Work Hours', type: 'number', defaultValue: 4.5 },
      // Company-wide leave policy (Aug 2026): one day of salary = monthly
      // salary ÷ working days; casual leave is paid up to the monthly
      // allowance, beyond it each leave day is deducted as Loss of Pay.
      { key: 'payrollWorkingDays', label: 'Working Days Per Month', type: 'number', defaultValue: 30 },
      { key: 'paidCasualLeavesPerMonth', label: 'Paid Casual Leaves Per Month', type: 'number', defaultValue: 4 },
      { key: 'paidSickLeavesPerMonth', label: 'Paid Sick Leaves Per Month', type: 'number', defaultValue: 0 },
      { key: 'lopEnabled', label: 'Enable Loss of Pay (LOP)', type: 'toggle', defaultValue: true },
      {
        key: 'weeklyOffExhaustedAction', label: 'Weekly Off When Casual Leave Is Exhausted', type: 'select',
        defaultValue: 'ask',
        description: 'For weekly offs that deduct a casual leave: what happens when the month\u2019s casual leaves are used up. Either way the extra day is unpaid \u2014 this only controls whether Fix Attendance asks first.',
        options: [
          { value: 'ask', label: 'Ask before saving' },
          { value: 'absent', label: 'Save as unpaid without asking' },
        ],
      },
    ],
  },
  {
    icon: Bell,
    title: 'Notifications',
    description: 'Alerts and reminders',
    settings: [
      { key: 'lowStockAlert', label: 'Low Stock Alerts', type: 'toggle', defaultValue: true },
      { key: 'lowStockThreshold', label: 'Low Stock Threshold (units)', type: 'number', defaultValue: 50 },
      { key: 'leaveApprovalNotify', label: 'Leave Approval Notifications', type: 'toggle', defaultValue: true },
      { key: 'payrollDueNotify', label: 'Payroll Due Reminders', type: 'toggle', defaultValue: true },
    ],
  },
  {
    icon: ScanBarcode,
    title: 'Point of Sale',
    description: 'Which entry controls cashiers see when billing',
    settings: [
      {
        key: 'posDiscountsEnabled',
        label: 'Enable Discounts',
        type: 'toggle',
        defaultValue: true,
        description:
          'Shows the per-item and bill-level discount fields at the POS. Turning this off hides them for new sales and blocks new discounts server-side — invoices already carrying a discount keep it, unchanged, everywhere they are shown.',
      },
      {
        key: 'posCouponsEnabled',
        label: 'Enable Coupon Codes',
        type: 'toggle',
        defaultValue: true,
        description:
          'Shows the coupon-code field at the POS. Independent of the discount setting. Turning this off hides it for new sales and blocks new coupons server-side — past sales that used a coupon keep showing it.',
      },
      {
        key: 'defaultSalesPaymentMode',
        label: 'Default Sales Payment Mode',
        type: 'select',
        options: [
          { value: 'credit', label: 'Credit (Pay Later)' },
          { value: 'cash', label: 'Cash' },
        ],
        defaultValue: 'credit',
        description:
          'The payment mode a new sale opens with at the POS. The cashier can still change it on each sale. Applies to new sales only — existing invoices are never touched.',
      },
    ],
  },
  {
    icon: Store,
    title: 'Location Structure',
    description: 'Which kinds of business location this company operates',
    settings: [
      {
        key: 'outletsEnabled',
        label: 'Outlet Management',
        type: 'toggle',
        defaultValue: false,
        description:
          'Off by default: the business runs on Head Office and Warehouses only. Existing outlets stay fully visible in reports, audits and past transactions, but no outlet can be created, edited, deleted, sold from or transferred to. Turning this on reactivates outlets immediately — nothing in your data is changed either way.',
      },
    ],
  },
  {
    icon: Upload,
    title: 'Data Import',
    description: 'How Excel imports handle messy legacy data (Company → Import Data)',
    settings: [
      {
        key: 'importAutoCreateCustomers',
        label: 'Auto-create Unknown Customers',
        type: 'toggle',
        defaultValue: true,
        description:
          'A customer name in a sales import that is not in your masters is created automatically (with its ledger) when you press Import. Turn off to review and create such names by hand in the resolve step instead.',
      },
      {
        key: 'importAutoCreateVendors',
        label: 'Auto-create Unknown Vendors',
        type: 'toggle',
        defaultValue: true,
        description:
          'Same as above, for vendor names in purchase imports.',
      },
      {
        key: 'importAutoWalkInCustomer',
        label: 'Blank Customer = Walk-in Sale',
        type: 'toggle',
        defaultValue: true,
        description:
          'A sales row with no customer name and a Cash/Bank/UPI payment is recorded as a walk-in counter sale (no customer on the bill), like a POS cash sale. Credit sales always need a customer. Turn off to make a blank customer an error.',
      },
      {
        key: 'importMrpToDiscount',
        label: 'Record Below-MRP Prices as Discounts',
        type: 'toggle',
        defaultValue: true,
        description:
          'A sale price below the Item Master MRP is recorded like the POS: MRP stays and the difference becomes a per-unit discount — the customer\'s net price is unchanged. Turn off to make below-MRP prices an error.',
      },
      {
        key: 'importDetectLineTotal',
        label: 'Work Out Price from Line Total',
        type: 'toggle',
        defaultValue: true,
        description:
          'When a row has a Line Total but no unit price, the price is worked out as Line Total ÷ Qty. When both are given they are cross-checked and mismatches flagged. Turn off to ignore Line Total columns.',
      },
    ],
  },
  {
    icon: Globe,
    title: 'Regional',
    description: 'Locale, timezone, and currency settings',
    settings: [
      { key: 'currency', label: 'Currency', type: 'select', options: ['INR', 'USD', 'EUR'], defaultValue: 'INR' },
      { key: 'timezone', label: 'Timezone', type: 'select', options: ['Asia/Kolkata', 'UTC', 'America/New_York'], defaultValue: 'Asia/Kolkata' },
      { key: 'dateFormat', label: 'Date Format', type: 'select', options: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'], defaultValue: 'DD/MM/YYYY' },
    ],
  },
];

function getDefaults() {
  const init: Record<string, any> = {};
  SETTING_GROUPS.forEach(g => g.settings.forEach(s => (init[s.key] = s.defaultValue)));
  return init;
}

// ─── Financial Year & Voucher Numbering (server-persisted) ───────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const VOUCHER_PREFIX_FIELDS = [
  { key: 'payment',     label: 'Payment',     def: 'PAY' },
  { key: 'receipt',     label: 'Receipt',     def: 'REC' },
  { key: 'journal',     label: 'Journal',     def: 'JV'  },
  { key: 'contra',      label: 'Contra',      def: 'CTR' },
  { key: 'credit_note', label: 'Credit Note', def: 'CN'  },
  { key: 'debit_note',  label: 'Debit Note',  def: 'DN'  },
];

function currentFyLabel(fyStartMonth: number): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const startYear = month >= fyStartMonth ? year : year - 1;
  if (fyStartMonth === 1) return String(startYear);
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function FinancialYearSection({ canEdit }: { canEdit: boolean }) {
  const [fyStartMonth, setFyStartMonth] = useState(4);
  const [prefixes, setPrefixes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    customFetch<any>('/api/company/settings')
      .then(s => {
        setFyStartMonth(Number(s?.fyStartMonth ?? 4) || 4);
        setPrefixes((s?.voucherPrefixes && typeof s.voucherPrefixes === 'object') ? s.voucherPrefixes : {});
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const cleanPrefixes: Record<string, string> = {};
      for (const f of VOUCHER_PREFIX_FIELDS) {
        const v = (prefixes[f.key] ?? '').trim().toUpperCase();
        if (v && v !== f.def) cleanPrefixes[f.key] = v;
      }
      await customFetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fyStartMonth, voucherPrefixes: cleanPrefixes }),
      });
      toast.success('Financial year settings saved');
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const fyLabel = currentFyLabel(fyStartMonth);
  const sample = `${(prefixes.journal || 'JV').toUpperCase()}/${fyLabel}/0001`;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><CalendarRange className="w-4 h-4 text-primary" /></div>
        <div>
          <h3 className="font-semibold">Financial Year & Voucher Numbering</h3>
          <p className="text-xs text-muted-foreground">Vouchers are numbered per financial year, e.g. {sample}</p>
        </div>
      </div>
      {loading ? (
        <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="divide-y divide-border">
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Financial Year starts in</label>
              <p className="text-xs text-muted-foreground mt-0.5">Current FY: <span className="font-mono font-semibold text-foreground">{fyLabel}</span></p>
            </div>
            <Select value={String(fyStartMonth)} onValueChange={v => setFyStartMonth(Number(v))}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i + 1)}>{m}{i + 1 === 4 ? ' (Indian FY)' : i + 1 === 1 ? ' (Calendar year)' : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="p-4 space-y-3">
            <label className="text-sm font-medium">Voucher prefixes</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {VOUCHER_PREFIX_FIELDS.map(f => (
                <div key={f.key} className="space-y-1">
                  <span className="text-xs text-muted-foreground">{f.label}</span>
                  <Input
                    value={prefixes[f.key] ?? ''}
                    placeholder={f.def}
                    maxLength={6}
                    className="font-mono uppercase"
                    onChange={e => setPrefixes(prev => ({ ...prev, [f.key]: e.target.value.toUpperCase() }))}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Leave blank to use the defaults. Changing a prefix affects new vouchers only — existing numbers stay as they are.</p>
          </div>
          <div className="p-4 flex justify-end">
            {canEdit && (
            <Button onClick={save} disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save FY Settings</>}
            </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Invoice PDF: payment terms & footer (server-persisted) ──────────────────

function InvoicePdfSection({ canEdit }: { canEdit: boolean }) {
  const [paymentTerms, setPaymentTerms] = useState('');
  const [invoiceFooter, setInvoiceFooter] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    customFetch<any>('/api/company/settings')
      .then(s => {
        setPaymentTerms(typeof s?.paymentTerms === 'string' ? s.paymentTerms : '');
        setInvoiceFooter(typeof s?.invoiceFooter === 'string' ? s.invoiceFooter : '');
      })
      .catch(() => { /* keep empty */ })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await customFetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentTerms: paymentTerms.trim() || null,
          invoiceFooter: invoiceFooter.trim() || null,
        }),
      });
      toast.success('Invoice PDF settings saved');
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><FileText className="w-4 h-4 text-primary" /></div>
        <div>
          <h3 className="font-semibold">Invoice PDF</h3>
          <p className="text-xs text-muted-foreground">Payment terms and footer text printed on every sales invoice</p>
        </div>
      </div>
      {loading ? (
        <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="divide-y divide-border">
          <div className="p-4 space-y-2">
            <label className="text-sm font-medium">Payment terms</label>
            <Textarea
              rows={3}
              value={paymentTerms}
              placeholder="e.g. Payment due within 15 days of invoice date. 2% late fee per month thereafter."
              onChange={e => setPaymentTerms(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Shown in a “Payment Terms” box below the payment details. Leave blank to omit.</p>
          </div>
          <div className="p-4 space-y-2">
            <label className="text-sm font-medium">Invoice footer</label>
            <Textarea
              rows={2}
              value={invoiceFooter}
              placeholder="e.g. Goods once sold will not be taken back without a return authorization."
              onChange={e => setInvoiceFooter(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Printed under the “Thank You” bar at the bottom of the invoice. Leave blank to omit.</p>
          </div>
          <div className="p-4 flex justify-end">
            {canEdit && (
            <Button onClick={save} disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save Invoice Settings</>}
            </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Production costing: default overhead % (server-persisted) ───────────────

// ─── Statutory payroll: PF & ESI (server-persisted) ──────────────────────────
//
// Company-wide by design. PF and ESI are obligations of the establishment, not
// a per-employee arrangement, so the rate is set once here and every payroll run
// reads it. The percentages are editable because statutory rates change, and
// each payroll row keeps a snapshot of the rates it was computed with — so
// changing a rate here affects future runs only and never rewrites history.

function StatutoryPayrollSection({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState({
    pfEnabled: true, pfEmployeePercent: '12', pfEmployerPercent: '12',
    esiEnabled: true, esiEmployeePercent: '0.75', esiEmployerPercent: '3.25',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    customFetch<any>('/api/company/settings')
      .then(r => setS({
        pfEnabled: r?.pfEnabled !== false,
        pfEmployeePercent: String(Number(r?.pfEmployeePercent ?? 12)),
        pfEmployerPercent: String(Number(r?.pfEmployerPercent ?? 12)),
        esiEnabled: r?.esiEnabled !== false,
        esiEmployeePercent: String(Number(r?.esiEmployeePercent ?? 0.75)),
        esiEmployerPercent: String(Number(r?.esiEmployerPercent ?? 3.25)),
      }))
      .catch(() => { /* keep statutory defaults */ })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const nums: [string, string][] = [
      ['pfEmployeePercent', s.pfEmployeePercent], ['pfEmployerPercent', s.pfEmployerPercent],
      ['esiEmployeePercent', s.esiEmployeePercent], ['esiEmployerPercent', s.esiEmployerPercent],
    ];
    for (const [, raw] of nums) {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        toast.error('Contribution rates must be between 0 and 100 percent');
        return;
      }
    }
    setSaving(true);
    try {
      await customFetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pfEnabled: s.pfEnabled,
          pfEmployeePercent: Number(s.pfEmployeePercent),
          pfEmployerPercent: Number(s.pfEmployerPercent),
          esiEnabled: s.esiEnabled,
          esiEmployeePercent: Number(s.esiEmployeePercent),
          esiEmployerPercent: Number(s.esiEmployerPercent),
        }),
      });
      toast.success('Statutory settings saved — they apply to future payroll runs');
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const pctRow = (
    label: string, hint: string,
    key: 'pfEmployeePercent' | 'pfEmployerPercent' | 'esiEmployeePercent' | 'esiEmployerPercent',
    disabled: boolean,
  ) => (
    <div className="p-4 flex items-center justify-between gap-4">
      <div className="flex-1">
        <label className="text-sm font-medium">{label}</label>
        <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
      </div>
      <Input
        type="number" min={0} max={100} step="0.05"
        value={s[key]}
        disabled={disabled}
        onChange={e => setS(p => ({ ...p, [key]: e.target.value }))}
        className="w-28 font-mono"
      />
    </div>
  );

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><ShieldCheck className="w-4 h-4 text-primary" /></div>
        <div>
          <h3 className="font-semibold">Statutory Payroll — PF &amp; ESI</h3>
          <p className="text-xs text-muted-foreground">Contribution rates used by every payroll run. Changes apply to future runs only.</p>
        </div>
      </div>
      {loading ? (
        <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="divide-y divide-border">
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Provident Fund (PF)</label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Employee share is deducted from salary; employer share is an additional company cost.
              </p>
            </div>
            <Switch checked={s.pfEnabled} onCheckedChange={v => setS(p => ({ ...p, pfEnabled: v }))} />
          </div>
          {pctRow('PF — employee share (%)', 'Deducted from the employee’s gross pay.', 'pfEmployeePercent', !s.pfEnabled)}
          {pctRow('PF — employer share (%)', 'Paid by the company on top of salary. Posted as an expense.', 'pfEmployerPercent', !s.pfEnabled)}

          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Employees’ State Insurance (ESI)</label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Statutory medical insurance. Same split: employee share deducted, employer share a company cost.
              </p>
            </div>
            <Switch checked={s.esiEnabled} onCheckedChange={v => setS(p => ({ ...p, esiEnabled: v }))} />
          </div>
          {pctRow('ESI — employee share (%)', 'Deducted from the employee’s gross pay.', 'esiEmployeePercent', !s.esiEnabled)}
          {pctRow('ESI — employer share (%)', 'Paid by the company on top of salary. Posted as an expense.', 'esiEmployerPercent', !s.esiEnabled)}

          <div className="p-4 flex justify-end">
            {canEdit && (
            <Button onClick={save} disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save Statutory Settings</>}
            </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProductionCostingSection({ canEdit }: { canEdit: boolean }) {
  const [overheadPct, setOverheadPct] = useState('0');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    customFetch<any>('/api/company/settings')
      .then(s => setOverheadPct(String(Number(s?.productionOverheadPercent ?? 0))))
      .catch(() => { /* keep default */ })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const v = Number(overheadPct);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      toast.error('Overhead % must be between 0 and 100');
      return;
    }
    setSaving(true);
    try {
      await customFetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productionOverheadPercent: v }),
      });
      toast.success('Production costing settings saved');
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><DollarSign className="w-4 h-4 text-primary" /></div>
        <div>
          <h3 className="font-semibold">Production Costing</h3>
          <p className="text-xs text-muted-foreground">Default overhead applied on top of material cost for new production batches</p>
        </div>
      </div>
      {loading ? (
        <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="divide-y divide-border">
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Default overhead (%)</label>
              <p className="text-xs text-muted-foreground mt-0.5">Covers indirect costs like power, labor, and rent. Each batch can override it at entry time.</p>
            </div>
            <Input
              type="number" min={0} max={100} step="0.5"
              value={overheadPct}
              onChange={e => setOverheadPct(e.target.value)}
              className="w-28 font-mono"
            />
          </div>
          <div className="p-4 flex justify-end">
            {canEdit && (
            <Button onClick={save} disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save Costing Settings</>}
            </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GST transfer invoicing (server-persisted) ───────────────────────────────
//
// Deliberately a single on/off switch for the whole module. Whether a transfer
// is taxable is decided automatically from the two GSTINs — same GSTIN is a
// stock movement, different GSTIN in the same state is CGST+SGST, different
// state is IGST. Letting anyone choose per transfer would mean choosing whether
// to follow tax law, so that choice is not offered.

function GstTransferSection({ canEdit }: { canEdit: boolean }) {
  const [enabled, setEnabled] = useState(true);
  const [prefix, setPrefix] = useState('BTR');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    customFetch<any>('/api/company/settings')
      .then(s => {
        setEnabled(s?.gstTransferInvoicing !== false);
        setPrefix(String(s?.branchTransferPrefix ?? 'BTR'));
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const p = prefix.trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,10}$/.test(p)) {
      toast.error('Invoice prefix must be 1–10 letters, digits or hyphens');
      return;
    }
    setSaving(true);
    try {
      await customFetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gstTransferInvoicing: enabled, branchTransferPrefix: p }),
      });
      setPrefix(p);
      toast.success('GST transfer settings saved');
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><FileText className="w-4 h-4 text-primary" /></div>
        <div>
          <h3 className="font-semibold">GST Transfer Invoicing</h3>
          <p className="text-xs text-muted-foreground">Tax invoices for stock moved between two of your own GST numbers</p>
        </div>
      </div>
      {loading ? (
        <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="divide-y divide-border">
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Raise tax invoices for cross-GSTIN transfers</label>
              <p className="text-xs text-muted-foreground mt-0.5">
                A transfer between two different GST numbers is a taxable supply. With this on, each one raises a
                tax invoice at the sending location and a purchase invoice at the receiving location, so the supply
                appears in GSTR-1 and GSTR-3B. Transfers within the same GST number are never taxed.
              </p>
              <p className="text-xs text-amber-600 mt-1.5">
                Turning this off keeps your books balanced but leaves cross-GSTIN transfers out of your GST returns.
                Transfers already invoiced are not affected.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Transfer invoice prefix</label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Transfer invoices use their own numbering series so they don't leave gaps in your customer invoice
                register. Current format: <span className="font-mono">{prefix || 'BTR'}/2025-26/0001</span>
              </p>
            </div>
            <Input
              value={prefix}
              onChange={e => setPrefix(e.target.value)}
              maxLength={10}
              className="w-28 font-mono uppercase"
            />
          </div>
          <div className="p-4 flex justify-end">
            {canEdit && (
            <Button onClick={save} disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save GST Transfer Settings</>}
            </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Security: password policy (server-persisted) ────────────────────────────

const POLICY_TOGGLES = [
  { key: 'passwordRequireUppercase', label: 'Require an uppercase letter', hint: 'At least one A–Z character' },
  { key: 'passwordRequireNumber',    label: 'Require a number',            hint: 'At least one 0–9 digit' },
  { key: 'passwordRequireSpecial',   label: 'Require a special character', hint: 'e.g. ! @ # $ % &' },
] as const;

function SecuritySection({ canEdit }: { canEdit: boolean }) {
  const [minLength, setMinLength] = useState('8');
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    customFetch<any>('/api/company/settings')
      .then(s => {
        setMinLength(String(Number(s?.passwordMinLength ?? 8) || 8));
        setFlags({
          passwordRequireUppercase: !!s?.passwordRequireUppercase,
          passwordRequireNumber: !!s?.passwordRequireNumber,
          passwordRequireSpecial: !!s?.passwordRequireSpecial,
        });
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const v = Number(minLength);
    if (!Number.isInteger(v) || v < 6 || v > 32) {
      toast.error('Minimum length must be between 6 and 32');
      return;
    }
    setSaving(true);
    try {
      await customFetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passwordMinLength: v,
          passwordRequireUppercase: !!flags.passwordRequireUppercase,
          passwordRequireNumber: !!flags.passwordRequireNumber,
          passwordRequireSpecial: !!flags.passwordRequireSpecial,
        }),
      });
      toast.success('Password policy saved — applies when users change their password');
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><ShieldCheck className="w-4 h-4 text-primary" /></div>
        <div>
          <h3 className="font-semibold">Security — Password Policy</h3>
          <p className="text-xs text-muted-foreground">Rules enforced when employees choose a new password. Admin-issued starter passwords are exempt.</p>
        </div>
      </div>
      {loading ? (
        <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="divide-y divide-border">
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">Minimum password length</label>
              <p className="text-xs text-muted-foreground mt-0.5">Between 6 and 32 characters</p>
            </div>
            <Input
              type="number" min={6} max={32}
              value={minLength}
              onChange={e => setMinLength(e.target.value)}
              className="w-28 font-mono"
            />
          </div>
          {POLICY_TOGGLES.map(t => (
            <div key={t.key} className="p-4 flex items-center justify-between gap-4">
              <div className="flex-1">
                <label className="text-sm font-medium">{t.label}</label>
                <p className="text-xs text-muted-foreground mt-0.5">{t.hint}</p>
              </div>
              <Switch
                checked={!!flags[t.key]}
                onCheckedChange={v => setFlags(prev => ({ ...prev, [t.key]: v }))}
              />
            </div>
          ))}
          <div className="p-4 flex justify-end">
            {canEdit && (
            <Button onClick={save} disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save Password Policy</>}
            </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Weekly offs editor ───────────────────────────────────────────────────────
// Part of the Payroll leave policy: each rule is a weekday, which occurrences
// of it in the month it covers (every week, or picked weeks like "2nd Saturday"),
// and whether the day is paid outright or deducts a casual leave. Stored on the
// same general-settings blob as the rest of this page, so it saves with the
// main Save Settings button.
interface WeeklyOffRuleValue {
  day: number;
  weeks: 'all' | number[];
  policy: 'paid' | 'casual_leave';
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

function WeeklyOffsEditor({ rules, onChange }: {
  rules: WeeklyOffRuleValue[];
  onChange: (rules: WeeklyOffRuleValue[]) => void;
}) {
  const update = (i: number, patch: Partial<WeeklyOffRuleValue>) =>
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const toggleWeek = (i: number, week: number) => {
    const r = rules[i];
    const current = r.weeks === 'all' ? [] : r.weeks;
    const next = current.includes(week) ? current.filter(w => w !== week) : [...current, week].sort();
    // Deselecting the last picked week flips back to every week rather than
    // leaving a rule that matches nothing.
    update(i, { weeks: next.length === 0 ? 'all' : next });
  };

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><CalendarOff className="w-4 h-4 text-primary" /></div>
        <div>
          <h3 className="font-semibold">Weekly Offs</h3>
          <p className="text-xs text-muted-foreground">Company off days — e.g. every Sunday, or the 2nd and 4th Saturday. Paid offs cost nothing; the other kind deducts one casual leave.</p>
        </div>
      </div>
      <div className="divide-y divide-border">
        {rules.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No weekly offs configured — every day of the week is a working day.</p>
        )}
        {rules.map((r, i) => (
          <div key={i} className="p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={String(r.day)} onValueChange={v => update(i, { day: Number(v) })}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WEEKDAY_NAMES.map((n, d) => <SelectItem key={d} value={String(d)}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={r.policy} onValueChange={v => update(i, { policy: v as WeeklyOffRuleValue['policy'] })}>
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid">Paid off (no leave used)</SelectItem>
                  <SelectItem value="casual_leave">Deducts one casual leave</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost" size="icon"
                aria-label={`Remove ${WEEKDAY_NAMES[r.day]} weekly off`}
                onClick={() => onChange(rules.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground mr-1">Applies to:</span>
              <Button
                type="button" size="sm"
                variant={r.weeks === 'all' ? 'default' : 'outline'}
                onClick={() => update(i, { weeks: 'all' })}
              >
                Every week
              </Button>
              {WEEK_ORDINALS.map((label, idx) => {
                const week = idx + 1;
                const active = r.weeks !== 'all' && r.weeks.includes(week);
                return (
                  <Button
                    key={week} type="button" size="sm"
                    variant={active ? 'default' : 'outline'}
                    onClick={() => toggleWeek(i, week)}
                  >
                    {label}
                  </Button>
                );
              })}
              <span className="text-xs text-muted-foreground ml-1">
                {r.weeks === 'all'
                  ? `Every ${WEEKDAY_NAMES[r.day]}`
                  : `${r.weeks.map(w => WEEK_ORDINALS[w - 1]).join(', ')} ${WEEKDAY_NAMES[r.day]} of the month`}
              </span>
            </div>
          </div>
        ))}
        <div className="p-4">
          <Button
            type="button" variant="outline" size="sm"
            onClick={() => onChange([...rules, { day: 0, weeks: 'all', policy: 'paid' }])}
          >
            <Plus className="w-4 h-4 mr-1" /> Add Weekly Off
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const perm = usePermission('page:/company/settings');
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, any>>(getDefaults);
  const [loadingGeneral, setLoadingGeneral] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Load general settings from the server on mount
  useEffect(() => {
    customFetch<any>('/api/company/settings')
      .then(s => {
        const stored = s?.generalSettings;
        if (stored && typeof stored === 'object') {
          setValues(prev => ({ ...prev, ...stored }));
        }
      })
      .catch(() => { /* keep defaults */ })
      .finally(() => setLoadingGeneral(false));
  }, []);

  const set = (key: string, val: any) => setValues(prev => ({ ...prev, [key]: val }));

  const save = async () => {
    setSaving(true);
    try {
      await customFetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generalSettings: values }),
      });
      // Location Structure lives in this payload, so the sidebar, route guard
      // and every location dropdown must re-read it now rather than up to a
      // minute later when the flags query goes stale on its own.
      await queryClient.invalidateQueries({ queryKey: ['company', 'feature-flags'] });
      toast.success('Settings saved');
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await customFetch('/api/company/reset', { method: 'POST' });
      toast.success('All company data has been cleared. You can now start fresh.');
      setShowResetConfirm(false);
    } catch (e: any) {
      toast.error(e?.data?.error || e.message || 'Reset failed. Please try again.');
    } finally {
      setResetting(false);
    }
  };

  if (!perm.isLoading && !perm.canView) {
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
      <div className="space-y-6 max-w-3xl">
        <PageHeader
          title="Settings"
          description="Configure billing, payroll, notifications, and regional preferences"
          icon={Settings2}
        />

        {SETTING_GROUPS.map(group => (
          <div key={group.title} className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><group.icon className="w-4 h-4 text-primary" /></div>
              <div>
                <h3 className="font-semibold">{group.title}</h3>
                <p className="text-xs text-muted-foreground">{group.description}</p>
              </div>
            </div>
            {loadingGeneral ? (
              <div className="p-6 flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : (
              <div className="divide-y divide-border">
                {group.settings.map(setting => (
                  <div key={setting.key} className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <label className="text-sm font-medium">{setting.label}</label>
                      {setting.description && (
                        <p className="text-xs text-muted-foreground mt-1 max-w-lg">{setting.description}</p>
                      )}
                    </div>
                    {setting.type === 'toggle' && (
                      <Switch checked={!!values[setting.key]} onCheckedChange={v => set(setting.key, v)} />
                    )}
                    {setting.type === 'text' && (
                      <Input value={values[setting.key] || ''} onChange={e => set(setting.key, e.target.value)} className="w-40" />
                    )}
                    {setting.type === 'number' && (
                      <Input type="number" value={values[setting.key] || 0} onChange={e => set(setting.key, Number(e.target.value))} className="w-28 font-mono" />
                    )}
                    {setting.type === 'select' && (
                      <Select value={String(values[setting.key])} onValueChange={v => set(setting.key, v)}>
                        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>{setting.options?.map(o => {
                          const opt = typeof o === 'string' ? { value: o, label: o } : o;
                          return <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>;
                        })}</SelectContent>
                      </Select>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Weekly offs are part of the same general-settings blob, so this
            editor saves through the same Save Settings button below. */}
        {!loadingGeneral && (
          <WeeklyOffsEditor
            rules={Array.isArray(values.weeklyOffs) ? values.weeklyOffs : []}
            onChange={(rules) => set('weeklyOffs', rules)}
          />
        )}

        {perm.canEdit && (
        <div className="flex justify-end">
          <Button size="lg" onClick={save} disabled={saving || loadingGeneral}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save Settings</>}
          </Button>
        </div>
        )}

        {/* ── Financial Year & Voucher Numbering (server-persisted) ────────── */}
        <FinancialYearSection canEdit={perm.canEdit} />

        {/* ── Invoice PDF: payment terms & footer (server-persisted) ───────── */}
        <InvoicePdfSection canEdit={perm.canEdit} />

        {/* ── Production costing: default overhead % (server-persisted) ────── */}
        <StatutoryPayrollSection canEdit={perm.canEdit} />

        <ProductionCostingSection canEdit={perm.canEdit} />

        {/* ── GST transfer invoicing (server-persisted) ────────────────────── */}
        <GstTransferSection canEdit={perm.canEdit} />

        {/* ── Security: password policy (server-persisted) ─────────────────── */}
        <SecuritySection canEdit={perm.canEdit} />

        {/* ── Danger Zone ──────────────────────────────────────────────────── */}
        {perm.canDelete && (
        <div className="border border-destructive/40 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-destructive/30 bg-destructive/5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-destructive/10 flex items-center justify-center">
              <TriangleAlert className="w-4 h-4 text-destructive" />
            </div>
            <div>
              <h3 className="font-semibold text-destructive">Danger Zone</h3>
              <p className="text-xs text-muted-foreground">Irreversible actions — proceed with caution</p>
            </div>
          </div>
          <div className="p-5 flex items-center justify-between gap-6">
            <div>
              <p className="text-sm font-medium">Reset All Company Data</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permanently deletes all sales, purchases, customers, stock entries, production batches, payroll, and attendance records.
                Company profile, outlets, items, and employee accounts are kept.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => setShowResetConfirm(true)}
            >
              <Trash2 className="w-4 h-4" /> Reset Data
            </Button>
          </div>
        </div>
        )}
      </div>

      {/* Reset confirmation dialog */}
      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="w-5 h-5" /> Reset all company data?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <span className="block">This will permanently delete:</span>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>All sales and invoice history</li>
                  <li>All purchase orders</li>
                  <li>All customers</li>
                  <li>All stock entries (quantities reset to zero)</li>
                  <li>All production batches</li>
                  <li>All payroll, attendance, and leave records</li>
                  <li>Invoice sequence counter (restarts from 0001)</li>
                </ul>
                <span className="block mt-2 font-medium text-foreground">This action cannot be undone.</span>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleReset}
              disabled={resetting}
            >
              {resetting ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Resetting…</> : 'Yes, reset everything'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
