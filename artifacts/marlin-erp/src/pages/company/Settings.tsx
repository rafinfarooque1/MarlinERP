import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings2, Save, Loader2, Bell, Receipt, DollarSign, Globe } from 'lucide-react';
import { toast } from 'sonner';

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
  options?: string[];
  defaultValue: any;
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
    description: 'Salary cycle and statutory deduction settings',
    settings: [
      { key: 'salaryDay', label: 'Salary Credit Day', type: 'number', defaultValue: 28 },
      { key: 'pfEnabled', label: 'Enable PF Deduction', type: 'toggle', defaultValue: true },
      { key: 'esicEnabled', label: 'Enable ESIC Deduction', type: 'toggle', defaultValue: false },
      { key: 'pfRate', label: 'PF Rate (%)', type: 'number', defaultValue: 12 },
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

function getInitial() {
  const saved = localStorage.getItem('marlin_settings');
  if (saved) return JSON.parse(saved);
  const init: Record<string, any> = {};
  SETTING_GROUPS.forEach(g => g.settings.forEach(s => (init[s.key] = s.defaultValue)));
  return init;
}

export default function Settings() {
  const [values, setValues] = useState<Record<string, any>>(getInitial);
  const [saving, setSaving] = useState(false);

  const set = (key: string, val: any) => setValues(prev => ({ ...prev, [key]: val }));

  const save = async () => {
    setSaving(true);
    await new Promise(r => setTimeout(r, 600));
    localStorage.setItem('marlin_settings', JSON.stringify(values));
    setSaving(false);
    toast.success('Settings saved');
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Settings2 className="w-6 h-6 text-primary" /> Settings</h1>
          <p className="text-muted-foreground mt-1">Configure billing, payroll, notifications, and regional preferences</p>
        </div>

        {SETTING_GROUPS.map(group => (
          <div key={group.title} className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border bg-muted/20 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><group.icon className="w-4 h-4 text-primary" /></div>
              <div>
                <h3 className="font-semibold">{group.title}</h3>
                <p className="text-xs text-muted-foreground">{group.description}</p>
              </div>
            </div>
            <div className="divide-y divide-border">
              {group.settings.map(setting => (
                <div key={setting.key} className="p-4 flex items-center justify-between gap-4">
                  <label className="text-sm font-medium flex-1">{setting.label}</label>
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
                      <SelectContent>{setting.options?.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="flex justify-end">
          <Button size="lg" onClick={save} disabled={saving}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save Settings</>}
          </Button>
        </div>
      </div>
    </AppLayout>
  );
}
