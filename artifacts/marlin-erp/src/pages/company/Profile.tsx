import { useState, useRef, useEffect } from 'react';
import { useGetCompanySettings, useUpdateCompanySettings } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Building2, Save, Loader2, Upload, X, ImageIcon, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { StateCombobox } from '@/components/ui/state-combobox';
import { usePermission } from '@/lib/usePermission';

const LOGO_KEY = 'marlin_company_logo';
/**
 * Set once this browser has synced with the server's logo state. After that,
 * an empty server logo means "removed on purpose" — never a cue to push a
 * stale local copy back up.
 */
const LOGO_SYNCED_KEY = 'marlin_logo_synced_v1';

/**
 * Normalise any uploaded image to a small PNG data URI (≤512px on the long
 * edge). The invoice PDF is rendered on the server and embeds these bytes
 * directly — jsPDF cannot fetch a URL or draw an SVG — so everything is
 * converted to a format it can draw, at a size the API accepts.
 */
async function normaliseLogo(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Not a readable image'));
    i.src = dataUrl;
  });
  const iw = img.naturalWidth || 512;
  const ih = img.naturalHeight || 512;
  const scale = Math.min(1, 512 / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

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
  bankBranch: z.string().optional(),
  accountType: z.string().optional(),
  bankAccountHolder: z.string().optional(),
  upiEnabled: z.boolean().optional(),
  upiId: z.string().optional().refine(
    v => !v || /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(v.trim()),
    'Enter a valid UPI ID, e.g. marlin@hdfcbank',
  ),
  upiPayeeName: z.string().optional(),
  showUpiQrOnInvoice: z.boolean().optional(),
  showBankDetailsOnInvoice: z.boolean().optional(),
  financialYear: z.string().optional(),
  invoicePrefix: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

/**
 * The form is driven by `values`, which is only populated once the settings
 * request resolves. Without a blank starting shape every input mounts
 * uncontrolled and flips to controlled when the data lands, which React warns
 * about. Starting blank keeps every field controlled for the whole lifetime.
 */
const BLANK: FormValues = {
  name: '', gstNumber: '', pan: '', phone: '', email: '', website: '',
  address: '', city: '', state: '', pincode: '',
  bankName: '', bankAccount: '', ifscCode: '', bankBranch: '',
  accountType: '', bankAccountHolder: '',
  upiEnabled: true, upiId: '', upiPayeeName: '',
  showUpiQrOnInvoice: true, showBankDetailsOnInvoice: true,
  financialYear: '2025-26', invoicePrefix: 'INV',
};

export default function Profile() {
  const perm = usePermission('page:/company/profile');
  const { data: profile, isLoading } = useGetCompanySettings();
  const updateMutation = useUpdateCompanySettings();
  const [saved, setSaved] = useState(false);
  const [logo, setLogo] = useState<string | null>(() => localStorage.getItem(LOGO_KEY));
  const fileRef = useRef<HTMLInputElement>(null);

  const p = profile as any;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    values: p ? {
      name: p.companyName || p.name || '',
      gstNumber: p.gstNumber || '',
      pan: p.panNumber || p.pan || '',
      phone: p.phone || '',
      email: p.email || '',
      website: p.website || '',
      address: p.address || '',
      city: p.city || '',
      state: p.state || '',
      pincode: p.pincode || '',
      bankName: p.bankName || '',
      bankAccount: p.bankAccount || '',
      ifscCode: p.ifscCode || '',
      bankBranch: p.bankBranch || '',
      accountType: p.accountType || '',
      bankAccountHolder: p.bankAccountHolder || '',
      // Default ON: these switches exist to turn a payment request OFF, so an
      // existing invoice keeps printing exactly what it printed before.
      upiEnabled: p.upiEnabled ?? true,
      upiId: p.upiId || '',
      upiPayeeName: p.upiPayeeName || '',
      showUpiQrOnInvoice: p.showUpiQrOnInvoice ?? true,
      showBankDetailsOnInvoice: p.showBankDetailsOnInvoice ?? true,
      financialYear: p.financialYear || '2025-26',
      invoicePrefix: p.invoicePrefix || 'INV',
    } : BLANK,
  });

  const onSubmit = (data: FormValues) => {
    // Map form field names to DB column names
    const payload = {
      companyName: data.name,
      gstNumber: data.gstNumber,
      panNumber: data.pan,
      phone: data.phone,
      email: data.email || undefined,
      website: data.website,
      address: data.address,
      city: data.city,
      state: data.state,
      pincode: data.pincode,
      bankName: data.bankName,
      bankAccount: data.bankAccount,
      ifscCode: data.ifscCode,
      bankBranch: data.bankBranch,
      accountType: data.accountType,
      bankAccountHolder: data.bankAccountHolder,
      upiEnabled: data.upiEnabled,
      upiId: (data.upiId || '').trim(),
      upiPayeeName: data.upiPayeeName,
      showUpiQrOnInvoice: data.showUpiQrOnInvoice,
      showBankDetailsOnInvoice: data.showBankDetailsOnInvoice,
      financialYear: data.financialYear,
      invoicePrefix: data.invoicePrefix || 'INV',
    };
    updateMutation.mutate({ data: payload as any }, {
      onSuccess: () => { toast.success('Company profile updated'); setSaved(true); setTimeout(() => setSaved(false), 2000); },
      onError: (e: any) => toast.error(e?.data?.error || e.message || 'Failed to save'),
    });
  };

  // The logo used to live only in this browser's localStorage, which the
  // server-rendered invoice PDF can never see. Sync once per visit: the server
  // copy wins when it exists; otherwise a logo already uploaded in this
  // browser is pushed up so it starts printing on invoices.
  const logoSynced = useRef(false);
  useEffect(() => {
    if (!p || perm.isLoading || logoSynced.current) return;
    logoSynced.current = true;
    const serverLogo = typeof p.logoUrl === 'string' && p.logoUrl.startsWith('data:image/') ? p.logoUrl : null;
    const local = localStorage.getItem(LOGO_KEY);
    const alreadySynced = localStorage.getItem(LOGO_SYNCED_KEY) === '1';
    if (serverLogo) {
      // Server is the source of truth — mirror it into this browser.
      if (local !== serverLogo) {
        localStorage.setItem(LOGO_KEY, serverLogo);
        setLogo(serverLogo);
        window.dispatchEvent(new CustomEvent('marlin_logo_changed', { detail: serverLogo }));
      }
      localStorage.setItem(LOGO_SYNCED_KEY, '1');
    } else if (!alreadySynced && local && local.startsWith('data:image/') && perm.canEdit) {
      // One-shot legacy migration: this browser has never synced and holds a
      // logo from the localStorage-only era, so push it up once.
      normaliseLogo(local)
        .then((b64) => updateMutation.mutate({ data: { logoUrl: b64 } as any }, {
          onSuccess: () => {
            localStorage.setItem(LOGO_KEY, b64);
            localStorage.setItem(LOGO_SYNCED_KEY, '1');
            setLogo(b64);
            window.dispatchEvent(new CustomEvent('marlin_logo_changed', { detail: b64 }));
            toast.success('Logo saved to the company profile — it now prints on invoices');
          },
        }))
        .catch(() => { /* unreadable stored logo — a manual re-upload will replace it */ });
    } else {
      // Server has no logo. If this browser already synced once, the logo was
      // removed on purpose (possibly elsewhere) — clear the stale local copy
      // instead of resurrecting it.
      localStorage.setItem(LOGO_SYNCED_KEY, '1');
      if (alreadySynced && local) {
        localStorage.removeItem(LOGO_KEY);
        setLogo(null);
        window.dispatchEvent(new CustomEvent('marlin_logo_changed', { detail: null }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, perm.isLoading, perm.canEdit]);

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('Logo must be under 2 MB'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = await normaliseLogo(reader.result as string);
        updateMutation.mutate({ data: { logoUrl: b64 } as any }, {
          onSuccess: () => {
            localStorage.setItem(LOGO_KEY, b64);
            localStorage.setItem(LOGO_SYNCED_KEY, '1');
            setLogo(b64);
            window.dispatchEvent(new CustomEvent('marlin_logo_changed', { detail: b64 }));
            toast.success('Logo saved — it appears in the sidebar and prints on invoices');
          },
          onError: (err: any) => toast.error(err?.data?.error || err?.message || 'Failed to save logo'),
        });
      } catch {
        toast.error('Could not read that image — please use a PNG or JPEG');
      }
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = () => {
    updateMutation.mutate({ data: { logoUrl: '' } as any }, {
      onSuccess: () => {
        localStorage.removeItem(LOGO_KEY);
        localStorage.setItem(LOGO_SYNCED_KEY, '1');
        setLogo(null);
        window.dispatchEvent(new CustomEvent('marlin_logo_changed', { detail: null }));
        toast.success('Logo removed');
      },
      onError: (err: any) => toast.error(err?.data?.error || err?.message || 'Failed to remove logo'),
    });
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
      <div className="space-y-6 max-w-3xl">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Building2 className="w-6 h-6 text-primary" /> Company Profile</h1>
          <p className="text-muted-foreground mt-1">Legal information, contact details, and billing configuration</p>
        </div>

        {/* Logo Upload */}
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider border-b border-border pb-2">Company Logo</h3>
          <p className="text-xs text-muted-foreground">Upload your logo — it appears in the sidebar and prints on your invoices. PNG or JPEG, max 2 MB.</p>
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
            {perm.canEdit && (
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
            )}
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
                    <FormItem><FormLabel>GSTIN</FormLabel><FormControl><Input placeholder="e.g. 22AAAAA0000A1Z5" className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="pan" render={({ field }) => (
                    <FormItem><FormLabel>PAN</FormLabel><FormControl><Input className="font-mono uppercase" {...field} /></FormControl></FormItem>
                  )} />
                </div>
              </Section>

              <Section title="Contact &amp; Location">
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
                    <FormItem>
                      <FormLabel>State <span className="text-xs text-muted-foreground">(used for GST)</span></FormLabel>
                      <FormControl><StateCombobox value={field.value || ''} onChange={field.onChange} data-testid="select-company-state" /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="pincode" render={({ field }) => (
                    <FormItem><FormLabel>PIN Code</FormLabel><FormControl><Input className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                </div>
              </Section>

              <Section title="Bank Details">
                <p className="text-xs text-muted-foreground -mt-1 mb-3">
                  Printed on invoices that still carry a balance, so a customer can pay by transfer.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="bankAccountHolder" render={({ field }) => (
                    <FormItem><FormLabel>Account Holder</FormLabel><FormControl><Input placeholder="As per bank records" {...field} value={field.value ?? ''} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="bankName" render={({ field }) => (
                    <FormItem><FormLabel>Bank Name</FormLabel><FormControl><Input {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="bankBranch" render={({ field }) => (
                    <FormItem><FormLabel>Branch</FormLabel><FormControl><Input {...field} value={field.value ?? ''} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="ifscCode" render={({ field }) => (
                    <FormItem><FormLabel>IFSC Code</FormLabel><FormControl><Input className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="bankAccount" render={({ field }) => (
                    <FormItem><FormLabel>Account Number</FormLabel><FormControl><Input className="font-mono" {...field} /></FormControl></FormItem>
                  )} />
                  <FormField control={form.control} name="accountType" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Account Type</FormLabel>
                      <Select value={field.value || ''} onValueChange={field.onChange}>
                        <FormControl><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="Current">Current</SelectItem>
                          <SelectItem value="Savings">Savings</SelectItem>
                          <SelectItem value="Cash Credit">Cash Credit</SelectItem>
                          <SelectItem value="Overdraft">Overdraft</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )} />
                </div>
              </Section>

              <Section title="Invoice Payments (UPI & QR)">
                <p className="text-xs text-muted-foreground -mt-1 mb-3">
                  An invoice QR always asks for that invoice's own outstanding balance, recalculated every
                  time it is viewed, printed or shared. A fully paid or cancelled invoice never carries one.
                </p>
                <div className="space-y-4">
                  <FormField control={form.control} name="upiId" render={({ field }) => (
                    <FormItem>
                      <FormLabel>UPI ID (VPA)</FormLabel>
                      <FormControl><Input placeholder="marlin@hdfcbank" className="font-mono" {...field} value={field.value ?? ''} /></FormControl>
                      <FormMessage />
                      <p className="text-xs text-muted-foreground mt-1">
                        Used when the outlet or warehouse that made the sale has no UPI ID of its own.
                        Leave blank to print bank details only — a broken QR is never drawn.
                      </p>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="upiPayeeName" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Payee name shown in the payment app</FormLabel>
                      <FormControl><Input placeholder="Defaults to the selling location's name" {...field} value={field.value ?? ''} /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="upiEnabled" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <div className="pr-4">
                        <FormLabel className="text-sm">Accept UPI payments</FormLabel>
                        <p className="text-xs text-muted-foreground mt-0.5">Off stops UPI being offered anywhere on invoices.</p>
                      </div>
                      <FormControl><Switch checked={!!field.value} onCheckedChange={field.onChange} /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="showUpiQrOnInvoice" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <div className="pr-4">
                        <FormLabel className="text-sm">Print the UPI QR on invoices</FormLabel>
                        <p className="text-xs text-muted-foreground mt-0.5">Off keeps UPI available but leaves the QR off the document.</p>
                      </div>
                      <FormControl><Switch checked={!!field.value} onCheckedChange={field.onChange} /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="showBankDetailsOnInvoice" render={({ field }) => (
                    <FormItem className="flex items-center justify-between rounded-lg border p-3">
                      <div className="pr-4">
                        <FormLabel className="text-sm">Print bank details on invoices</FormLabel>
                        <p className="text-xs text-muted-foreground mt-0.5">Shown beside the QR while a balance is outstanding.</p>
                      </div>
                      <FormControl><Switch checked={!!field.value} onCheckedChange={field.onChange} /></FormControl>
                    </FormItem>
                  )} />
                </div>
              </Section>

              <Section title="Invoice & Financial Settings">
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="invoicePrefix" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Prefix</FormLabel>
                      <FormControl><Input placeholder="e.g. MAR" className="font-mono" {...field} /></FormControl>
                      <p className="text-xs text-muted-foreground mt-1">Invoice numbers will be: {field.value || 'INV'}/2025-26/0001</p>
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="financialYear" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Financial Year</FormLabel>
                      <FormControl><Input placeholder="e.g. 2025-26" className="font-mono" {...field} /></FormControl>
                    </FormItem>
                  )} />
                </div>
              </Section>

              {perm.canEdit && (
              <div className="flex justify-end">
                <Button type="submit" size="lg" disabled={updateMutation.isPending} className={saved ? 'bg-emerald-600 hover:bg-emerald-700' : ''}>
                  {updateMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving…</> : <><Save className="w-4 h-4 mr-2" /> {saved ? 'Saved!' : 'Save Profile'}</>}
                </Button>
              </div>
              )}
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
