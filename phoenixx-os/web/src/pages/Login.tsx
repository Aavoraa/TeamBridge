import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { Logo, LogoDisc, Wordmark } from '../components/Logo';

/** Three claims, not ten modules — the sign-in page is not the pitch deck. */
const POINTS = [
  'Action items, meetings and deadlines in one place',
  'CRM, proposals and GST invoicing that stay in sync',
  'HR, KPIs and profitability visible to the whole team',
];

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email.trim(), password, needsTotp ? totp : undefined);
      navigate((location.state as any)?.from?.pathname || '/', { replace: true });
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsTotp(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(err.message || 'Could not sign you in.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface lg:grid lg:grid-cols-[1.35fr_minmax(430px,1fr)]">

      {/* ------------------------------------------------------- brand side */}
      {/* One dark field, one warm glow, one mark. Everything else is type. */}
      <aside
        className="relative hidden overflow-hidden px-14 py-14 text-white lg:flex lg:flex-col lg:justify-between"
        style={{ background: '#14100d' }}
      >
        <div
          aria-hidden
          className="absolute inset-0"
          style={{ background: 'radial-gradient(circle at 78% 82%, rgba(226,89,38,0.26), transparent 55%)' }}
        />
        {/* The mark sits low and quiet, bleeding off the corner: present as
            texture, never competing with the headline for attention. */}
        <div aria-hidden className="pointer-events-none absolute -bottom-16 -right-12 select-none opacity-[0.16]">
          <Logo size={420} alt="" />
        </div>

        <Wordmark size={46} variant="onDark" className="relative" />

        <div className="relative max-w-[30rem]">
          <h1 className="text-[36px] font-bold leading-[1.2] tracking-[-0.02em]">
            Run the whole agency
            <span className="block text-[var(--brand-vivid)]">from one place.</span>
          </h1>
          <p className="mt-5 text-[15px] leading-[1.65] text-white/60">
            Phoenixx OS replaces the spreadsheets, chat threads and paperwork your
            team is holding together by hand.
          </p>

          <ul className="mt-8 space-y-3.5">
            {POINTS.map((p) => (
              <li key={p} className="flex items-start gap-3 text-[14.5px] leading-relaxed text-white/80">
                <span
                  aria-hidden
                  className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full"
                  style={{ background: 'rgba(226,89,38,0.16)' }}
                >
                  <Check size={12} strokeWidth={2.5} className="text-[var(--brand-vivid)]" />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[13px] text-white/40">
          Phoenixx IT · Coimbatore · Beyond Technology
        </p>
      </aside>

      {/* -------------------------------------------------------- form side */}
      {/* min-h-screen so the white panel owns the full viewport on a phone,
          where this column is the whole page rather than a grid track. */}
      <main className="flex min-h-screen flex-col justify-center bg-raised px-5 py-14 sm:px-10">
        <div className="mx-auto w-full max-w-[23rem]">

          {/* The brand panel is desktop-only, so on a phone the lockup carries
              it — left-aligned, so it shares the form's left edge. */}
          <Wordmark size={44} className="mb-10 lg:hidden" />
          <LogoDisc size={52} tone="light" className="hidden lg:grid" />

          <h2 className="mt-6 text-[26px] font-bold tracking-[-0.02em] text-ink">Welcome back</h2>
          <p className="mt-1.5 text-[14.5px] text-muted">Sign in to your workspace to continue.</p>

          <form onSubmit={submit} noValidate className="mt-8 space-y-5">
            <Field label="Work email">
              <Input
                type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                autoComplete="username" required placeholder="you@agency.com"
                className="h-11 text-[15px]"
              />
            </Field>

            <Field label="Password">
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'} value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password" required
                  className="h-11 pr-11 text-[15px]"
                />
                <button
                  type="button" onClick={() => setShowPassword((v) => !v)} tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-1 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center
                             rounded-md text-subtle transition-colors duration-150 hover:text-ink"
                >
                  {showPassword ? <EyeOff size={17} strokeWidth={1.75} /> : <Eye size={17} strokeWidth={1.75} />}
                </button>
              </div>
            </Field>

            {needsTotp && (
              <Field label="Authenticator code" hint="Six digits from your authenticator app">
                <Input
                  value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="one-time-code" placeholder="000000" required
                  className="mono h-11 text-center text-base tracking-[0.4em]"
                />
              </Field>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-md border border-[color-mix(in_srgb,var(--negative)_28%,transparent)]
                           bg-negative-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--negative)]"
              >
                {error}
              </p>
            )}

            <Button
              type="submit" variant="primary" size="lg" loading={loading}
              className="h-12 w-full justify-center text-[15.5px] font-semibold"
              icon={!loading ? <ArrowRight size={17} /> : undefined}
            >
              Sign in
            </Button>

            <div className="flex justify-center">
              <Link to="/recover" className="text-[13.5px] font-medium text-[var(--brand)] hover:underline">
                Forgot your password?
              </Link>
            </div>
          </form>

          <p className="mt-10 border-t border-line pt-6 text-center text-[14px] text-muted">
            New to Phoenixx?{' '}
            <Link to="/signup" className="font-semibold text-[var(--brand)] hover:underline">
              Start a 14-day trial
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
