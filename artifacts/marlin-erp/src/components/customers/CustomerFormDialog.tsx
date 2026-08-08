/**
 * THE customer create/edit form — the single source of truth used by the
 * Customers module, Point of Sale and Quotations. There must never be a second
 * customer form: every entry point gets identical fields, validation, location
 * assignment rules and server behaviour (duplicate checks, CUST- debtor ledger
 * auto-provisioning) because they all post through this one component.
 *
 * Location assignment follows the party rule everywhere: only Head Office may
 * choose a location (dropdown); branch users' payloads carry NO location — the
 * server stamps their session location. Callers with a location context (POS
 * selling at a branch) pass `defaultLocationValue` so the dropdown pre-selects
 * it, keeping the new customer visible in that screen's scoped dropdown.
 */
import { useEffect } from 'react';
import { useCreateCustomer, useUpdateCustomer, getListCustomersQueryKey } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StateCombobox } from '@/components/ui/state-combobox';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { usePartyLocations, locationValueOf, HEAD_OFFICE_VALUE } from '@/lib/usePartyLocations';

const customerFormSchema = z.object({
  name: z.string().min(1, 'Name required'),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  gstNumber: z.string().optional(),
  state: z.string().optional(),
  notes: z.string().optional(),
  creditLimit: z.coerce.number().min(0, 'Must be ≥ 0').optional(),
  creditDays: z.coerce.number().int('Whole days').min(0, 'Must be ≥ 0').optional(),
  location: z.string().optional(),
});
type CustomerFormValues = z.infer<typeof customerFormSchema>;

const emptyValues: CustomerFormValues = {
  name: '', phone: '', email: '', address: '', gstNumber: '', state: '',
  notes: '', creditLimit: 0, creditDays: 0, location: HEAD_OFFICE_VALUE,
};

export interface CustomerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = edit mode; the form loads this customer's stored values. */
  editItem?: any | null;
  /** Create mode only: pre-select this `type:id` location (HO users can still change it). */
  defaultLocationValue?: string;
  /** Create mode only: pre-fill the name (e.g. from a combobox search with no match). */
  prefillName?: string;
  /** Fires after a successful save with the server's customer row. */
  onSaved?: (customer: any, mode: 'created' | 'updated') => void;
}

export function CustomerFormDialog({ open, onOpenChange, editItem, defaultLocationValue, prefillName, onSaved }: CustomerFormDialogProps) {
  const loc = usePartyLocations();
  const queryClient = useQueryClient();
  const createMutation = useCreateCustomer();
  const updateMutation = useUpdateCustomer();

  const form = useForm<CustomerFormValues>({ resolver: zodResolver(customerFormSchema), defaultValues: emptyValues });

  // Load values whenever the dialog opens: the stored row in edit mode, a
  // clean form (with the caller's location context) in create mode.
  useEffect(() => {
    if (!open) return;
    if (editItem) {
      form.reset({
        name: editItem.name, phone: editItem.phone ?? '', email: editItem.email ?? '',
        // gst_number fallback: tolerate a raw snake_case row from a stale
        // cached list, so an edit can never load blank and wipe the stored GST.
        address: editItem.address ?? '', gstNumber: editItem.gstNumber ?? (editItem as any).gst_number ?? '',
        state: (editItem as any).state ?? '', notes: editItem.notes ?? '',
        creditLimit: Number(editItem.creditLimit ?? 0), creditDays: Number(editItem.creditDays ?? 0),
        location: locationValueOf((editItem as any).locationType ?? (editItem as any).location_type, (editItem as any).locationId ?? (editItem as any).location_id),
      });
    } else {
      form.reset({ ...emptyValues, name: prefillName ?? '', location: defaultLocationValue ?? HEAD_OFFICE_VALUE });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editItem]);

  const close = () => { onOpenChange(false); form.reset(emptyValues); };

  const onSubmit = (data: CustomerFormValues) => {
    // Only Head Office may assign a location; branch users are stamped by
    // their session on the server, so their payload carries no location.
    const { location, ...rest } = data;
    const payload: any = { ...rest };
    if (loc.isHeadOffice && location) {
      const [locationType, locationId] = location.split(':');
      payload.locationType = locationType;
      payload.locationId = Number(locationId) || 0;
    }
    const afterSave = (row: any, mode: 'created' | 'updated') => {
      toast.success(mode === 'created' ? `Customer "${row?.name ?? data.name}" added` : 'Customer updated');
      queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
      // POS/Quotations read location-scoped lists under the plain 'customers' key.
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      close();
      onSaved?.(row, mode);
    };
    if (editItem) {
      updateMutation.mutate({ id: editItem.id, data: payload as any }, {
        onSuccess: (row: any) => afterSave(row ?? { ...editItem, ...payload }, 'updated'),
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    } else {
      createMutation.mutate({ data: payload as any }, {
        onSuccess: (row: any) => afterSave(row, 'created'),
        onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed'),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) close(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editItem ? 'Edit Customer' : 'Add Customer'}</DialogTitle></DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name <span className="text-destructive">*</span></FormLabel><FormControl><Input placeholder="Full name / company name" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField control={form.control} name="phone" render={({ field }) => (
                <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
              )} />
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="gstNumber" render={({ field }) => (
                <FormItem><FormLabel>GST Number (GSTIN)</FormLabel><FormControl><Input placeholder="15-char GSTIN" className="font-mono" {...field} /></FormControl></FormItem>
              )} />
              <FormField control={form.control} name="state" render={({ field }) => (
                <FormItem><FormLabel>State</FormLabel>
                  <FormControl><StateCombobox value={field.value || ''} onChange={field.onChange} data-testid="select-customer-state" /></FormControl>
                </FormItem>
              )} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField control={form.control} name="creditLimit" render={({ field }) => (
                <FormItem>
                  <FormLabel>Credit Limit (₹)</FormLabel>
                  <FormControl><Input type="number" min={0} step="0.01" className="font-mono" {...field} /></FormControl>
                  <p className="text-[11px] text-muted-foreground">0 = no limit enforced</p>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="creditDays" render={({ field }) => (
                <FormItem>
                  <FormLabel>Credit Days</FormLabel>
                  <FormControl><Input type="number" min={0} step="1" className="font-mono" {...field} /></FormControl>
                  <p className="text-[11px] text-muted-foreground">Days until an invoice falls due</p>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            {loc.isHeadOffice ? (
              <FormField control={form.control} name="location" render={({ field }) => (
                <FormItem>
                  <FormLabel>Assigned Location</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || HEAD_OFFICE_VALUE}>
                    <FormControl><SelectTrigger data-testid="select-customer-location"><SelectValue placeholder="Head Office" /></SelectTrigger></FormControl>
                    <SelectContent>
                      {loc.assignOptions.map(o => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">Which location this customer belongs to</p>
                </FormItem>
              )} />
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-medium">Assigned Location</p>
                <div className="h-9 px-3 rounded-md border border-border bg-muted/40 flex items-center text-sm text-muted-foreground">{loc.myLocationLabel}</div>
                <p className="text-[11px] text-muted-foreground">Set by your login location</p>
              </div>
            )}
            <FormField control={form.control} name="address" render={({ field }) => (
              <FormItem><FormLabel>Address</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
            )} />
            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
            )} />
            <DialogFooter>
              <Button variant="outline" type="button" onClick={close}>Cancel</Button>
              <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                {createMutation.isPending || updateMutation.isPending ? 'Saving…' : editItem ? 'Save Changes' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
