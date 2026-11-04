import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowLeft, Check } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/Logo';
import { api, ApiError } from '../lib/api';
import { money } from '../lib/format';
import { Button, Field, Input, cx } from '../components/ui';
import {
  SecurityQuestionFields, EMPTY_SECURITY_QUESTION, isSecurityQuestionComplete,
  type SecurityQuestionValue,
} from '../components/SecurityQuestion';

/**
 * S7 — tenant self-signup. Three short steps rather than one long form:
 * agency → account → plan. The trial needs no card, so the plan step is a
 * preference, not a payment.
 */
export default function Signup() {
  const { signUp } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    agency_name: '', city: 'Coimbatore',
    owner_name: '', email: '', phone: '', password: '',
    plan_code: 'growth' as 'starter' | 'growth' | 'scale',
  });
  const [security, setSecurity] = useState<SecurityQuestionValue>(EMPTY_SECURITY_QUESTION);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const { data: plans } = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get('/plans').then((r) => r.data),
  });

  const set = (k: string, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFieldErrors((e) => ({ ...e, [k]: '' }));
  };

  const STEPS = ['Your agency', 'Your account', 'Pick a plan'];

  const canAdvance = () => {
    if (step === 0) return form.agency_name.trim().length >= 2;
    if (step === 1) return form.owner_name.trim().length >= 2
      && /\S+@\S+\.\S+/.test(form.email) && form.password.length >= 8
      && isSecurityQuestionComplete(security);
    return true;
  };

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      await signUp({
        agency_name: form.agency_name.trim(),
        owner_name: form.owner_name.trim(),
        email: form.email.trim().toLowerCase(),
        password: form.password,
        phone: form.phone || undefined,
        city: form.city || undefined,
        plan_code: form.plan_code,
        security_question: security.question.trim(),
        security_answer: security.answer.trim(),
      });
      navigate('/', { replace: true });
    } catch (err: any) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        setError(err.message);
        if (err.fieldErrors.email || err.code === 'conflict') setStep(1);
      } else setError(err.message || 'Could not create the workspace.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="border-b border-line bg-raised">
        <div className="max-w-3xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link to="/login" className="flex items-center gap-2.5">
            <Logo size={32} />
            <span className="font-semibold text-ink text-[15px]">Phoenixx OS</span>
          </Link>
          <Link to="/login" className="text-[13.5px] text-[var(--brand)] hover:underline">Sign in instead</Link>
        </div>
      </header>

      <main className="flex-1 px-5 py-9">
        <div className="max-w-xl mx-auto">
          {/* progress */}
          <ol className="flex items-center gap-2 mb-8">
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-2 flex-1 last:flex-none">
                <span className={cx('grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold transition-colors duration-200',
                  i < step ? 'bg-[var(--positive)] text-white'
                    : i === step ? 'bg-[var(--brand)] text-white' : 'bg-sunken text-subtle')}>
                  {i < step ? <Check size={14} strokeWidth={3} /> : i + 1}
                </span>
                <span className={cx('text-[13px] font-medium whitespace-nowrap',
                  i === step ? 'text-ink' : 'text-subtle')}>{label}</span>
                {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line ml-1" aria-hidden />}
              </li>
            ))}
          </ol>

          <div className="card p-6">
            {step === 0 && (
              <div className="space-y-4">
                <div>
                  <h1 className="text-[20px] font-semibold text-ink">Let's set up your workspace</h1>
                  <p className="mt-1 text-[13.5px] text-subtle">
                    We'll seed it with SOP packs, KPI sets and proposal templates for the four
                    agency service lines, so it's usable on day one.
                  </p>
                </div>
                <Field label="Agency name" required error={fieldErrors.agency_name}>
                  <Input value={form.agency_name} onChange={(e) => set('agency_name', e.target.value)}
                    placeholder="Phoenixx IT" autoFocus />
                </Field>
                <Field label="City" hint="Used on invoices and for your default tax profile">
                  <Input value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Coimbatore" />
                </Field>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <h1 className="text-[20px] font-semibold text-ink">Create the owner account</h1>
                  <p className="mt-1 text-[13.5px] text-subtle">You can invite the rest of the team afterwards.</p>
                </div>
                <Field label="Your name" required error={fieldErrors.owner_name}>
                  <Input value={form.owner_name} onChange={(e) => set('owner_name', e.target.value)}
                    placeholder="Arun Prakash" autoFocus />
                </Field>
                <Field label="Work email" required error={fieldErrors.email}>
                  <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)}
                    placeholder="you@agency.com" autoComplete="username" />
                </Field>
                <Field label="Mobile" hint="Used for WhatsApp alerts on deadlines and escalations">
                  <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+91 98765 43210" />
                </Field>
                <Field label="Password" required hint="At least 8 characters" error={fieldErrors.password}>
                  <Input type="password" value={form.password} onChange={(e) => set('password', e.target.value)}
                    autoComplete="new-password" />
                </Field>

                {/* An owner is the top of their own workspace - there is nobody
                    above them to reset a forgotten password. */}
                <div className="border-t border-line pt-4 space-y-4">
                  <p className="text-[13px] text-subtle leading-relaxed">
                    Nobody can reset an owner password for you, so set a question you can
                    answer if you are ever locked out.
                  </p>
                  <SecurityQuestionFields value={security} onChange={setSecurity} errors={fieldErrors} />
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <div>
                  <h1 className="text-[20px] font-semibold text-ink">Pick a starting plan</h1>
                  <p className="mt-1 text-[13.5px] text-subtle">
                    Fourteen days free, no card needed. Flat rate by team size — every plan has
                    unlimited users within its band.
                  </p>
                </div>
                <div className="space-y-2.5">
                  {(plans || []).map((p: any) => (
                    <button key={p.code} type="button" onClick={() => set('plan_code', p.code)}
                      className={cx('w-full rounded-lg border p-3.5 text-left transition-colors duration-150 cursor-pointer',
                        form.plan_code === p.code
                          ? 'border-[var(--brand)] bg-brand-soft ring-1 ring-[var(--brand)]'
                          : 'border-line bg-raised hover:border-line-strong')}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold text-ink">{p.name}</span>
                        <span className="text-ink font-semibold tabular">
                          {money(p.price_monthly_minor)}<span className="text-subtle font-normal text-[13px]">/mo</span>
                        </span>
                      </div>
                      <p className="mt-0.5 text-[13px] text-subtle">
                        {p.band_min_users === 1 ? `Up to ${p.band_max_users}` : `${p.band_min_users}–${p.band_max_users}`} users
                        {p.limits.clients ? ` · ${p.limits.clients} clients` : ' · unlimited clients'}
                        {p.features.client_portal ? ' · client portal' : ''}
                        {p.features.api_access ? ' · API access' : ''}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="mt-4 rounded-md border border-[color-mix(in_srgb,var(--negative)_30%,transparent)]
                                          bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]">
                {error}
              </p>
            )}

            <div className="mt-6 flex items-center justify-between gap-3">
              {step > 0 ? (
                <Button onClick={() => setStep((s) => s - 1)} icon={<ArrowLeft size={15} />}>Back</Button>
              ) : <span />}

              {step < 2 ? (
                <Button variant="primary" onClick={() => setStep((s) => s + 1)}
                  disabled={!canAdvance()} icon={<ArrowRight size={15} />}>Continue</Button>
              ) : (
                <Button variant="primary" onClick={submit} loading={loading} icon={<ArrowRight size={15} />}>
                  Create workspace
                </Button>
              )}
            </div>
          </div>

          <p className="mt-4 text-center text-[12.5px] text-subtle">
            By continuing you agree that your workspace data is stored per the tenant isolation and
            retention rules described in your data-processing terms.
          </p>
        </div>
      </main>
    </div>
  );
}
