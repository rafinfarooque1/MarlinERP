import { useState } from 'react';
import { useListVendors, useCreateVendor, useUpdateVendor, getListVendorsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Plus, Search, Edit2, Truck } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  gstNumber: z.string().optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
});

export default function Vendors() {
  const { data: vendors, isLoading } = useListVendors();
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useCreateVendor();
  const updateMutation = useUpdateVendor();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', phone: '', email: '', address: '', gstNumber: '', bankName: '', accountNumber: '' },
  });

  const onSubmit = (data: z.infer<typeof schema>) => {
    if (editingId) {
      updateMutation.mutate({ id: editingId, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
          setIsOpen(false);
          toast({ title: 'Vendor updated' });
        }
      });
    } else {
      createMutation.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListVendorsQueryKey() });
          setIsOpen(false);
          toast({ title: 'Vendor created' });
        }
      });
    }
  };

  const handleEdit = (vendor: any) => {
    setEditingId(vendor.id);
    form.reset({
      name: vendor.name,
      phone: vendor.phone || '',
      email: vendor.email || '',
      address: vendor.address || '',
      gstNumber: vendor.gstNumber || '',
      bankName: vendor.bankName || '',
      accountNumber: vendor.accountNumber || '',
    });
    setIsOpen(true);
  };

  const filtered = vendors?.filter(v => v.name.toLowerCase().includes(search.toLowerCase()) || v.gstNumber?.toLowerCase().includes(search.toLowerCase())) || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Truck className="w-6 h-6 text-primary" /> Vendors
            </h1>
            <p className="text-muted-foreground mt-1">Manage suppliers and raw material providers</p>
          </div>
          
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) { setEditingId(null); form.reset(); }
          }}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4 mr-2" /> Add Vendor</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>{editingId ? 'Edit Vendor' : 'Add Vendor'}</DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="name" render={({field}) => (
                      <FormItem className="col-span-2"><FormLabel>Vendor Name / Company</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="phone" render={({field}) => (
                      <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="email" render={({field}) => (
                      <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="gstNumber" render={({field}) => (
                      <FormItem className="col-span-2"><FormLabel>GST Number</FormLabel><FormControl><Input {...field} className="uppercase font-mono" /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="address" render={({field}) => (
                      <FormItem className="col-span-2"><FormLabel>Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>

                  <div className="border-t border-border pt-4">
                    <h3 className="text-sm font-medium mb-4">Bank Details</h3>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={form.control} name="bankName" render={({field}) => (
                        <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                      )} />
                      <FormField control={form.control} name="accountNumber" render={({field}) => (
                        <FormItem><FormLabel>Account Number</FormLabel><FormControl><Input {...field} className="font-mono" /></FormControl><FormMessage /></FormItem>
                      )} />
                    </div>
                  </div>

                  <DialogFooter>
                    <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>Save Vendor</Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="bg-card border border-border rounded-md shadow-sm">
          <div className="p-4 border-b border-border flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="Search vendors by name or GST..." 
              value={search} 
              onChange={e => setSearch(e.target.value)}
              className="max-w-md border-transparent bg-muted/50 focus-visible:bg-transparent"
            />
          </div>
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendor</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>GST Details</TableHead>
                <TableHead>Bank Details</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No vendors found</TableCell></TableRow>
              ) : (
                filtered.map(vendor => (
                  <TableRow key={vendor.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{vendor.name}</div>
                      <div className="text-xs text-muted-foreground max-w-[200px] truncate">{vendor.address}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{vendor.phone || '-'}</div>
                      <div className="text-xs text-muted-foreground">{vendor.email || '-'}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-primary">{vendor.gstNumber || 'UNREGISTERED'}</TableCell>
                    <TableCell>
                      {vendor.bankName ? (
                        <div className="text-xs">
                          <div>{vendor.bankName}</div>
                          <div className="font-mono text-muted-foreground">{vendor.accountNumber}</div>
                        </div>
                      ) : <span className="text-xs text-muted-foreground">Not provided</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(vendor)}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
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