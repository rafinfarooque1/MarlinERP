import { useState, useMemo } from 'react';
import { useListPermissions, useListHierarchies, useSetPermission, getListPermissionsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { ShieldCheck } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const MODULES = [
  'Dashboard', 'Materials', 'RawMaterials', 'Items', 'Purchases', 'Production', 
  'StockTransfers', 'Warehouses', 'Outlets', 'StockLedger', 'ItemPrices', 'Sales',
  'Hierarchy', 'Employees', 'Payroll', 'Attendance', 'Leave', 'Customers', 
  'Vendors', 'Coupons', 'ChartOfAccounts', 'Ledger', 'CashBank', 'Expenses', 
  'GstSummary', 'Settings'
];

export default function Permissions() {
  const { data: hierarchies, isLoading: loadingHierarchies } = useListHierarchies();
  const { data: permissions, isLoading: loadingPermissions } = useListPermissions();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const setPermissionMutation = useSetPermission();

  const handleToggle = (hierarchyId: number, module: string, action: 'canView' | 'canAdd' | 'canEdit' | 'canDelete' | 'canDownload', currentValue: boolean) => {
    // Find if this permission record exists
    const existing = permissions?.find(p => p.hierarchyId === hierarchyId && p.module === module);
    
    // Construct payload based on existing or default false
    const payload = {
      hierarchyId,
      module,
      canView: existing?.canView || false,
      canAdd: existing?.canAdd || false,
      canEdit: existing?.canEdit || false,
      canDelete: existing?.canDelete || false,
      canDownload: existing?.canDownload || false,
      [action]: !currentValue // toggle
    };

    setPermissionMutation.mutate({ data: payload }, {
      onSuccess: () => {
        // Optimistic update would be better here, but invalidating is safer
        queryClient.invalidateQueries({ queryKey: getListPermissionsQueryKey() });
      },
      onError: () => {
        toast({ title: 'Failed to update permission', variant: 'destructive' });
      }
    });
  };

  const isLoading = loadingHierarchies || loadingPermissions;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" /> Role Permissions
          </h1>
          <p className="text-muted-foreground mt-1">Configure module access and actions per employee role</p>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground">Loading permission matrix...</div>
        ) : !hierarchies || hierarchies.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">No roles configured. Create roles in HR &gt; Hierarchy first.</div>
        ) : (
          <div className="space-y-8">
            {hierarchies.sort((a,b) => a.level - b.level).map(role => (
              <div key={role.id} className="bg-card border border-border rounded-md shadow-sm overflow-hidden">
                <div className="p-4 bg-muted/30 border-b border-border flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold font-mono text-sm">
                    L{role.level}
                  </div>
                  <div>
                    <h3 className="font-bold text-lg leading-none">{role.name}</h3>
                    <p className="text-xs text-muted-foreground mt-1">{role.description || 'No description provided'}</p>
                  </div>
                </div>
                
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[200px]">Module</TableHead>
                        <TableHead className="text-center w-[100px]">View</TableHead>
                        <TableHead className="text-center w-[100px]">Add</TableHead>
                        <TableHead className="text-center w-[100px]">Edit</TableHead>
                        <TableHead className="text-center w-[100px]">Delete</TableHead>
                        <TableHead className="text-center w-[100px]">Download</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {MODULES.map(module => {
                        const perm = permissions?.find(p => p.hierarchyId === role.id && p.module === module);
                        return (
                          <TableRow key={`${role.id}-${module}`} className="border-b-0 hover:bg-muted/10">
                            <TableCell className="font-medium text-muted-foreground">{module.replace(/([A-Z])/g, ' $1').trim()}</TableCell>
                            <TableCell className="text-center">
                              <Checkbox 
                                checked={perm?.canView || false} 
                                onCheckedChange={() => handleToggle(role.id, module, 'canView', perm?.canView || false)}
                                disabled={setPermissionMutation.isPending}
                              />
                            </TableCell>
                            <TableCell className="text-center">
                              <Checkbox 
                                checked={perm?.canAdd || false} 
                                onCheckedChange={() => handleToggle(role.id, module, 'canAdd', perm?.canAdd || false)}
                                disabled={setPermissionMutation.isPending}
                              />
                            </TableCell>
                            <TableCell className="text-center">
                              <Checkbox 
                                checked={perm?.canEdit || false} 
                                onCheckedChange={() => handleToggle(role.id, module, 'canEdit', perm?.canEdit || false)}
                                disabled={setPermissionMutation.isPending}
                              />
                            </TableCell>
                            <TableCell className="text-center">
                              <Checkbox 
                                checked={perm?.canDelete || false} 
                                onCheckedChange={() => handleToggle(role.id, module, 'canDelete', perm?.canDelete || false)}
                                disabled={setPermissionMutation.isPending}
                              />
                            </TableCell>
                            <TableCell className="text-center">
                              <Checkbox 
                                checked={perm?.canDownload || false} 
                                onCheckedChange={() => handleToggle(role.id, module, 'canDownload', perm?.canDownload || false)}
                                disabled={setPermissionMutation.isPending}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}