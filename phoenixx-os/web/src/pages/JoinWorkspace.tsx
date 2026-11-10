import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, AlertTriangle, Clock3 } from 'lucide-react';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { Button, Field, Input, Select, PasswordInput } from '../components/ui';
import {
  SecurityQuestionFields, EMPTY_SECURITY_QUESTION, isSecurityQuestionComplete,
  type SecurityQuestionValue,
} from '../components/SecurityQuestion';

const ROLES = [
  { id: 'employee', label: 'Employee' },
  { id: 'manager', label: 'Manager' },
  { id: 'finance', label: 'Finance' },
  { id: 'hr', label: 'HR' },
];

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid place-items-center bg-surface px-5 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2.5 mb-8">
          <Logo size={36} />
          <span className="font-semibold text-ink tracking-[-0.02em]">TeamBridge</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A personal invitation link. The invited person creates their own login for
 * the invited email and says which role they hold; the owner approves before
 * the account works.
 */
export default function JoinWorkspace() {
  const { token = '' } = useParams();
  const [form, setForm] = useState({
    name: '', phone: '', role: '', designation: '', department: '', password: '', confirm: '',
  });
  const [nameTouched, setNameTouched] = useState(false);
  const [security, setSecurity] = useState<SecurityQuestionValue>(EMPTY_SECURITY_QUESTION);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const info = useQuery({
    queryKey: ['join-link', token],
    queryFn: () => api.get(`/public/join/${token}`).then((r) => r.data),
    retry: false,
  });

  // The invitation may carry the name the owner typed; it stays editable.
  const name = nameTouched ? form.name : (form.name || info.data?.name || '');

  const send = useMutation({
    mutationFn: () => api.post(`/public/join/${token}`, {
      name: name.trim(),
      phone: form.phone.trim() || null,
      role: form.role,
      designation: form.designation.trim() || null,
      department: form.department.trim() || null,
      password: form.password,
      security_question: security.question.trim(),
      security_answer: security.answer.trim(),
    }),
    onError: (e: any) => { setError(e.message); setFieldErrors(e.fieldErrors || {}); },
  });

  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => ({ ...e, [k]: '' }));
    setError('');
  };
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const ready = name.trim().length >= 2 && !!form.role
    && form.password.length >= 8 && form.password === form.confirm && isSecurityQuestionComplete(security);

  if (info.isLoading) {
    return <Shell><div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-10" />)}</div></Shell>;
  }

  if (info.error) {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-sunken">
            <AlertTriangle size={22} className="text-subtle" />
          </div>
          <h1 className="text-[18px] font-semibold text-ink">This invitation link no longer works</h1>
          <p className="mt-1.5 text-[13.5px] text-subtle">
            It has already been used, or a newer invitation replaced it. If you already created your account,
            sign in once it is approved. Otherwise ask the owner or HR to send you a new invitation.
          </p>
          <Link to="/login" className="mt-4 inline-block text-[13.5px] text-[var(--brand)] hover:underline">Go to sign in</Link>
        </div>
      </Shell>
    );
  }

  if (send.isSuccess) {
    return (
      <Shell>
        <div className="text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-sunken">
            <Clock3 size={22} className="text-[var(--brand)]" />
          </div>
          <h1 className="text-[20px] font-semibold text-ink">Account created — waiting for approval</h1>
          <p className="mt-2 text-[14px] text-subtle leading-relaxed">
            The owner of <strong className="text-ink">{info.data.workspace}</strong> will review it.
            Once it is approved, sign in with <strong className="text-ink">{info.data.email}</strong> and
            the password you just chose.
          </p>
          <Link to="/login" className="mt-5 inline-block text-[13.5px] text-[var(--brand)] hover:underline">Go to sign in</Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-[23px] font-semibold text-ink tracking-[-0.01em]">Join {info.data.workspace}</h1>
      <p className="mt-1 text-[14px] text-subtle">
        {info.data.invited_by ? `${info.data.invited_by} invited you. ` : ''}
        Create your account and tell us your role. The owner, HR or a manager approves it before you can sign in.
      </p>

      <form className="mt-7 space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); if (ready) send.mutate(); }}>
        <Field label="Email" hint="Your account uses the address you were invited on">
          <Input value={info.data.email} readOnly className="text-muted" autoComplete="email" />
        </Field>
        <Field label="Full name" required error={fieldErrors.name}>
          <Input value={name} onChange={(e) => { setNameTouched(true); set('name', e.target.value); }} autoComplete="name" autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your role" required error={fieldErrors.role}>
            <Select value={form.role} onChange={(e) => set('role', e.target.value)}>
              <option value="" disabled>Choose…</option>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select>
          </Field>
          <Field label="Phone" error={fieldErrors.phone}>
            <Input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" />
          </Field>
          <Field label="Designation" error={fieldErrors.designation}>
            <Input value={form.designation} onChange={(e) => set('designation', e.target.value)} placeholder="e.g. Designer" />
          </Field>
          <Field label="Department" error={fieldErrors.department}>
            <Input value={form.department} onChange={(e) => set('department', e.target.value)} placeholder="e.g. Delivery" />
          </Field>
        </div>
        <Field label="Password" required hint="At least 8 characters" error={fieldErrors.password}>
          <PasswordInput value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password" required error={mismatch ? 'The passwords do not match' : undefined}>
          <PasswordInput value={form.confirm} onChange={(e) => set('confirm', e.target.value)} autoComplete="new-password" />
        </Field>

        <div className="border-t border-line pt-4 space-y-4">
          <p className="text-[13px] text-subtle leading-relaxed">
            If you ever forget your password, this is how you get back in on your own.
          </p>
          <SecurityQuestionFields value={security} onChange={setSecurity} errors={fieldErrors} />
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-[color-mix(in_srgb,var(--negative)_30%,transparent)]
                                      bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]">
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" size="lg" className="w-full justify-center"
          loading={send.isPending} disabled={!ready}
          icon={!send.isPending ? <ArrowRight size={16} /> : undefined}>
          Create my account
        </Button>
      </form>

      <p className="mt-5 text-center text-[13px] text-subtle">
        Already have an account? <Link to="/login" className="text-[var(--brand)] hover:underline">Sign in</Link>
      </p>
    </Shell>
  );
}
