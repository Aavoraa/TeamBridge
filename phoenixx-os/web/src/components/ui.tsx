import {
  createContext, forwardRef, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, Check, AlertCircle, Loader2, Inbox, Search, ArrowUp, ArrowDown } from 'lucide-react';
import { useStockPhoto, avatarTint } from '../lib/avatar';
import { initials, avatarStyle } from '../lib/format';

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
  primary: 'bg-[var(--brand)] text-[var(--brand-contrast)] hover:brightness-110 border-transparent',
  // The soft green of the design's "Upgrade Now": a quieter call to action.
  accent: 'bg-brand-soft text-[var(--brand)] hover:brightness-[0.97] border-transparent font-semibold',
  secondary: 'bg-raised text-ink border-line-strong hover:bg-sunken',
  ghost: 'bg-transparent text-muted border-transparent hover:bg-sunken hover:text-ink',
  danger: 'bg-[var(--negative)] text-[var(--negative-contrast)] hover:brightness-110 border-transparent',
};

const BUTTON_SIZES = {
  // Every size clears the 44px touch target on coarse pointers via min-h.
  sm: 'h-8 px-3 text-[13px] gap-1.5 min-h-[32px] rounded-[9px]',
  md: 'h-10 px-4 text-[14px] gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-[12px]',
  icon: 'h-10 w-10 justify-center rounded-[10px]',
};

