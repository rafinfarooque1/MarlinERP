import { useState, useRef, useEffect } from 'react';
import { useGetMe, useUpdateEmployee, getGetMeQueryKey } from '@workspace/api-client-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { User, Camera, ShieldAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Link } from 'wouter';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().optional(),
  photoUrl: z.string().optional(),
});

export default function Profile() {
  const { data: me, isLoading } = useGetMe();
  const updateMutation = useUpdateEmployee();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', phone: '', photoUrl: '' },
  });

  useEffect(() => {
    if (me) {
      form.reset({
        name: me.name || '',
        email: me.email || '',
        phone: me.phone || '',
        photoUrl: me.photoUrl || '',
      });
      setPhotoPreview(me.photoUrl || null);
    }
  }, [me, form]);

  const onSubmit = (data: z.infer<typeof schema>) => {
    if (!me) return;
    updateMutation.mutate({ id: me.id, data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        toast({ title: 'Profile updated successfully' });
      }
    });
  };

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setPhotoPreview(url);
      form.setValue('photoUrl', url, { shouldDirty: true });
    }
  };

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <User className="w-6 h-6 text-primary" /> My Profile
          </h1>
          <p className="text-muted-foreground mt-1">Manage your personal information</p>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground">Loading profile...</div>
        ) : !me ? (
          <div className="py-12 text-center text-destructive">Failed to load profile.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            
            <div className="col-span-1 space-y-6">
              <div className="bg-card border border-border rounded-lg p-6 shadow-sm flex flex-col items-center text-center">
                <div className="relative group mb-4">
                  <Avatar className="h-32 w-32 border-4 border-background shadow-lg">
                    <AvatarImage src={photoPreview || undefined} />
                    <AvatarFallback className="text-4xl bg-primary/10 text-primary">{me.name?.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute bottom-0 right-0 h-10 w-10 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-md hover:bg-primary/90 transition-colors"
                  >
                    <Camera className="w-5 h-5" />
                  </button>
                  <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handlePhotoChange} />
                </div>
                <h2 className="text-xl font-bold">{me.name}</h2>
                <p className="text-primary font-mono text-sm mt-1">{me.hierarchyName}</p>
                <div className="w-full h-px bg-border my-4" />
                <div className="w-full flex justify-between text-sm">
                  <span className="text-muted-foreground">Location</span>
                  <span className="font-medium">{me.branchName}</span>
                </div>
                <div className="w-full flex justify-between text-sm mt-2">
                  <span className="text-muted-foreground">Status</span>
                  <span className="font-medium text-emerald-500">Active</span>
                </div>
              </div>

              <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
                <div className="flex items-center gap-2 mb-4">
                  <ShieldAlert className="w-5 h-5 text-muted-foreground" />
                  <h3 className="font-medium">Security</h3>
                </div>
                <p className="text-sm text-muted-foreground mb-4">It's a good idea to update your password regularly to keep your account secure.</p>
                <Button variant="outline" className="w-full" asChild>
                  <Link href="/change-password">Change Password</Link>
                </Button>
              </div>
            </div>

            <div className="col-span-1 md:col-span-2">
              <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
                <h3 className="text-lg font-medium border-b border-border pb-2 mb-6">Personal Details</h3>
                
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <FormField control={form.control} name="name" render={({field}) => (
                      <FormItem>
                        <FormLabel>Full Name</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <FormField control={form.control} name="phone" render={({field}) => (
                        <FormItem>
                          <FormLabel>Phone Number</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="email" render={({field}) => (
                        <FormItem>
                          <FormLabel>Email Address</FormLabel>
                          <FormControl><Input type="email" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>

                    <div className="pt-4 border-t border-border flex justify-end">
                      <Button type="submit" disabled={updateMutation.isPending || !form.formState.isDirty}>
                        {updateMutation.isPending ? 'Saving...' : 'Save Profile'}
                      </Button>
                    </div>
                  </form>
                </Form>
              </div>
            </div>

          </div>
        )}
      </div>
    </AppLayout>
  );
}