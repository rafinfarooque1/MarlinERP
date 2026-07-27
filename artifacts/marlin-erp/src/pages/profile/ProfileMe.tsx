import React, { useState, useEffect, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useGetMe } from '@workspace/api-client-react';
import { customFetch } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  User, Mail, Phone, MapPin, Calendar, BookOpen,
  PhoneCall, Pencil, Save, X, Plus, Trash2,
  Building2, BadgeCheck, Loader2, Camera, Briefcase,
} from 'lucide-react';

interface EducationEntry {
  degree: string;
  institution: string;
  year: string;
  field?: string;
}

interface WorkExperienceEntry {
  company: string;
  role: string;
  from: string;
  to: string;       // empty = "Present"
  description?: string;
}

interface EmergencyContact {
  name: string;
  relation: string;
  phone: string;
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function Field({ label, value, editing, children }: { label: string; value?: string | null; editing: boolean; children?: React.ReactNode }) {
  if (!editing) {
    return (
      <div>
        <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
        <p className="text-sm font-medium">{value || <span className="text-muted-foreground italic">Not set</span>}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

export default function ProfileMe() {
  const { data: user, isLoading } = useGetMe();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Editable state
  const [name,            setName]            = useState('');
  const [phone,           setPhone]           = useState('');
  const [email,           setEmail]           = useState('');
  const [bio,             setBio]             = useState('');
  const [dob,             setDob]             = useState('');
  const [personalAddress, setPersonalAddress] = useState('');
  const [photoUrl,        setPhotoUrl]        = useState('');
  const [education,       setEducation]       = useState<EducationEntry[]>([]);
  const [workExp,         setWorkExp]         = useState<WorkExperienceEntry[]>([]);
  const [emergency,       setEmergency]       = useState<EmergencyContact>({ name: '', relation: '', phone: '' });

  // Initialise form from user data
  useEffect(() => {
    if (!user) return;
    const u = user as any;
    setName(u.name ?? '');
    setPhone(u.phone ?? '');
    setEmail(u.email ?? '');
    setBio(u.bio ?? '');
    setDob(u.dateOfBirth ?? '');
    setPersonalAddress(u.personalAddress ?? '');
    setPhotoUrl(u.photoUrl ?? '');
    setEducation(Array.isArray(u.education) ? u.education : []);
    setWorkExp(Array.isArray(u.workExperience) ? u.workExperience : []);
    setEmergency(u.emergencyContact ?? { name: '', relation: '', phone: '' });
  }, [user]);

  // Photo upload (base64 local for now)
  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setPhotoUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await customFetch('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name, phone, email, bio,
          dateOfBirth: dob,
          personalAddress,
          photoUrl,
          education,
          workExperience: workExp,
          emergencyContact: emergency.name ? emergency : null,
        }),
      });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success('Profile updated successfully.');
      setEditing(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    // Reset to original values
    if (user) {
      const u = user as any;
      setName(u.name ?? ''); setPhone(u.phone ?? ''); setEmail(u.email ?? '');
      setBio(u.bio ?? ''); setDob(u.dateOfBirth ?? ''); setPersonalAddress(u.personalAddress ?? '');
      setPhotoUrl(u.photoUrl ?? ''); setEducation(Array.isArray(u.education) ? u.education : []);
      setWorkExp(Array.isArray(u.workExperience) ? u.workExperience : []);
      setEmergency(u.emergencyContact ?? { name: '', relation: '', phone: '' });
    }
    setEditing(false);
  };

  // Education helpers
  const addEdu = () => setEducation(prev => [...prev, { degree: '', institution: '', year: '', field: '' }]);
  const updateEdu = (i: number, key: keyof EducationEntry, val: string) =>
    setEducation(prev => prev.map((e, idx) => idx === i ? { ...e, [key]: val } : e));
  const removeEdu = (i: number) => setEducation(prev => prev.filter((_, idx) => idx !== i));

  // Work experience helpers
  const addExp = () => setWorkExp(prev => [...prev, { company: '', role: '', from: '', to: '', description: '' }]);
  const updateExp = (i: number, key: keyof WorkExperienceEntry, val: string) =>
    setWorkExp(prev => prev.map((e, idx) => idx === i ? { ...e, [key]: val } : e));
  const removeExp = (i: number) => setWorkExp(prev => prev.filter((_, idx) => idx !== i));

  const u = user as any;

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">

        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">My Profile</h1>
            <p className="text-muted-foreground text-sm mt-0.5">View and update your personal information</p>
          </div>
          <div className="flex gap-2">
            {editing ? (
              <>
                <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
                  <X className="w-4 h-4 mr-1.5" /> Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
                  Save Changes
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil className="w-4 h-4 mr-1.5" /> Edit Profile
              </Button>
            )}
          </div>
        </div>

        {/* ── Avatar + basic identity ── */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5">
              {/* Avatar */}
              <div className="relative shrink-0">
                <Avatar className="w-24 h-24 border-2 border-border">
                  <AvatarImage src={editing ? photoUrl : u?.photoUrl} alt={u?.name} />
                  <AvatarFallback className="bg-primary/20 text-primary text-3xl font-bold">
                    {u?.name?.charAt(0) ?? 'U'}
                  </AvatarFallback>
                </Avatar>
                {editing && (
                  <>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow hover:bg-primary/90 transition-colors"
                    >
                      <Camera className="w-3.5 h-3.5" />
                    </button>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoChange} />
                  </>
                )}
              </div>

              {/* Identity info */}
              <div className="flex-1 space-y-1 text-center sm:text-left">
                {editing ? (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Full Name</Label>
                      <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" />
                    </div>
                  </div>
                ) : (
                  <h2 className="text-xl font-bold">{u?.name}</h2>
                )}
                <div className="flex flex-wrap gap-2 justify-center sm:justify-start pt-1">
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <Building2 className="w-3 h-3" />
                    {u?.hierarchyName || 'Staff'}
                  </Badge>
                  {u?.branchName && u?.branchType && (
                    <Badge variant="outline" className="gap-1 text-xs capitalize">
                      {u.branchType === 'outlet' ? '🏪' : u.branchType === 'warehouse' ? '🏭' : '🏢'}
                      {u.branchName}
                    </Badge>
                  )}
                  <Badge variant="outline" className="gap-1 text-xs text-emerald-600 border-emerald-200">
                    <BadgeCheck className="w-3 h-3" /> Active
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground pt-1">
                  Username: <span className="font-mono font-medium">{u?.username}</span>
                  {u?.joinDate && <> · Joined {u.joinDate}</>}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid md:grid-cols-2 gap-4">
          {/* ── Contact ── */}
          <Section title="Contact Information" icon={Phone}>
            <Field label="Phone" value={!editing ? (u?.phone || null) : undefined} editing={editing}>
              <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" />
            </Field>
            <Field label="Email" value={!editing ? (u?.email || null) : undefined} editing={editing}>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
            </Field>
          </Section>

          {/* ── Personal ── */}
          <Section title="Personal Details" icon={User}>
            <Field label="Date of Birth" value={!editing ? (u?.dateOfBirth || null) : undefined} editing={editing}>
              <Input type="date" value={dob} onChange={e => setDob(e.target.value)} />
            </Field>
            <Field label="Home Address" value={!editing ? (u?.personalAddress || null) : undefined} editing={editing}>
              <Input value={personalAddress} onChange={e => setPersonalAddress(e.target.value)} placeholder="Your home address" />
            </Field>
          </Section>
        </div>

        {/* ── Bio ── */}
        <Section title="About Me" icon={BookOpen}>
          {editing ? (
            <Textarea
              value={bio}
              onChange={e => setBio(e.target.value)}
              placeholder="A short bio — your experience, skills, interests…"
              rows={3}
            />
          ) : (
            <p className="text-sm">{u?.bio || <span className="text-muted-foreground italic">No bio added yet.</span>}</p>
          )}
        </Section>

        {/* ── Education ── */}
        <Section title="Education" icon={BookOpen}>
          {editing ? (
            <div className="space-y-3">
              {education.map((edu, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 p-3 rounded-lg border border-border bg-muted/20 relative">
                  <button
                    type="button"
                    onClick={() => removeEdu(i)}
                    className="absolute top-2 right-2 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Degree / Qualification</Label>
                    <Input value={edu.degree} onChange={e => updateEdu(i, 'degree', e.target.value)} placeholder="e.g. B.Com, MBA" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Institution</Label>
                    <Input value={edu.institution} onChange={e => updateEdu(i, 'institution', e.target.value)} placeholder="College / University" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Year</Label>
                    <Input value={edu.year} onChange={e => updateEdu(i, 'year', e.target.value)} placeholder="e.g. 2019" maxLength={4} />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Field of Study (optional)</Label>
                    <Input value={edu.field ?? ''} onChange={e => updateEdu(i, 'field', e.target.value)} placeholder="e.g. Commerce, Computer Science" />
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addEdu} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add Qualification
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {(u?.education ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No education details added.</p>
              ) : (
                (u?.education as EducationEntry[]).map((edu, i) => (
                  <div key={i} className="flex items-start gap-3 py-2">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <BookOpen className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{edu.degree}{edu.field ? ` — ${edu.field}` : ''}</p>
                      <p className="text-xs text-muted-foreground">{edu.institution}{edu.year ? `, ${edu.year}` : ''}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </Section>

        {/* ── Work Experience ── */}
        <Section title="Work Experience" icon={Briefcase}>
          {editing ? (
            <div className="space-y-3">
              {workExp.map((exp, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 p-3 rounded-lg border border-border bg-muted/20 relative">
                  <button
                    type="button"
                    onClick={() => removeExp(i)}
                    className="absolute top-2 right-2 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Company / Organisation</Label>
                    <input
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={exp.company}
                      onChange={e => updateExp(i, 'company', e.target.value)}
                      placeholder="e.g. ABC Traders"
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Job Title / Role</Label>
                    <input
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={exp.role}
                      onChange={e => updateExp(i, 'role', e.target.value)}
                      placeholder="e.g. Sales Manager"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">From (Year)</Label>
                    <input
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={exp.from}
                      onChange={e => updateExp(i, 'from', e.target.value)}
                      placeholder="e.g. 2019"
                      maxLength={4}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">To (Year or leave blank for Present)</Label>
                    <input
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={exp.to}
                      onChange={e => updateExp(i, 'to', e.target.value)}
                      placeholder="e.g. 2022 or blank = Present"
                      maxLength={4}
                    />
                  </div>
                  <div className="col-span-2 space-y-1">
                    <Label className="text-xs">Description (optional)</Label>
                    <Textarea
                      value={exp.description ?? ''}
                      onChange={e => updateExp(i, 'description', e.target.value)}
                      placeholder="Key responsibilities or achievements…"
                      rows={2}
                    />
                  </div>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addExp} className="gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add Experience
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {(u?.workExperience as WorkExperienceEntry[] ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No work experience added.</p>
              ) : (
                (u?.workExperience as WorkExperienceEntry[]).map((exp, i) => (
                  <div key={i} className="flex items-start gap-3 py-2">
                    <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Briefcase className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{exp.role}</p>
                      <p className="text-xs text-muted-foreground">{exp.company}</p>
                      <p className="text-xs text-muted-foreground">
                        {exp.from}{exp.from ? ' – ' : ''}{exp.to || (exp.from ? 'Present' : '')}
                      </p>
                      {exp.description && (
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{exp.description}</p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </Section>

        {/* ── Emergency Contact ── */}
        <Section title="Emergency Contact" icon={PhoneCall}>
          {editing ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={emergency.name} onChange={e => setEmergency(p => ({ ...p, name: e.target.value }))} placeholder="Contact name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Relation</Label>
                <Input value={emergency.relation} onChange={e => setEmergency(p => ({ ...p, relation: e.target.value }))} placeholder="e.g. Spouse, Parent" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={emergency.phone} onChange={e => setEmergency(p => ({ ...p, phone: e.target.value }))} placeholder="+91 98765 43210" />
              </div>
            </div>
          ) : (
            u?.emergencyContact?.name ? (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-rose-500/10 flex items-center justify-center shrink-0">
                  <PhoneCall className="w-4 h-4 text-rose-500" />
                </div>
                <div>
                  <p className="text-sm font-medium">{u.emergencyContact.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {u.emergencyContact.relation} · {u.emergencyContact.phone}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No emergency contact added.</p>
            )
          )}
        </Section>

        {/* ── Read-only employment info ── */}
        <Section title="Employment Details" icon={Building2}>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Username</p>
              <p className="text-sm font-mono font-medium">{u?.username}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Role</p>
              <p className="text-sm font-medium">{u?.hierarchyName || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Assigned To</p>
              <p className="text-sm font-medium capitalize">{u?.branchName || 'Head Office'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Date Joined</p>
              <p className="text-sm font-medium">{u?.joinDate || '—'}</p>
            </div>
          </div>
          <Separator className="my-1" />
          <p className="text-xs text-muted-foreground">Employment details can only be changed by your manager.</p>
        </Section>

      </div>
    </AppLayout>
  );
}
