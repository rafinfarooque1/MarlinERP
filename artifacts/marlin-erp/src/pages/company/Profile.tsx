import { useState, useRef, useEffect } from 'react';
import { useGetCompanySettings, useUpdateCompanySettings } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Building2, Save, Loader2, Upload, X, ImageIcon } from 'lucide-react';
import { toast } from 'sonner';

const LOGO_KEY = 'marlin_company_logo';

const schema = z.object({
  name: z.string().min(1, 'Company name required'),
  gstNumber: z.string().optional(),
  pan: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().optional(),
  bankName: z.string().optional(),
  bankAccount: z.string().optional(),
  ifscCode: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export default function Profile() {
  const { data: profile, isLoading } = useGetCompanySettings();
  const updateMutation = useUpdateCompanySettings();
  const [saved, setSaved] = useState(false);
  const [logo, setLogo] = useState<string | null>(() => localStorage.getItem(LOGO_KEY));
  const fileRef = useRef<HTMLInputElement>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    values: profile ? {
      name: profile.name || '',
      gstNumber: profile.gstNumber || '',
      pan: profile.pan || '',
      phone: profile.phone || '',
      email: profile.email || '',
      website: profile.website || '',
      address: profile.address || '',
      city: profile.city || '',
      state: profile.state || '',
      pincode: profile.pincode || '',
      bankName: profile.bankName || '',
      bankAccount: profile.bankAccount || '',
      ifscCode: profile.ifscCode || '',
    } : undefined,
  });

  const onSubmit = (data: FormValues) => {
    updateMutation.mutate({ data: data as any }, {
      onSuccess: () => { toast.success('Company profile updated'); setSaved(true); setTimeout(() => setSaved(false), 2000); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to save'),
    });
  };

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('Logo must be under 2 MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result as string;
      localStorage.setItem(LOGO_KEY, b64);
      setLogo(b64);
      // Broadcast to AppLayout
      window.dispatchEvent(new CustomEvent('marlin_logo_changed', { detail: b64 }));
      toast.success('Logo saved — it now appears in the sidebar');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const removeLogo = () => {
    localStorage.removeItem(LOGO_KEY);
    setLogo(null);
    window.dispatchEvent(new CustomEvent('marlin_logo_changed', { detail: null }));
    toast.success('Logo removed');
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Building2 className="w-6 h-6 text-primary" /> Company Profile</h1>
          <p className="text-muted-foreground mt-1">Legal information, contact details, and bank account for invoices</p>
        </div>

        {/* Logo Upload */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">Company Logo</h3>
          <p className="text-xs text-muted-foreground">Upload your logo — it will appear in the sidebar across the entire application. PNG or JPEG, max 2 MB.</p>
          <div className="flex items-center gap-5">
            <div className="w-28 h-20 rounded-lg border-2 border-dashed border-border flex items-center justify-center bg-muted/20 overflow-hidden shrink-0">
              {logo ? (
                <img src={logo} alt="Company logo" className="w-full h-full object-contain p-1" />
              ) : (
                <div className="flex flex-col items-center gap-1 text-muted-foreground">
                  <ImageIcon className="w-7 h-7 opacity-30" />
                  <span className="text-[10px]">No logo</span>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={handleLogoChange} />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="w-4 h-4 mr-2" /> {logo ? 'Replace Logo' : 'Upload Logo'}
              </Button>
              {logo && (
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={removeLogo}>
                  <X className="w-4 h-4 mr-2" /> Remove
                </Button>
              )}
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-3 py-10 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading profile…
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <Section title="Basic Information">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="name" render={({ field }) => (
                    <FormItem className="col-span-2"><FormLabel>Company Name <span className="text-destructive">*</span></FormLabel><FormControl><Input {...field} className="text-base font-semibold" /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="gstNumber" render={({ field }) => (
                    <FormItem><FormLabel>GSTIN</FormLabel><FormControl><Input className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="pan" render={({ field }) => (
                    <FormItem><FormLabel>PAN</FormLabel><FormControl><Input className="font-mono uppercase" {...field} /></FormControl></FormItem>
                  )} />
                </div>
              </Section>

              <Section title="Contact Details">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="phone" render={({ field }) => (
                    <FormItem><FormLabel>Phone</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="email" render={({ field }) => (
                    <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="website" render={({ field }) => (
                    <FormItem className="col-span-2"><FormLabel>Website</FormLabel><FormControl><Input placeholder="https://..." {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="address" render={({ field }) => (
                    <FormItem className="col-span-2"><FormLabel>Address</FormLabel><FormControl><Textarea rows={2} {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="city" render={({ field }) => (
                    <FormItem><FormLabel>City</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="state" render={({ field }) => (
                    <FormItem><FormLabel>State</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="pincode" render={({ field }) => (
                    <FormItem><FormLabel>PIN Code</FormLabel><FormControl><Input className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                </div>
              </Section>

              <Section title="Bank Details">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="bankName" render={({ field }) => (
                    <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="ifscCode" render={({ field }) => (
                    <FormItem><FormLabel>IFSC Code</FormLabel><FormControl><Input className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="bankAccount" render={({ field }) => (
                    <FormItem className="col-span-2"><FormLabel>Account Number</FormLabel><FormControl><Input className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                </div>
              </Section>

              <div className="flex justify-end">
                <Button type="submit" size="lg" disabled={updateMutation.isPending} className={saved ? 'bg-emerald-600 hover:bg-emerald-700' : ''}>
                  {updateMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> {saved ? 'Saved!' : 'Save Profile'}</>}
                </Button>
              </div>
            </form>
          </Form>
        )}
      </div>
    </AppLayout>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">{title}</h3>
      {children}
    </div>
  );
}
