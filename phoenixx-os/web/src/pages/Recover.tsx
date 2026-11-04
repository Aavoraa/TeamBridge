import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, ArrowLeft, ShieldQuestion, Check, Lock } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Logo } from '../components/Logo';
import { Button, Field, Input, cx } from '../components/ui';

/**
 * Password recovery by security question. Three requests, in this order:
 *
 *   start  → hands back the question this email has to answer
 *   verify → checks the answer and returns a short-lived reset token
 *   reset  → sets the new password with that token
 *
 * The new password deliberately never travels with the answer, and no session is
 * issued at the end: the user signs in normally afterwards, so an account with
 * two-factor on still goes through the authenticator.
 */

type Step = 'email' | 'answer' | 'password' | 'done';

const STEPS: { id: Step; label: string }[] = [
  { id: 'email', label: 'Your email' },
  { id: 'answer', label: 'Security question' },
  { id: 'password', label: 'New password' },
];

export default function Recover() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [question, setQuestion] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [answer, setAnswer] = useState('');
  const [totp, setTotp] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState('');

  const start = useMutation({
    mutationFn: () => api.post('/auth/recovery/start', { email: email.trim().toLowerCase() }),
    onSuccess: (res: any) => {
      if (!res.data.available) {
        setUnavailable(res.data.message);
        return;
      }
      setQuestion(res.data.question);
      setTotpRequired(!!res.data.totp_required);
      setStep('answer');
    },
    onError: (e: any) => setError(e.message),
  });

  const verify = useMutation({
    mutationFn: () => api.post('/auth/recovery/verify', {
      email: email.trim().toLowerCase(),
      answer,
      ...(totpRequired && totp ? { totp } : {}),
    }),
    onSuccess: (res: any) => {
      setResetToken(res.data.reset_token);
      setStep('password');
    },
    onError: (e: any) => {
      // The server counts the attempt, so its message carries the tries left.
      if (e instanceof ApiError && e.code === 'totp_required') setTotpRequired(true);
      setError(e.message);
    },
  });

  const reset = useMutation({
    mutationFn: () => api.post('/auth/recovery/reset', {
      reset_token: resetToken, new_password: password,
    }),
    onSuccess: () => setStep('done'),
    onError: (e: any) => setError(e.message),
  });

  const mismatch = confirm.length > 0 && password !== confirm;
  const busy = start.isPending || verify.isPending || reset.isPending;

  const back = () => {
    setError('');
    if (step === 'answer') { setStep('email'); setAnswer(''); setTotp(''); }
    else if (step === 'password') { setStep('answer'); setPassword(''); setConfirm(''); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setUnavailable('');
    if (step === 'email') start.mutate();
    else if (step === 'answer') verify.mutate();
    else if (step === 'password') reset.mutate();
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="border-b border-line bg-raised">
        <div className="max-w-md mx-auto px-5 h-14 flex items-center">
          <Link to="/login" className="flex items-center gap-2.5">
            <Logo size={32} />
            <span className="font-semibold text-ink text-[15px]">Phoenixx OS</span>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-md">
          {step === 'done' ? (
            <div className="text-center">
              <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-positive-soft">
                <Check size={22} className="text-[var(--positive)]" />
              </div>
              <h1 className="text-[22px] font-semibold text-ink tracking-[-0.01em]">Password updated</h1>
              <p className="mt-2 text-[14px] text-subtle leading-relaxed">
                Every other session has been signed out. Sign in with your new password —
                if you use an authenticator app, you will still be asked for the code.
              </p>
              <Button variant="primary" size="lg" className="w-full justify-center mt-6"
                icon={<ArrowRight size={16} />} onClick={() => navigate('/login', { replace: true })}>
                Go to sign in
              </Button>
            </div>
          ) : (
            <>
              {/* --------------------------------------------------- stepper */}
              <ol className="flex items-center gap-2 mb-7">
                {STEPS.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-2 flex-1 last:flex-none">
                    <span className={cx(
                      'grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold',
                      i < stepIndex ? 'bg-[var(--positive)] text-white'
                        : i === stepIndex ? 'bg-[var(--brand)] text-white'
                          : 'bg-sunken text-subtle',
                    )}>
                      {i < stepIndex ? <Check size={13} /> : i + 1}
                    </span>
                    <span className={cx('text-[12.5px] whitespace-nowrap',
                      i === stepIndex ? 'text-ink font-medium' : 'text-subtle')}>
                      {s.label}
                    </span>
                    {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line" />}
                  </li>
                ))}
              </ol>

              <h1 className="text-[23px] font-semibold text-ink tracking-[-0.01em]">
                {step === 'email' && 'Recover your account'}
                {step === 'answer' && 'Answer your security question'}
                {step === 'password' && 'Choose a new password'}
              </h1>
              <p className="mt-1.5 text-[14px] text-subtle leading-relaxed">
                {step === 'email' && 'Answer the question you set up and you can set a new password. Nothing is emailed.'}
                {step === 'answer' && 'Capitals, extra spaces and a full stop at the end do not matter.'}
                {step === 'password' && 'This signs out every other session on your account.'}
              </p>

              <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
                {step === 'email' && (
                  <Field label="Work email" required>
                    <Input type="email" value={email} autoFocus autoComplete="username"
                      placeholder="you@agency.com"
                      onChange={(e) => { setEmail(e.target.value); setUnavailable(''); }} />
                  </Field>
                )}

                {step === 'answer' && (
                  <>
                    <div className="rounded-lg border border-line bg-raised p-3.5">
                      <p className="flex items-center gap-1.5 label-cap mb-1.5">
                        <ShieldQuestion size={13} /> Your question
                      </p>
                      <p className="text-[14px] text-ink leading-snug">{question}</p>
                    </div>
                    <Field label="Your answer" required>
                      <Input value={answer} autoFocus autoComplete="off" spellCheck={false}
                        onChange={(e) => { setAnswer(e.target.value); setError(''); }} />
                    </Field>
                    {totpRequired && (
                      <Field label="Authenticator code" required
                        hint="A security question alone will not get past two-factor">
                        <Input value={totp} inputMode="numeric" autoComplete="one-time-code" placeholder="000000"
                          className="mono tracking-[0.35em] text-center text-base"
                          onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
                      </Field>
                    )}
                  </>
                )}

                {step === 'password' && (
                  <>
                    <Field label="New password" required hint="At least 8 characters">
                      <Input type="password" value={password} autoFocus autoComplete="new-password"
                        onChange={(e) => { setPassword(e.target.value); setError(''); }} />
                    </Field>
                    <Field label="Confirm new password" required
                      error={mismatch ? 'The passwords do not match' : undefined}>
                      <Input type="password" value={confirm} autoComplete="new-password"
                        onChange={(e) => setConfirm(e.target.value)} />
                    </Field>
                  </>
                )}

                {unavailable && (
                  <p role="status" className="rounded-md border border-line bg-raised px-3 py-2.5
                                              text-[13px] text-muted leading-relaxed flex gap-2">
                    <Lock size={14} className="mt-0.5 shrink-0 text-subtle" />
                    {unavailable}
                  </p>
                )}

                {error && (
                  <p role="alert" className="rounded-md border border-[color-mix(in_srgb,var(--negative)_30%,transparent)]
                                              bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]">
                    {error}
                  </p>
                )}

                <Button type="submit" variant="primary" size="lg" loading={busy}
                  className="w-full justify-center"
                  disabled={
                    (step === 'email' && !/\S+@\S+\.\S+/.test(email))
                    || (step === 'answer' && (!answer.trim() || (totpRequired && totp.length < 6)))
                    || (step === 'password' && (password.length < 8 || mismatch))
                  }
                  icon={!busy ? <ArrowRight size={16} /> : undefined}>
                  {step === 'email' && 'Continue'}
                  {step === 'answer' && 'Check my answer'}
                  {step === 'password' && 'Set new password'}
                </Button>
              </form>

              <div className="mt-5 flex items-center justify-between text-[13px]">
                {step === 'email'
                  ? <span />
                  : (
                    <button type="button" onClick={back}
                      className="flex items-center gap-1 text-subtle hover:text-ink transition-colors cursor-pointer">
                      <ArrowLeft size={14} /> Back
                    </button>
                  )}
                <Link to="/login" className="text-[var(--brand)] hover:underline">Back to sign in</Link>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
