import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, AlertTriangle } from 'lucide-react';
import { api, tokens } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/Logo';
import { Button, Field, Input } from '../components/ui';
import {
  SecurityQuestionFields, EMPTY_SECURITY_QUESTION, isSecurityQuestionComplete,
  type SecurityQuestionValue,
} from '../components/SecurityQuestion';

/** Invitation acceptance — the invitee sets their own password. */
export default function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const token = params.get('token') || '';

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [security, setSecurity] = useState<SecurityQuestionValue>(EMPTY_SECURITY_QUESTION);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const accept = useMutation({
    mutationFn: () => api.post('/auth/accept-invite', {
      token,
      password,
      ...(name.trim() ? { name: name.trim() } : {}),
      security_question: security.question.trim(),
      security_answer: security.answer.trim(),
    }),
    onSuccess: async (res: any) => {
      tokens.set(res.data.access_token, res.data.refresh_token);
      await refresh();
      navigate('/', { replace: true });
    },
    onError: (e: any) => { setError(e.message); setFieldErrors(e.fieldErrors || {}); },
  });

  const mismatch = confirm.length > 0 && password !== confirm;

  if (!token) {
    return (
      <div className="min-h-screen grid place-items-center bg-surface px-5">
        <div className="text-center max-w-sm">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-sunken">
            <AlertTriangle size={22} className="text-subtle" />
          </div>
          <h1 className="text-[18px] font-semibold text-ink">Invitation link is incomplete</h1>
          <p className="mt-1.5 text-[13.5px] text-subtle">
            Please use the full link you were sent, or ask for a fresh invitation.
          </p>
          <Link to="/login" className="mt-4 inline-block text-[13.5px] text-[var(--brand)] hover:underline">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center bg-surface px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8">
          <Logo size={36} />
          <span className="font-semibold text-ink">Phoenixx OS</span>
        </div>

        <h1 className="text-[23px] font-semibold text-ink tracking-[-0.01em]">Set up your account</h1>
        <p className="mt-1 text-[14px] text-subtle">
          Choose a password and a security question, and you are in. Your role and team are
          already set up for you.
        </p>

        <form className="mt-7 space-y-4" onSubmit={(e) => { e.preventDefault(); accept.mutate(); }} noValidate>
          <Field label="Your name" hint="Leave blank to keep the name you were invited with">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Priya Venkatesh" />
          </Field>
          <Field label="Password" required hint="At least 8 characters">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" autoFocus />
          </Field>
          <Field label="Confirm password" required error={mismatch ? 'The passwords do not match' : undefined}>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password" />
          </Field>

          {/* The only moment we can be sure the new user is here to choose one.
              Without it, forgetting the password means asking an owner or HR. */}
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
            loading={accept.isPending}
            disabled={password.length < 8 || mismatch || !isSecurityQuestionComplete(security)}
            icon={!accept.isPending ? <ArrowRight size={16} /> : undefined}>
            Finish setting up
          </Button>
        </form>

        <p className="mt-5 text-center text-[13px] text-subtle">
          Already set up? <Link to="/login" className="text-[var(--brand)] hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
