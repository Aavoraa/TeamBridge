import {
  createContext, forwardRef, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, Check, AlertCircle, Loader2, Inbox, Search } from 'lucide-react';
import { initials, avatarColor } from '../lib/format';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/* ============================================================== BUTTON */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
  icon?: ReactNode;
};

// A filled variant never hard-codes its text colour: on light the brand fill is
// dark and takes white, on dark it is light and takes near-black. The paired
// --*-contrast token flips with the theme so both stay AA.
const BUTTON_VARIANTS = {
  primary: 'bg-[var(--brand)] text-[var(--brand-contrast)] hover:brightness-110 border-transparent shadow-[var(--shadow-sm)]',
  accent: 'bg-[var(--accent-bg)] text-[var(--accent-contrast)] hover:brightness-105 border-transparent shadow-[var(--shadow-sm)] font-semibold',
  secondary: 'bg-raised text-ink border-line-strong hover:bg-sunken',
  ghost: 'bg-transparent text-muted border-transparent hover:bg-sunken hover:text-ink',
  danger: 'bg-[var(--negative)] text-[var(--negative-contrast)] hover:brightness-110 border-transparent',
};

const BUTTON_SIZES = {
  // Every size clears the 44px touch target on coarse pointers via min-h.
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 min-h-[32px]',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2',
  icon: 'h-9 w-9 justify-center',
};

export function Button({
  variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center rounded-md border font-medium transition-colors duration-150',
        'disabled:opacity-50 disabled:pointer-events-none cursor-pointer select-none whitespace-nowrap',
        BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className,
      )}
    >
      {loading ? <Loader2 size={size === 'sm' ? 13 : 15} className="animate-spin shrink-0" /> : icon}
      {children}
    </button>
  );
}

/* =============================================================== BADGE */
type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning' | 'accent' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-sunken text-muted border-line',
  brand: 'bg-brand-soft text-[var(--brand)] border-[color-mix(in_srgb,var(--brand)_25%,transparent)]',
  info: 'bg-info-soft text-[var(--info)] border-[color-mix(in_srgb,var(--info)_25%,transparent)]',
  positive: 'bg-positive-soft text-[var(--positive)] border-[color-mix(in_srgb,var(--positive)_25%,transparent)]',
  negative: 'bg-negative-soft text-[var(--negative)] border-[color-mix(in_srgb,var(--negative)_25%,transparent)]',
  warning: 'bg-warning-soft text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_28%,transparent)]',
  accent: 'bg-accent-soft text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_28%,transparent)]',
};

export function Badge({ tone = 'neutral', children, className, dot }: {
  tone?: Tone; children: ReactNode; className?: string; dot?: boolean;
}) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-5 whitespace-nowrap',
      TONES[tone], className,
    )}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current shrink-0" aria-hidden />}
      {children}
    </span>
  );
}

/** Status colour is paired with the label text, never carried by colour alone. */
export const STATUS_TONES: Record<string, Tone> = {
  open: 'neutral', in_progress: 'brand', blocked: 'negative', done: 'positive', cancelled: 'neutral',
  draft: 'neutral', sent: 'brand', viewed: 'info', accepted: 'positive', rejected: 'negative', expired: 'neutral',
  paid: 'positive', partially_paid: 'warning', overdue: 'negative', written_off: 'neutral',
  lead: 'info', active: 'positive', churned: 'negative', lost: 'neutral',
  pending: 'warning', approved: 'positive', withdrawn: 'neutral',
  present: 'positive', absent: 'negative', half_day: 'warning', wfh: 'info', leave: 'brand',
  weekoff: 'neutral', holiday: 'neutral',
  urgent: 'negative', high: 'warning', medium: 'brand', low: 'neutral',
  sourced: 'neutral', screened: 'info', interview: 'brand', offer: 'accent', hired: 'positive',
  published: 'positive', archived: 'neutral',
  trial: 'accent', past_due: 'negative', suspended: 'negative',
  breached: 'negative', met: 'positive',
  healthy: 'positive', watch: 'warning', at_risk: 'negative', inactive: 'neutral',
};

