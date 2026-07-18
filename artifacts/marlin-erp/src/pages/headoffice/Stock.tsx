import { useState } from 'react';
import { useListStock, useListWarehouses, useListOutlets } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Search, BarChart3, Download, AlertTriangle } from 'lucide-react';
import { downloadCSV } from '@/lib/download';
import { Badge } from '@/components/ui/badge';

export default function Stock() {
  const [branchType, setBranchType] = useState<string>('all');
  const [branchId, setBranchId] = useState<string>('');
  const [search, setSearch] = useState('');
  const { data: warehouses = [] } = useListWarehouses();
  const { data: outlets = [] } = useListOutlets();

  const params: any = {};
  if (branchType !== 'all') params.branchType = branchType;
  if (branchId && branchId !== '0') params.branchId = Number(branchId);

  const { data: stock = [], isLoading } = useListStock(params);
  const filtered = stock.filter(s => s.itemName?.toLowerCase().includes(search.toLowerCase()) || s.branchName?.toLowerCase().includes(search.toLowerCase()));

  const branchOptions = branchType === 'warehouse' ? warehouses : branchType === 'outlet' ? outlets : [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><BarChart3 className="w-6 h-6 text-primary" /> Live Stock</h1>
            <p className="text-muted-foreground mt-1">Current inventory levels across all locations</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => downloadCSV('stock.csv', filtered.map(s => ({ Item: s.itemName, Location: s.branchName, Type: s.branchType, Qty: s.quantity, Unit: s.unit })))}>
            <Download className="w-4 h-4 mr-2" /> Export
          </Button>
        </div>

        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex flex-wrap gap-3 bg-muted/20">
            <div className="flex items-center gap-2 flex-1 min-w-[180px]">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input placeholder="Search item or location..." value={search} onChange={e => setSearch(e.target.value)} className="border-transparent bg-transparent focus-visible:ring-0" />
            </div>
            <Select value={branchType} onValueChange={v => { setBranchType(v); setBranchId(''); }}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All Locations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                <SelectItem value="production">Production</SelectItem>
                <SelectItem value="warehouse">Warehouse</SelectItem>
                <SelectItem value="outlet">Outlet</SelectItem>
              </SelectContent>
            </Select>
            {branchOptions.length > 0 && (
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger className="w-44"><SelectValue placeholder="All" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">All</SelectItem>
                  {branchOptions.map((b: any) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow className="bg-muted/10">
                <TableHead>Item</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? [...Array(5)].map((_, i) => (
                <TableRow key={i}><TableCell colSpan={5}><div className="h-8 bg-muted/30 rounded animate-pulse" /></TableCell></TableRow>
              )) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-16 text-muted-foreground">
                  <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-20" /><p>No stock data found</p>
                </TableCell></TableRow>
              ) : filtered.map((s, i) => {
                const low = Number(s.quantity) < 50;
                return (
                  <TableRow key={i} className={`hover:bg-muted/10 ${low ? 'bg-red-500/5' : ''}`}>
                    <TableCell className="font-semibold">{s.itemName}</TableCell>
                    <TableCell className="text-muted-foreground">{s.branchName}</TableCell>
                    <TableCell><Badge variant="outline" className="text-xs capitalize">{s.branchType}</Badge></TableCell>
                    <TableCell className={`text-right font-mono font-bold ${low ? 'text-red-500' : 'text-emerald-500'}`}>
                      {Number(s.quantity).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {low ? <Badge variant="destructive" className="text-xs gap-1"><AlertTriangle className="w-3 h-3" /> Low Stock</Badge>
                           : <Badge variant="outline" className="text-xs text-emerald-500 border-emerald-500/30">OK</Badge>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {filtered.length > 0 && (
            <div className="p-3 border-t border-border text-xs text-muted-foreground text-right">
              {filtered.length} entries · Total: {filtered.reduce((s, r) => s + Number(r.quantity || 0), 0).toLocaleString()} units
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
