import { useEffect, useState } from 'react';
import { useGetCompanySettings, useUpdateCompanySettings, getGetCompanySettingsQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Building2, UploadCloud, Save } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

const schema = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  website: z.string().url('Invalid URL').optional().or(z.literal('')),
  gstNumber: z.string().optional(),
  panNumber: z.string().optional(),
  logoUrl: z.string().optional(),
  currency: z.string().min(1, 'Currency symbol is required'),
  financialYear: z.string().min(1, 'Financial year is required'),
});

export default function Settings() {
  const { data: settings, isLoading } = useGetCompanySettings();
  const updateMutation = useUpdateCompanySettings();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { 
      companyName: '', address: '', phone: '', email: '', website: '', 
      gstNumber: '', panNumber: '', logoUrl: '', currency: '₹', financialYear: 'April - March'
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        companyName: settings.companyName || '',
        address: settings.address || '',
        phone: settings.phone || '',
        email: settings.email || '',
        website: settings.website || '',
        gstNumber: settings.gstNumber || '',
        panNumber: settings.panNumber || '',
        logoUrl: settings.logoUrl || '',
        currency: settings.currency || '₹',
        financialYear: settings.financialYear || 'April - March',
      });
      setLogoPreview(settings.logoUrl || null);
    }
  }, [settings, form]);

  const onSubmit = (data: z.infer<typeof schema>) => {
    updateMutation.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCompanySettingsQueryKey() });
        toast({ title: 'Settings saved successfully' });
      }
    });
  };

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // In a real app, this would upload to storage and get a URL back.
    // For now we just use object URL for preview and set a fake URL in form.
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setLogoPreview(url);
      form.setValue('logoUrl', '/assets/uploaded-logo.png', { shouldDirty: true });
    }
  };

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Building2 className="w-6 h-6 text-primary" /> Company Settings
          </h1>
          <p className="text-muted-foreground mt-1">Manage global system configurations and company profile</p>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground">Loading settings...</div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
              
              {/* Logo Upload Section */}
              <div className="bg-card border border-border rounded-lg p-6 flex flex-col sm:flex-row items-center gap-8 shadow-sm">
                <div className="h-32 w-32 shrink-0 rounded-md border-2 border-dashed border-border flex items-center justify-center bg-muted/50 overflow-hidden relative group">
                  {logoPreview ? (
                    <img src={logoPreview} alt="Company Logo" className="w-full h-full object-contain p-2" />
                  ) : (
                    <div className="text-center text-muted-foreground flex flex-col items-center">
                      <Building2 className="w-8 h-8 mb-2 opacity-50" />
                      <span className="text-xs">No Logo</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-background/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <label className="cursor-pointer flex flex-col items-center">
                      <UploadCloud className="w-6 h-6 text-primary mb-1" />
                      <span className="text-xs font-medium text-primary">Upload</span>
                      <input type="file" className="hidden" accept="image/*" onChange={handleLogoChange} />
                    </label>
                  </div>
                </div>
                <div className="flex-1 text-center sm:text-left">
                  <h3 className="text-lg font-medium">Company Logo</h3>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md">
                    This logo will appear on the login screen, dashboard header, and all generated PDF documents like invoices and delivery challans.
                  </p>
                  <label className="mt-4 inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2 cursor-pointer">
                    <UploadCloud className="w-4 h-4 mr-2" /> Choose Image
                    <input type="file" className="hidden" accept="image/*" onChange={handleLogoChange} />
                  </label>
                </div>
              </div>

              {/* General Details */}
              <div className="bg-card border border-border rounded-lg p-6 shadow-sm space-y-6">
                <h3 className="text-lg font-medium border-b border-border pb-2">Business Details</h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="companyName" render={({field}) => (
                    <FormItem className="col-span-1 md:col-span-2"><FormLabel>Registered Company Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="phone" render={({field}) => (
                    <FormItem><FormLabel>Primary Phone</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="email" render={({field}) => (
                    <FormItem><FormLabel>Corporate Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="website" render={({field}) => (
                    <FormItem><FormLabel>Website</FormLabel><FormControl><Input type="url" placeholder="https://" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="address" render={({field}) => (
                    <FormItem className="col-span-1 md:col-span-2"><FormLabel>Registered Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              </div>

              {/* Tax & Finance */}
              <div className="bg-card border border-border rounded-lg p-6 shadow-sm space-y-6">
                <h3 className="text-lg font-medium border-b border-border pb-2">Tax & Localization</h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField control={form.control} name="gstNumber" render={({field}) => (
                    <FormItem><FormLabel>Primary GST Number</FormLabel><FormControl><Input {...field} className="uppercase font-mono" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="panNumber" render={({field}) => (
                    <FormItem><FormLabel>PAN Number</FormLabel><FormControl><Input {...field} className="uppercase font-mono" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="currency" render={({field}) => (
                    <FormItem><FormLabel>System Currency Symbol</FormLabel><FormControl><Input {...field} className="w-20 text-center text-lg" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="financialYear" render={({field}) => (
                    <FormItem><FormLabel>Financial Year Cycle</FormLabel><FormControl><Input {...field} placeholder="e.g. April - March" /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              </div>

              <div className="flex justify-end pt-4">
                <Button type="submit" size="lg" disabled={updateMutation.isPending || !form.formState.isDirty}>
                  <Save className="w-4 h-4 mr-2" />
                  {updateMutation.isPending ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </form>
          </Form>
        )}
      </div>
    </AppLayout>
  );
}