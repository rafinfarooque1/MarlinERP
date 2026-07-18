import { useState } from 'react';
import { useListStock, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, Database, Download } from 'lucide-react';

export default function Stock() {
  const [branchType, setBranchType] = useState<string>('all');
  const [branchId, setBranchId] = useState<string>('all');
  const [search, setSearch] = useState('');

  // Explicitly mapping 'all' to undefined to match the API param type
  const queryParams = {
    ...(branchType !== 'all' ? { branchType: branchType as any } : {}),
    ...(branchId !== 'all' ? { branchId: Number(branchId) } : {})
  };

  const { data: stock, isLoading } = useListStock(queryParams);
  const { data: warehouses } = useListWarehouses();
  const { data: outlets } = useListOutlets();

  const filteredStock = stock?.filter(s => 
    s.itemName?.toLowerCase().includes(search.toLowerCase()) || 
    s.hsnCode?.toLowerCase().includes(search.toLowerCase())
  ) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Database className="w-6 h-6 text-primary" /> Central Stock Ledger
            </h1>
            <p className="text-muted-foreground mt-1">Global view of inventory across all locations</p>
          </div>
          <Button variant="outline"><Download className="w-4 h-4 mr-2" /> Export CSV</Button>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-center gap-2 border border-input rounded-md px-3 bg-muted/50 focus-within:ring-1 focus-within:ring-ring">
              <Search className="w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Search items or HSN..." 
                value={search} 
                onChange={e => setSearch(e.target.value)}
                className="border-transparent bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-0"
              />
            </div>
            
            <Select value={branchType} onValueChange={(val) => { setBranchType(val); setBranchId('all'); }}>
              <SelectTrigger>
                <SelectValue placeholder="All Location Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="production">Production Units</SelectItem>
                <SelectItem value="warehouse">Warehouses</SelectItem>
                <SelectItem value="outlet">Retail Outlets</SelectItem>
              </SelectContent>
            </Select>

            <Select value={branchId} onValueChange={setBranchId} disabled={branchType === 'all' || branchType === 'production'}>
              <SelectTrigger>
                <SelectValue placeholder="All Specific Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {branchType === 'warehouse' && warehouses?.map(w => (
                  <SelectItem key={`w-${w.id}`} value={w.id.toString()}>{w.name}</SelectItem>
                ))}
                {branchType === 'outlet' && outlets?.map(o => (
                  <SelectItem key={`o-${o.id}`} value={o.id.toString()}>{o.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item Name</TableHead>
                <TableHead>HSN Code</TableHead>
                <TableHead>Location Type</TableHead>
                <TableHead>Location Name</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Est. Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading stock data...</TableCell></TableRow>
              ) : filteredStock.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No stock matching filters</TableCell></TableRow>
              ) : (
                filteredStock.map((entry, idx) => (
                  <TableRow key={`${entry.itemId}-${entry.branchType}-${entry.branchId}-${idx}`}>
                    <TableCell className="font-medium">{entry.itemName}</TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs">{entry.hsnCode}</TableCell>
                    <TableCell className="capitalize">{entry.branchType}</TableCell>
                    <TableCell>{entry.branchName}</TableCell>
                    <TableCell className="text-right font-mono font-medium text-primary">
                      {entry.quantity} {entry.unit}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {entry.costPrice ? `₹${(entry.costPrice * (entry.quantity || 0)).toLocaleString('en-IN')}` : '-'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}