export function Button({
  variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center border font-medium transition-[background-color,color,filter] duration-150',
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

// Soft pills with no outline, like the design's "Meeting" and "Review" tags.
const TONES: Record<Tone, string> = {
  neutral: 'bg-sunken text-muted',
  brand: 'bg-brand-soft text-[var(--brand)]',
  info: 'bg-info-soft text-[var(--info)]',
  positive: 'bg-positive-soft text-[var(--positive)]',
  negative: 'bg-negative-soft text-[var(--negative)]',
  warning: 'bg-warning-soft text-[var(--warning)]',
  accent: 'bg-accent-soft text-[var(--accent)]',
};

export function Badge({ tone = 'neutral', children, className, dot }: {
  tone?: Tone; children: ReactNode; className?: string; dot?: boolean;
}) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-0.5 text-[12px] font-medium leading-5 whitespace-nowrap',
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
    // Wraps: on a phone the controls drop below the title instead of crushing it.
    <div className={cx('flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-3', className)}>
      <div className="min-w-[min(200px,100%)] flex-1 flex items-center gap-2.5">
        {icon && <span className="text-[var(--brand-vivid)] shrink-0">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold text-ink leading-tight tracking-[-0.015em] truncate">{title}</h2>
          {subtitle && <p className="text-[13.5px] text-subtle mt-1 leading-snug break-words">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="max-w-full min-w-0 flex flex-wrap items-center gap-2 text-[13.5px]">{action}</div>}
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

/** "↑ +18.2% vs last month" - the change line under a figure. `invert` when a rise is bad (costs). */
export function Delta({ value, suffix = '%', invert, label = 'vs last month', className }: {
  value: number; suffix?: string; invert?: boolean; label?: string; className?: string;
}) {
  if (!Number.isFinite(value)) return null;
  const flat = Math.abs(value) < 0.05;
  const good = invert ? value < 0 : value > 0;
  const n = Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0);
  return (
    <p className={cx('flex items-center gap-1 text-[13px] tabular', className)}>
      {flat ? <span className="font-medium text-subtle">No change</span> : (
        <span className={cx('inline-flex items-center gap-0.5 font-medium', good ? 'text-[var(--positive)]' : 'text-[var(--negative)]')}>
          {value > 0 ? <ArrowUp size={13} strokeWidth={2.4} /> : <ArrowDown size={13} strokeWidth={2.4} />}
          {value > 0 ? '+' : '-'}{n}{suffix}
        </span>
      )}
      {label && <span className="text-subtle">{label}</span>}
    </p>
  );
}

/**
 * A key figure: a round tinted icon, the label in quiet grey, the value large,
 * and the change underneath - the "Overview Analytics" tile of the design.
 */
export function Stat({ label, value, sub, delta, tone, icon, onClick, className, spark, accent }: {
  label: string; value: ReactNode; sub?: ReactNode;
  delta?: { value: number; suffix?: string; invert?: boolean; label?: string } | null;
  tone?: Tone; icon?: ReactNode; onClick?: () => void; className?: string;
  /** Recent history for the inline sparkline — oldest first. */
  spark?: number[];
  /** CSS colour driving the icon disc and the sparkline. */
  accent?: string;
}) {
  const hue = accent || (tone && tone !== 'neutral' ? `var(--${tone})` : 'var(--brand-vivid)');
  const Wrapper: any = onClick ? 'button' : 'div';
  return (
    <Wrapper
      onClick={onClick}
      className={cx(
        'card p-4 text-left w-full transition-shadow duration-150',
        onClick && 'cursor-pointer hover:shadow-[var(--shadow-md)]',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {icon && (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
            style={{ background: `color-mix(in srgb, ${hue} 13%, transparent)`, color: hue }}>
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] text-subtle">{label}</p>
          <div className="mt-0.5 flex flex-wrap items-end justify-between gap-x-2">
            <span className="text-[26px] leading-8 font-semibold tracking-[-0.025em] text-ink tabular">{value}</span>
            {spark && spark.length > 1 && <Sparkline data={spark} tone={hue} />}
          </div>
          {delta && <Delta value={delta.value} suffix={delta.suffix} invert={delta.invert} label={delta.label ?? 'vs last period'} className="mt-1" />}
          {sub && <div className="mt-1 text-[12.5px] text-subtle leading-snug">{sub}</div>}
        </div>
      </div>
    </Wrapper>
  );
}

/* =============================================================== TABLE */
export function Table({ children, className, keepColumns }: {
  children: ReactNode; className?: string;
  /** Keep real columns on a phone (scrolling sideways) where comparing down a column is the point. */
  keepColumns?: boolean;
}) {
  const ref = useRef<HTMLTableElement>(null);

  /**
   * On a phone each row becomes a small card (see .rt in index.css), and every
   * value needs its column's name beside it. Cells do not know their header, so
   * the labels are copied here - and again whenever rows load or change, since a
   * row can update without this component rendering.
   */
  useEffect(() => {
    const table = ref.current;
    if (!table || keepColumns) return undefined;
    const label = () => {
      const heads = [...table.querySelectorAll('thead tr:last-child th')].map((th) => th.textContent?.trim() || '');
      table.querySelectorAll('tbody tr').forEach((tr) => {
        let col = 0;
        for (const cell of Array.from(tr.children) as HTMLTableCellElement[]) {
          const name = cell.colSpan === 1 ? heads[col] : '';
          if (name) { if (cell.dataset.label !== name) cell.dataset.label = name; } else if (cell.dataset.label) delete cell.dataset.label;
          col += cell.colSpan || 1;
        }
      });
    };
    label();
    const watch = new MutationObserver(label);
    watch.observe(table, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [keepColumns]);

  // Anything still too wide scrolls inside its own container; the page never scrolls sideways.
  return (
    <div className="overflow-x-auto">
      <table ref={ref} className={cx('w-full text-sm border-collapse', !keepColumns && 'rt', className)}>{children}</table>
    </div>
  );
}

export const THead = ({ children }: { children: ReactNode }) => (
  <thead className="bg-sunken/70">{children}</thead>
);

export function TH({ children, align = 'left', className, width }: {
  children?: ReactNode; align?: 'left' | 'right' | 'center'; className?: string; width?: string;
}) {
  return (
    <th
      style={width ? { width } : undefined}
      className={cx(
        'px-4 py-2.5 text-[12.5px] font-medium text-subtle border-b border-line whitespace-nowrap',
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
        'px-4 py-3 border-b border-line align-middle text-ink',
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
        <label htmlFor={id} className="block text-[13.5px] font-medium text-ink mb-1.5">
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
  'w-full rounded-[10px] border border-line-strong bg-raised px-3.5 text-[14px] text-ink placeholder:text-subtle '
  + 'transition-[border-color,box-shadow] duration-150 hover:border-[var(--ink-subtle)] '
  + 'focus:outline-none focus:border-[var(--brand-vivid)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--brand-vivid)_18%,transparent)] '
  + 'disabled:opacity-60 disabled:cursor-not-allowed';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const id = useContext(FieldIdContext);
  return <input id={props.id || id} {...props} className={cx(inputBase, 'h-10', className)} />;
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
        className={cx(inputBase, 'h-10 appearance-none pr-9 cursor-pointer', className)}
      >
        {children}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-subtle" />
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
          className="peer h-[18px] w-[18px] appearance-none rounded-[5px] border border-line-strong bg-raised
                     checked:bg-[var(--brand-vivid)] checked:border-[var(--brand-vivid)] transition-colors duration-150 cursor-pointer"
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
      <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
      <input
        type="search" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} aria-label={placeholder}
        className={cx(inputBase, 'h-10 rounded-full bg-sunken border-transparent pl-10 hover:border-transparent')}
      />
    </div>
  );
}

/**
 * Android's back button closes the dialog on top rather than moving the page
 * underneath it (lib/native.ts). Dialogs can stack, a confirm over a form, and
 * only the topmost may answer, hence one shared list.
 */
const openLayers: object[] = [];
function useBackCloses(open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const me = {};
    openLayers.push(me);
    const onBack = (e: Event) => {
      if (openLayers[openLayers.length - 1] !== me) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener('phoenixx:back', onBack);
    return () => {
      window.removeEventListener('phoenixx:back', onBack);
      openLayers.splice(openLayers.indexOf(me), 1);
    };
  }, [open]);
}

/* =============================================================== MODAL */
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useBackCloses(open, onClose);

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
          'rounded-t-2xl sm:rounded-[20px] max-h-[92vh] sm:max-h-[88vh] flex flex-col', widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-line shrink-0">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
            {subtitle && <p className="text-[13px] text-subtle mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close dialog"
            className="text-subtle hover:text-ink transition-colors duration-150 cursor-pointer p-1 -m-1 rounded">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto grow">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-line bg-raised rounded-b-[20px] flex flex-wrap justify-end gap-2 shrink-0">{footer}</div>}
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
  useBackCloses(open, onClose);
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
        className={cx('relative w-full bg-raised border-l border-line shadow-[var(--shadow-lg)] flex flex-col animate-in sm:rounded-l-[20px]', width)}
      >
        <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-line shrink-0">
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-ink truncate">{title}</h2>
            {subtitle && <div className="text-[13px] text-subtle mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close panel"
            className="text-subtle hover:text-ink transition-colors duration-150 cursor-pointer p-1 -m-1">
            <X size={18} />
          </button>
        </header>
        <div className="grow overflow-y-auto">{children}</div>
        {footer && <footer className="px-6 py-4 border-t border-line bg-raised flex justify-end gap-2 shrink-0 flex-wrap">{footer}</footer>}
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
    <div className={cx('flex gap-1.5 overflow-x-auto pb-0.5', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id} role="tab" aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'relative flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium whitespace-nowrap cursor-pointer',
            'transition-colors duration-150',
            active === t.id
              ? 'bg-brand-soft text-[var(--brand)]'
              : 'text-subtle hover:bg-sunken hover:text-ink',
          )}
        >
          {t.icon}
          {t.label}
          {t.count != null && (
            <span className={cx('rounded-full px-1.5 py-px text-[11.5px] tabular font-semibold',
              active === t.id ? 'bg-raised text-[var(--brand)]' : 'bg-sunken text-subtle')}>
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
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand-soft text-[var(--brand-vivid)]">
        {icon || <Inbox size={20} />}
      </div>
      <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</h3>
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
/** Every avatar is drawn a little larger than the size a screen asks for. */
const AVATAR_SCALE = 1.15;

/**
 * A person: their uploaded photo, else a stock photo picked from their name
 * (see lib/avatar.ts), else soft initials. The name is always shown beside it,
 * so the picture is decorative to screen readers.
 */
export function Avatar({ name, url, size = 28, className }: {
  name?: string | null; url?: string | null; size?: number; className?: string;
}) {
  const s = Math.round(size * AVATAR_SCALE);
  const stock = useStockPhoto(url ? null : name);
  const photo = url || stock;
  if (photo) {
    return (
      <img src={photo} alt="" width={s} height={s} loading="lazy" draggable={false}
        className={cx('rounded-full object-cover shrink-0', className)} style={{ width: s, height: s, background: avatarTint(name) }} />
    );
  }
  return (
    <span
      aria-hidden
      className={cx('inline-grid place-items-center overflow-hidden rounded-full shrink-0 ring-1 ring-black/[0.04]', className)}
      style={{ width: s, height: s, ...avatarStyle(name), fontSize: s * 0.36 }}
      title={name || undefined}
    >
      <span className="font-semibold">{initials(name)}</span>
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
              className={cx('card rounded-[14px] px-4 py-3 shadow-[var(--shadow-lg)] animate-in border-l-4',
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
    <div className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] sm:text-[30px] leading-tight font-semibold text-ink tracking-[-0.025em]">{title}</h1>
          {subtitle && <div className="mt-1 text-[14.5px] text-subtle">{subtitle}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap no-print">{actions}</div>}
      </div>
      {tabs && <div className="mt-4">{tabs}</div>}
    </div>
  );
}

/** Horizontal progress meter with the value stated in text, not colour alone. */
export function Meter({ value, max = 100, tone = 'brand', className, showLabel }: {
  value: number; max?: number; tone?: Tone; className?: string; showLabel?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const colors: Record<string, string> = {
    brand: 'var(--brand-vivid)', positive: 'var(--positive)', negative: 'var(--negative)',
    warning: 'var(--warning)', accent: 'var(--accent-bg)', info: 'var(--info)', neutral: 'var(--ink-subtle)',
  };
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <div className="h-2 flex-1 rounded-full bg-sunken overflow-hidden min-w-[40px]"
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
