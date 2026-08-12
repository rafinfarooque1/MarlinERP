import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { AlertTriangle, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useChangePassword } from '@workspace/api-client-react';

const schema = z.object({
  currentPassword: z.string().min(1, 'Current password required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string().min(1, 'Please confirm your new password'),
}).refine(d => d.newPassword === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

type FormValues = z.infer<typeof schema>;

export default function ChangePassword() {
  const [, setLocation] = useLocation();
  const changeMutation = useChangePassword();
  const [isForced, setIsForced] = useState(false);

  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem('marlin_user') ?? '{}');
      setIsForced(!!user.mustChangePassword);
    } catch { /* ignore */ }
  }, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = (data: FormValues) => {
    changeMutation.mutate(
      { data: { currentPassword: data.currentPassword, newPassword: data.newPassword } as any },
      {
        onSuccess: () => {
          // Clear the mustChangePassword flag stored locally
          try {
            const stored = JSON.parse(localStorage.getItem('marlin_user') ?? '{}');
            stored.mustChangePassword = false;
            localStorage.setItem('marlin_user', JSON.stringify(stored));
          } catch { /* ignore */ }

          toast.success('Password changed successfully');
          form.reset();
          if (isForced) setLocation('/company/profile');
        },
        onError: (e: any) =>
          toast.error(e?.data?.error || e.message || 'Failed to change password'),
      },
    );
  };

  return (
    <AppLayout>
      <div className="max-w-lg space-y-6">
        <PageHeader
          title="Change Password"
          description="Update your account password"
          icon={KeyRound}
        />

        <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-4">
          {isForced ? (
            <div className="flex items-start gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                  Password change required
                </p>
                <p className="text-sm text-muted-foreground mt-0.5">
                  You must set a new personal password before you can use the system.
                  Enter the initial password you were given as your current password.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
              <ShieldCheck className="w-5 h-5 text-primary shrink-0" />
              <p className="text-sm text-muted-foreground">
                Use a strong password with at least 8 characters. Avoid reusing old passwords.
              </p>
            </div>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="••••••••" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="At least 8 characters" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm New Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Repeat new password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                className="w-full mt-2"
                size="lg"
                disabled={changeMutation.isPending}
              >
                {changeMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Changing…</>
                ) : (
                  <><KeyRound className="w-4 h-4 mr-2" /> Change Password</>
                )}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </AppLayout>
  );
}
