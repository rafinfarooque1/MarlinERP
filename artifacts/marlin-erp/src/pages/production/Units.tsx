import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useUnits } from '@/lib/useUnits';
import { Plus, X, Ruler, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { usePermission } from '@/lib/usePermission';

export default function Units() {
  const perm = usePermission('Materials');
  const { units, addUnit, removeUnit } = useUnits();
  const [newUnit, setNewUnit] = useState('');

  const handleAdd = () => {
    const val = newUnit.trim();
    if (!val) return;
    const ok = addUnit(val);
    if (ok) { toast.success(`Unit "${val}" added`); setNewUnit(''); }
    else toast.error(`"${val}" already exists`);
  };

  const handleRemove = (unit: string) => {
    removeUnit(unit);
    toast.success(`Unit "${unit}" removed`);
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
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Ruler className="w-6 h-6 text-primary" /> Unit of Measure
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage units available when creating items, materials, and raw materials
          </p>
        </div>

        {/* Add unit */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">Add New Unit</h3>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. kg, pkt, litre..."
              value={newUnit}
              onChange={e => setNewUnit(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              className="max-w-xs"
            />
            <Button onClick={handleAdd} disabled={!newUnit.trim()}>
              <Plus className="w-4 h-4 mr-2" /> Add Unit
            </Button>
          </div>
        </div>

        {/* Units list */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">
            Current Units <span className="text-primary">({units.length})</span>
          </h3>
          {units.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">No units defined. Add one above.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {units.map(unit => (
                <div key={unit} className="flex items-center gap-1 bg-muted/40 border border-border rounded-md px-3 py-1.5">
                  <span className="font-mono text-sm font-medium">{unit}</span>
                  <button
                    onClick={() => handleRemove(unit)}
                    className="ml-1 text-muted-foreground hover:text-destructive transition-colors"
                    title={`Remove ${unit}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground pt-1">
            These units appear as dropdown options in Items, Materials, and Raw Materials forms.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