export const StatusBadge = ({ status, className }: { status?: string | null; className?: string }) => (
  <Badge tone={STATUS_TONES[status || ''] || 'neutral'} dot className={className}>
    {(status || 'unknown').replace(/_/g, ' ')}
  </Badge>
);

/* ================================================================ CARD */
export function Card({ children, className, as: As = 'div' }: {
  children: ReactNode; className?: string; as?: any;
}) {
  return <As className={cx('card', className)}>{children}</As>;
}

export function CardHeader({ title, subtitle, action, icon, className }: {
  title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string;
}) {
  return (
    <div className={cx('flex items-start justify-between gap-3 border-b border-line px-4 py-3', className)}>
      <div className="min-w-0 flex-1 flex items-start gap-2.5">
        {icon && <span className="mt-0.5 text-[var(--brand)] shrink-0">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink leading-tight truncate">{title}</h2>
          {subtitle && <p className="text-[13px] text-subtle mt-0.5 leading-snug break-words">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/* ============================================================ STAT TILE */

/**
 * A 40-line inline sparkline. Deliberately not Recharts: this renders inside
 * KPI tiles at the top of most pages, and pulling the 100kB chart chunk into
 * that path to draw eight points would be a poor trade.
 */
export function Sparkline({ data, tone = 'var(--brand)', width = 68, height = 22 }: {
  data: number[]; tone?: string; width?: number; height?: number;
}) {
  if (!data || data.length < 2) return null;
  const lo = Math.min(...data);
  const hi = Math.max(...data);
  const span = hi - lo || 1;
  const step = width / (data.length - 1);
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`);
  const id = `sp${Math.abs(data.reduce((a, v, i) => a + v * (i + 1), 0)) | 0}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden
      className="overflow-visible shrink-0">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity={0.26} />
          <stop offset="100%" stopColor={tone} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts.join(' ')} ${width},${height}`} fill={`url(#${id})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={tone} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={y(data[data.length - 1])} r="2.25" fill={tone} />
    </svg>
  );
}

export function Stat({ label, value, sub, delta, tone, icon, onClick, className, spark, accent }: {
  label: string; value: ReactNode; sub?: ReactNode;
  delta?: { value: number; suffix?: string; invert?: boolean } | null;
  tone?: Tone; icon?: ReactNode; onClick?: () => void; className?: string;
  /** Recent history for the inline sparkline — oldest first. */
  spark?: number[];
  /** CSS colour driving the icon chip, sparkline and top edge. */
  accent?: string;
}) {
  // A rising cost is bad and a rising profit is good — `invert` says which.
  const good = delta ? (delta.invert ? delta.value < 0 : delta.value > 0) : false;
  const flat = !delta || Math.abs(delta.value) < 0.05;
  const hue = accent || (tone ? `var(--${tone})` : 'var(--brand)');

  const Wrapper: any = onClick ? 'button' : 'div';
  return (
    <Wrapper
      onClick={onClick}
      className={cx(
        'card relative overflow-hidden p-3.5 text-left w-full transition-all duration-150',
        onClick && 'cursor-pointer hover:border-line-strong hover:shadow-[var(--shadow-md)]',
        className,
      )}
    >
      {/* a hairline of the accent across the top, and a soft wash behind it */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: hue, opacity: 0.85 }} />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-[0.07]"
        style={{ background: `radial-gradient(circle, ${hue}, transparent 70%)` }}
      />

      <div className="flex items-center gap-2">
        {icon && (
          <span
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md"
            style={{ background: `color-mix(in srgb, ${hue} 14%, transparent)`, color: hue }}
          >
            {icon}
          </span>
        )}
        <span className="label-cap truncate">{label}</span>
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[23px] leading-7 font-semibold text-ink tabular tracking-[-0.01em]">{value}</span>
            {delta && !flat && (
              <span
                className={cx('rounded px-1.5 py-px text-[11.5px] font-semibold tabular',
                  good ? 'text-[var(--positive)] bg-positive-soft' : 'text-[var(--negative)] bg-negative-soft')}
              >
                {delta.value > 0 ? '▲' : '▼'} {Math.abs(delta.value).toFixed(Math.abs(delta.value) < 10 ? 1 : 0)}{delta.suffix ?? '%'}
              </span>
            )}
          </div>
          {sub && <div className="mt-1 text-[12.5px] text-subtle leading-snug">{sub}</div>}
        </div>
        {spark && spark.length > 1 && <Sparkline data={spark} tone={hue} />}
      </div>
    </Wrapper>
  );
}

/* =============================================================== TABLE */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  // Wide tables scroll inside their own container; the page never scrolls sideways.
  return (
    <div className="overflow-x-auto">
      <table className={cx('w-full text-sm border-collapse', className)}>{children}</table>
    </div>
  );
}

export const THead = ({ children }: { children: ReactNode }) => (
  <thead className="bg-sunken">{children}</thead>
);

export function TH({ children, align = 'left', className, width }: {
  children?: ReactNode; align?: 'left' | 'right' | 'center'; className?: string; width?: string;
}) {
  return (
    <th
      style={width ? { width } : undefined}
      className={cx(
        'label-cap px-3 py-2 font-semibold border-b border-line whitespace-nowrap',
        align === 'right' && 'text-right', align === 'center' && 'text-center', align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({ children, align = 'left', className, colSpan, mono }: {
  children?: ReactNode; align?: 'left' | 'right' | 'center'; className?: string; colSpan?: number; mono?: boolean;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        'px-3 py-2.5 border-b border-line align-middle text-ink',
        align === 'right' && 'text-right tabular', align === 'center' && 'text-center',
        mono && 'mono text-[13px]', className,
      )}
    >
      {children}
    </td>
  );
}

export const TR = ({ children, onClick, className }: {
  children: ReactNode; onClick?: () => void; className?: string;
}) => (
  <tr
    onClick={onClick}
    className={cx('row-hover', onClick && 'cursor-pointer', className)}
    {...(onClick ? { tabIndex: 0, role: 'button', onKeyDown: (e: any) => { if (e.key === 'Enter') onClick(); } } : {})}
  >
    {children}
  </tr>
);

/* =============================================================== FORMS */
export function Field({ label, hint, error, required, children, className }: {
  label?: string; hint?: string; error?: string; required?: boolean; children: ReactNode; className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('min-w-0', className)}>
      {label && (
        <label htmlFor={id} className="block text-[13px] font-medium text-muted mb-1.5">
          {label}{required && <span className="text-[var(--negative)] ml-0.5" aria-hidden>*</span>}
        </label>
      )}
      <FieldIdContext.Provider value={id}>{children}</FieldIdContext.Provider>
      {error
        ? <p className="mt-1 text-[12.5px] text-[var(--negative)] flex items-center gap-1"><AlertCircle size={12} />{error}</p>
        : hint && <p className="mt-1 text-[12.5px] text-subtle">{hint}</p>}
    </div>
  );
}

const FieldIdContext = createContext<string | undefined>(undefined);

const inputBase =
  'w-full rounded-md border border-line-strong bg-raised px-3 text-sm text-ink placeholder:text-subtle '
  + 'transition-colors duration-150 hover:border-[var(--ink-subtle)] '
  + 'disabled:opacity-60 disabled:cursor-not-allowed';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const id = useContext(FieldIdContext);
  return <input id={props.id || id} {...props} className={cx(inputBase, 'h-9', className)} />;
}

/** Ref-forwarding: the chat composer needs the caret position to complete @names. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    const id = useContext(FieldIdContext);
    return (
      <textarea ref={ref} id={props.id || id} rows={3} {...props}
        className={cx(inputBase, 'py-2 leading-relaxed resize-y', className)} />
    );
  },
);

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useContext(FieldIdContext);
  return (
    <div className="relative">
      <select
        id={props.id || id}
        {...props}
        className={cx(inputBase, 'h-9 appearance-none pr-8 cursor-pointer', className)}
      >
        {children}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle" />
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={cx('flex items-start gap-2.5 text-sm text-ink select-none py-1',
      disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer')}>
      <span className="relative flex items-center justify-center mt-0.5 shrink-0">
        <input
          type="checkbox" checked={checked} disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer h-[17px] w-[17px] appearance-none rounded border border-line-strong bg-raised
                     checked:bg-[var(--brand)] checked:border-[var(--brand)] transition-colors duration-150 cursor-pointer"
        />
        <Check size={12} strokeWidth={3} className="pointer-events-none absolute text-white opacity-0 peer-checked:opacity-100" />
      </span>
      <span className="leading-snug">{label}</span>
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  return (
    <div className={cx('relative', className)}>
      <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
      <input
        type="search" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} aria-label={placeholder}
        className={cx(inputBase, 'h-9 pl-8')}
      />
    </div>
  );
}

/* =============================================================== MODAL */
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus moves into the dialog so keyboard users are not stranded behind it.
    setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus(), 40);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className={cx(
          'relative w-full bg-raised border border-line shadow-[var(--shadow-lg)] animate-in',
          'rounded-t-xl sm:rounded-xl max-h-[92vh] sm:max-h-[88vh] flex flex-col', widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {subtitle && <p className="text-[13px] text-subtle mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close dialog"
            className="text-subtle hover:text-ink transition-colors duration-150 cursor-pointer p-1 -m-1 rounded">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto grow">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-line bg-sunken rounded-b-xl flex justify-end gap-2 shrink-0">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ============================================================== DRAWER */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-xl' }: {
  open: boolean; onClose: () => void; title: string; subtitle?: ReactNode;
  children: ReactNode; footer?: ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-950/45" onClick={onClose} aria-hidden />
      <aside
        role="dialog" aria-modal="true" aria-label={title}
        className={cx('relative w-full bg-raised border-l border-line shadow-[var(--shadow-lg)] flex flex-col animate-in', width)}
      >
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink truncate">{title}</h2>
            {subtitle && <div className="text-[13px] text-subtle mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close panel"
            className="text-subtle hover:text-ink transition-colors duration-150 cursor-pointer p-1 -m-1">
            <X size={18} />
          </button>
        </header>
        <div className="grow overflow-y-auto">{children}</div>
        {footer && <footer className="px-5 py-3.5 border-t border-line bg-sunken flex justify-end gap-2 shrink-0">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

/* ================================================================ TABS */
export function Tabs({ tabs, active, onChange, className }: {
  tabs: { id: string; label: string; count?: number; icon?: ReactNode }[];
  active: string; onChange: (id: string) => void; className?: string;
}) {
  return (
    <div className={cx('flex gap-1 border-b border-line overflow-x-auto', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id} role="tab" aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'relative flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap cursor-pointer',
            'transition-colors duration-150 border-b-2 -mb-px',
            active === t.id
              ? 'border-[var(--brand)] text-[var(--brand)]'
              : 'border-transparent text-subtle hover:text-ink',
          )}
        >
          {t.icon}
          {t.label}
          {t.count != null && (
            <span className={cx('rounded-full px-1.5 py-px text-[11px] tabular font-semibold',
              active === t.id ? 'bg-brand-soft text-[var(--brand)]' : 'bg-sunken text-subtle')}>
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* =========================================================== FEEDBACK */
export function EmptyState({ icon, title, message, action, compact }: {
  icon?: ReactNode; title: string; message?: string; action?: ReactNode; compact?: boolean;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'py-8 px-4' : 'py-14 px-6')}>
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-sunken text-subtle">
        {icon || <Inbox size={20} />}
      </div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-[13.5px] text-subtle leading-relaxed">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: any; retry?: () => void }) {
  return (
    <EmptyState
      icon={<AlertCircle size={20} className="text-[var(--negative)]" />}
      title={error?.status === 403 ? 'You do not have access to this' : 'Something went wrong'}
      message={error?.message || 'The request could not be completed.'}
      action={retry && error?.status !== 403 ? <Button onClick={retry}>Try again</Button> : undefined}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden />;
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="p-3 space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cx('h-8', c === 0 ? 'w-[28%]' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ============================================================== AVATAR */
export function Avatar({ name, url, size = 28, className }: {
  name?: string | null; url?: string | null; size?: number; className?: string;
}) {
  if (url) {
    return (
      <img src={url} alt="" width={size} height={size}
        className={cx('rounded-full object-cover shrink-0', className)} style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      aria-hidden
      className={cx('inline-grid place-items-center rounded-full font-semibold text-white shrink-0', className)}
      style={{ width: size, height: size, background: avatarColor(name), fontSize: size * 0.38 }}
    >
      {initials(name)}
    </span>
  );
}

export const AvatarWithName = ({ name, url, sub, size = 28 }: {
  name?: string | null; url?: string | null; sub?: ReactNode; size?: number;
}) => (
  <span className="flex items-center gap-2.5 min-w-0">
    <Avatar name={name} url={url} size={size} />
    <span className="min-w-0">
      <span className="block truncate text-ink font-medium leading-tight">{name || '—'}</span>
      {sub && <span className="block truncate text-[12px] text-subtle leading-tight">{sub}</span>}
    </span>
  </span>
);

/* ============================================================== TOASTS */
type Toast = { id: number; message: string; tone: Tone; title?: string };
const ToastContext = createContext<{ push: (t: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = (t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 5200);
  };

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {createPortal(
        <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[min(24rem,calc(100vw-2rem))]"
          role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id}
              className={cx('card px-4 py-3 shadow-[var(--shadow-lg)] animate-in border-l-4',
                t.tone === 'negative' ? 'border-l-[var(--negative)]'
                  : t.tone === 'positive' ? 'border-l-[var(--positive)]'
                    : t.tone === 'warning' ? 'border-l-[var(--warning)]' : 'border-l-[var(--brand)]')}>
              {t.title && <p className="text-[13.5px] font-semibold text-ink">{t.title}</p>}
              <p className="text-[13px] text-muted leading-snug">{t.message}</p>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  return {
    success: (message: string, title?: string) => ctx?.push({ message, title, tone: 'positive' }),
    error: (message: string, title?: string) => ctx?.push({ message, title, tone: 'negative' }),
    info: (message: string, title?: string) => ctx?.push({ message, title, tone: 'brand' }),
    warn: (message: string, title?: string) => ctx?.push({ message, title, tone: 'warning' }),
  };
}

/* =========================================================== PAGE SHELL */
export function PageHeader({ title, subtitle, actions, tabs }: {
  title: string; subtitle?: ReactNode; actions?: ReactNode; tabs?: ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[21px] leading-7 font-semibold text-ink tracking-[-0.01em]">{title}</h1>
          {subtitle && <div className="mt-0.5 text-[13.5px] text-subtle">{subtitle}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap no-print">{actions}</div>}
      </div>
      {tabs && <div className="mt-3">{tabs}</div>}
    </div>
  );
}

/** Horizontal progress meter with the value stated in text, not colour alone. */
export function Meter({ value, max = 100, tone = 'brand', className, showLabel }: {
  value: number; max?: number; tone?: Tone; className?: string; showLabel?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const colors: Record<string, string> = {
    brand: 'var(--brand)', positive: 'var(--positive)', negative: 'var(--negative)',
    warning: 'var(--warning)', accent: 'var(--accent-bg)', info: 'var(--info)', neutral: 'var(--ink-subtle)',
  };
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <div className="h-1.5 flex-1 rounded-full bg-sunken overflow-hidden min-w-[40px]"
        role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: colors[tone] }} />
      </div>
      {showLabel && <span className="text-[12px] tabular text-subtle w-9 text-right">{Math.round(pct)}%</span>}
    </div>
  );
}

/** Confirmation for destructive or irreversible actions. */
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading }: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }>
      <div className="text-sm text-muted leading-relaxed">{message}</div>
    </Modal>
  );
}
