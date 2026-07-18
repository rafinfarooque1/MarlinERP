import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Save, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const ROLES = ['Admin', 'Manager', 'Production Staff', 'Warehouse Staff', 'Sales Staff', 'Accountant', 'HR'];

const MODULE_GROUPS = [
  {
    title: 'Production',
    modules: ['Materials', 'Raw Materials', 'Items', 'Purchases', 'Production', 'Stock Transfers'],
  },
  {
    title: 'Head Office',
    modules: ['Warehouses', 'Outlets', 'Stock', 'HO Transfers', 'Item Prices', 'Sales'],
  },
  {
    title: 'HR',
    modules: ['Hierarchy', 'Employees', 'Payroll', 'Attendance', 'Leave'],
  },
  {
    title: 'Customers',
    modules: ['Customers', 'Vendors', 'Coupons'],
  },
  {
    title: 'Accounts',
    modules: ['Chart of Accounts', 'Ledger', 'Cash & Bank', 'Expenses', 'GST Summary'],
  },
  {
    title: 'Company',
    modules: ['Settings', 'Permissions', 'Profile'],
  },
];

const DEFAULT_PERMS: Record<string, Record<string, boolean>> = {
  Admin: Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, true]))),
  Manager: Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, !['Settings', 'Permissions'].includes(m)]))),
  'Production Staff': Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, g.title === 'Production']))),
  'Warehouse Staff': Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, ['Warehouses', 'Stock', 'Stock Transfers', 'HO Transfers'].includes(m)]))),
  'Sales Staff': Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, ['Sales', 'Customers', 'Coupons', 'Outlets', 'Item Prices'].includes(m)]))),
  Accountant: Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, g.title === 'Accounts' || ['Customers', 'Vendors'].includes(m)]))),
  HR: Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, g.title === 'HR']))),
};

function loadPerms() {
  const saved = localStorage.getItem('marlin_permissions');
  return saved ? JSON.parse(saved) : DEFAULT_PERMS;
}

export default function Permissions() {
  const [selectedRole, setSelectedRole] = useState('Admin');
  const [perms, setPerms] = useState<typeof DEFAULT_PERMS>(loadPerms);
  const [saving, setSaving] = useState(false);

  const toggle = (module: string) => {
    setPerms(prev => ({ ...prev, [selectedRole]: { ...prev[selectedRole], [module]: !prev[selectedRole]?.[module] } }));
  };

  const save = async () => {
    setSaving(true);
    await new Promise(r => setTimeout(r, 500));
    localStorage.setItem('marlin_permissions', JSON.stringify(perms));
    setSaving(false);
    toast.success('Permissions saved');
  };

  const rolePerms = perms[selectedRole] || {};
  const enabledCount = Object.values(rolePerms).filter(Boolean).length;
  const totalCount = MODULE_GROUPS.reduce((s, g) => s + g.modules.length, 0);

  return (
    <AppLayout>
      <div className="space-y-6 max-w-4xl">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><ShieldCheck className="w-6 h-6 text-primary" /> Permissions</h1>
            <p className="text-muted-foreground mt-1">Module access control by role</p>
          </div>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> Save</>}
          </Button>
        </div>

        {/* Role Tabs */}
        <div className="flex flex-wrap gap-2">
          {ROLES.map(role => (
            <button key={role} onClick={() => setSelectedRole(role)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-all ${selectedRole === role ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'bg-card border-border text-muted-foreground hover:text-foreground hover:border-primary/30'}`}>
              {role}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-muted-foreground">{selectedRole} has access to <span className="font-bold text-foreground">{enabledCount}</span> of {totalCount} modules</span>
          <div className="flex gap-2">
            <button onClick={() => setPerms(prev => ({ ...prev, [selectedRole]: Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, true]))) }))} className="text-xs text-primary hover:underline">Enable all</button>
            <span className="text-muted-foreground">·</span>
            <button onClick={() => setPerms(prev => ({ ...prev, [selectedRole]: Object.fromEntries(MODULE_GROUPS.flatMap(g => g.modules.map(m => [m, false]))) }))} className="text-xs text-muted-foreground hover:text-foreground hover:underline">Disable all</button>
          </div>
        </div>

        <div className="space-y-4">
          {MODULE_GROUPS.map(group => (
            <div key={group.title} className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="p-3 border-b border-border bg-muted/20 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{group.title}</h3>
                <Badge variant="outline" className="text-xs">
                  {group.modules.filter(m => rolePerms[m]).length} / {group.modules.length}
                </Badge>
              </div>
              <div className="divide-y divide-border/50">
                {group.modules.map(mod => (
                  <div key={mod} className="flex items-center justify-between px-4 py-3 hover:bg-muted/5">
                    <span className={`text-sm ${rolePerms[mod] ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{mod}</span>
                    <Switch
                      checked={!!rolePerms[mod]}
                      onCheckedChange={() => selectedRole !== 'Admin' ? toggle(mod) : toast.info('Admin always has full access')}
                      disabled={selectedRole === 'Admin'}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
