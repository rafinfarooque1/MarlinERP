import { useState, useRef, useEffect } from 'react';
import { useListOutlets, useListItems, useListItemPrices, useSetItemPrice, getListItemPricesQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tag } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

export default function ItemPrices() {
  const [selectedOutlet, setSelectedOutlet] = useState<string>('all');
  const { data: outlets } = useListOutlets();
  const { data: items } = useListItems();
  const { data: prices, isLoading } = useListItemPrices(selectedOutlet !== 'all' ? { outletId: Number(selectedOutlet) } : undefined);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const setPriceMutation = useSetItemPrice();

  const handlePriceUpdate = (itemId: number, outletId: number, currentPrice: number, newPriceStr: string) => {
    const newPrice = Number(newPriceStr);
    if (isNaN(newPrice) || newPrice === currentPrice) return;
    
    setPriceMutation.mutate({ data: { itemId, outletId, price: newPrice } }, {
      onSuccess: () => {
        toast({ title: 'Price updated successfully' });
        queryClient.invalidateQueries({ queryKey: getListItemPricesQueryKey(selectedOutlet !== 'all' ? { outletId: Number(selectedOutlet) } : undefined) });
      }
    });
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Tag className="w-6 h-6 text-primary" /> Outlet Item Prices
            </h1>
            <p className="text-muted-foreground mt-1">Manage selling prices per item per outlet</p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border">
            <div className="w-full max-w-sm">
              <Select value={selectedOutlet} onValueChange={setSelectedOutlet}>
                <SelectTrigger>
                  <SelectValue placeholder="Select Outlet" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Outlets (View Only)</SelectItem>
                  {outlets?.map(o => (
                    <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item Name</TableHead>
                {selectedOutlet === 'all' && <TableHead>Outlet</TableHead>}
                <TableHead className="text-right">Price (₹)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : selectedOutlet === 'all' && (!prices || prices.length === 0) ? (
                <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Select an outlet to set prices, or no prices have been set yet.</TableCell></TableRow>
              ) : selectedOutlet !== 'all' ? (
                // When an outlet is selected, show ALL items and their current price at this outlet (or 0)
                items?.map(item => {
                  const existingPrice = prices?.find(p => p.itemId === item.id)?.price || 0;
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">{item.name}</TableCell>
                      <TableCell className="text-right">
                        <Input 
                          type="number" 
                          defaultValue={existingPrice}
                          onBlur={(e) => handlePriceUpdate(item.id, Number(selectedOutlet), existingPrice, e.target.value)}
                          className="w-32 ml-auto text-right font-mono"
                          disabled={setPriceMutation.isPending}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                // View all existing prices across all outlets
                prices?.map((price, idx) => (
                  <TableRow key={`${price.itemId}-${price.outletId}-${idx}`}>
                    <TableCell className="font-medium">{price.itemName}</TableCell>
                    <TableCell>{price.outletName}</TableCell>
                    <TableCell className="text-right font-mono text-primary">₹{price.price?.toLocaleString('en-IN')}</TableCell>
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