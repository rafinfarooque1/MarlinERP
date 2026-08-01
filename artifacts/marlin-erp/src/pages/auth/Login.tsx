import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useLogin } from '@workspace/api-client-react';
import { Lock, User, Loader2, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
// Toasts go through sonner — App.tsx mounts ONLY the sonner <Toaster>, so the
// legacy hooks/use-toast hook renders nowhere on this page (or anywhere else).
import { toast } from 'sonner';
import { useTheme } from '@/lib/theme';
import { useSession } from '@/lib/sessionContext';

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});
type LoginFormValues = z.infer<typeof loginSchema>;

// Decorative frost circle
function FrostCircle({ className }: { className: string }) {
  return (
    <div
      className={`absolute rounded-full border border-white/10 ${className}`}
      style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.06) 0%, transparent 70%)' }}
    />
  );
}

export default function Login() {
  const [, setLocation] = useLocation();
  const loginMutation = useLogin();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();
  const { stage, acceptSession } = useSession();
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (stage === 'ready') {
      setLocation('/profile/me');
    }
  }, [setLocation, stage]);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  const onSubmit = (data: LoginFormValues) => {
    // Trim here too (the server also trims): a pasted "admin " must behave
    // exactly like "admin", not fail with a puzzling generic error.
    loginMutation.mutate({ data: { ...data, username: data.username.trim() } }, {
      onSuccess: (response) => {
        setTheme('light');
        queryClient.clear();
        localStorage.setItem('marlin_auth_token', response.token);
        localStorage.setItem('marlin_user', JSON.stringify(response.employee));
        acceptSession();
        if ((response.employee as any).mustChangePassword) {
          setLocation('/change-password');
        } else {
          setLocation('/profile/me');
        }
      },
      onError: (error: any) => {
        // A lockout (429) is a different situation from wrong credentials and
        // must read as one — the server's message carries the remaining time.
        toast.error(error?.status === 429 ? 'Account temporarily locked' : 'Login failed', {
          description: error?.data?.error || error.message || 'Invalid credentials. Please try again.',
        });
      },
    });
  };

  return (
    <div className="min-h-screen flex">

      {/* ── Left brand panel ─────────────────────────────────────────── */}
      <div
        className="hidden lg:flex lg:w-[55%] xl:w-[60%] relative flex-col overflow-hidden"
        style={{
          background: 'linear-gradient(145deg, #0f4c5c 0%, #0a6e5e 40%, #067a5f 70%, #095f48 100%)',
        }}
      >
        {/* Decorative circles */}
        <FrostCircle className="w-[500px] h-[500px] -top-40 -left-32" />
        <FrostCircle className="w-[350px] h-[350px] top-1/4 -right-28" />
        <FrostCircle className="w-[280px] h-[280px] bottom-16 left-1/4" />
        <FrostCircle className="w-[180px] h-[180px] -bottom-12 -right-8" />

        {/* Subtle grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />

        {/* Content */}
        <div className="relative z-10 flex flex-col h-full px-12 py-10">
          {/* Logo */}
          <div>
            <img
              src="/marlin-logo.jpeg"
              alt="Marlin Frozen Fruits"
              className="h-16 object-contain rounded-lg"
              style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.4))' }}
            />
          </div>

          {/* Centre copy */}
          <div className="flex-1 flex flex-col justify-center">
            <p className="text-white/50 text-xs font-mono tracking-[0.25em] uppercase mb-4">
              Enterprise Operations Platform
            </p>
            <h1 className="text-white text-4xl xl:text-5xl font-bold leading-tight mb-4">
              One system.<br />All operations.
            </h1>
            <p className="text-white/60 text-base max-w-sm leading-relaxed">
              Manage production, inventory, sales, payroll, and accounts — all in one place built for Marlin's workflow.
            </p>

            {/* Stat pills */}
            <div className="flex gap-3 mt-10 flex-wrap">
              {[
                { label: 'Modules', value: '15+' },
                { label: 'GST Ready', value: '✓' },
                { label: 'Live Reports', value: '✓' },
              ].map(s => (
                <div
                  key={s.label}
                  className="flex items-center gap-2 px-4 py-2 rounded-full text-sm"
                  style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  <span className="text-white/50">{s.label}</span>
                  <span className="text-white font-semibold">{s.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <p className="text-white/25 text-xs">
            © {new Date().getFullYear()} Marlin Frozen Fruits. Internal use only.
          </p>
        </div>
      </div>

      {/* ── Right form panel ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col justify-center items-center px-6 py-12 bg-background relative overflow-hidden">

        {/* Soft teal glow behind the card (desktop) */}
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(6,122,95,0.06) 0%, transparent 65%)' }}
        />

        {/* Mobile-only logo */}
        <div className="lg:hidden mb-8 text-center">
          <img src="/marlin-logo.jpeg" alt="Marlin" className="h-14 object-contain mx-auto mb-2" />
          <p className="text-xs font-mono tracking-widest uppercase text-muted-foreground">Operations Terminal</p>
        </div>

        {/* Card */}
        <div className="w-full max-w-sm relative z-10">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-foreground">Welcome back</h2>
            <p className="text-muted-foreground text-sm mt-1">Sign in to access the operations platform</p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" autoComplete="off">
              <FormField control={form.control} name="username" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">Username</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Enter your username"
                        className="pl-10 h-11 bg-muted/40 border-border/60 focus:border-primary focus:bg-background transition-colors"
                        autoComplete="username"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="password" render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">Password</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        type={showPassword ? 'text' : 'password'}
                        placeholder="••••••••"
                        className="pl-10 pr-10 h-11 bg-muted/40 border-border/60 focus:border-primary focus:bg-background transition-colors"
                        autoComplete="new-password"
                        {...field}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(v => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        tabIndex={-1}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <Button
                type="submit"
                className="w-full h-11 font-semibold text-sm mt-2 group"
                style={{
                  background: 'linear-gradient(135deg, #067a5f 0%, #0a6e5e 100%)',
                  boxShadow: '0 4px 16px rgba(6,122,95,0.35)',
                }}
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Authenticating…</>
                ) : (
                  <>
                    Sign In
                    <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </Button>
            </form>
          </Form>

          {/* Security note */}
          <p className="mt-6 text-center text-xs text-muted-foreground/60">
            Secured access · Internal personnel only
          </p>
        </div>
      </div>
    </div>
  );
}
