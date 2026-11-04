/**
 * Mobile V2 primitives.
 *
 * Separate from components/ui.tsx on purpose. The desktop set is built for
 * pointer input and dense tables; this one assumes a thumb, one hand and a
 * moving bus — every tappable thing is at least 48px, nothing relies on hover,
 * and status is always carried by words as well as colour.
 */
import { ReactNode, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from '../components/ui';
import { MenuButton, ProfileButton } from './chrome';

type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning' | 'info';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-subtle',
  brand: 'text-brand',
  positive: 'text-positive',
  negative: 'text-negative',
  warning: 'text-warning',
  info: 'text-info',
};

const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-sunken',
  brand: 'bg-brand-soft',
  positive: 'bg-positive-soft',
  negative: 'bg-negative-soft',
  warning: 'bg-warning-soft',
  info: 'bg-info-soft',
};

/**
 * A tab's page. The bar is fixed in shape across every screen — avatar left,
 * title, then the overflow menu on the right — so those two controls are always
 * in the same place under the thumb, which is the whole point of copying the
 * Teams arrangement. `action` is for a screen's own control and sits inboard of
 * the menu.
 */
export function Screen({ title, subtitle, action, children }: {
  title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-line bg-raised/95 backdrop-blur px-3 pt-2.5 pb-2.5">
        <div className="flex items-center gap-2.5">
          <ProfileButton />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[19px] font-semibold leading-tight text-ink">{title}</h1>
            {subtitle && <p className="truncate text-[12.5px] leading-snug text-subtle">{subtitle}</p>}
          </div>
          {action}
          <MenuButton />
        </div>
      </header>
      <div className="px-4 py-4 space-y-4">{children}</div>
    </div>
  );
}

/** Section heading inside a screen. */
export function Section({ title, action, children }: {
  title: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <h2 className="label-cap">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The big square buttons on Home. Count is the whole point of the tile — it is
 * why you tap it — so it is set larger than the label, not tucked in a corner.
 */
export function Tile({ icon, label, count, tone = 'neutral', onClick }: {
  icon: ReactNode; label: string; count?: number; tone?: Tone; onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cx(
        'card flex min-h-[92px] flex-col justify-between p-3 text-left active:scale-[0.98]',
        'transition-transform duration-100',
      )}
    >
      <span className={cx('flex h-8 w-8 items-center justify-center rounded-lg', TONE_SOFT[tone], TONE_TEXT[tone])}>
        {icon}
      </span>
      <span className="mt-2">
        <span className="block text-[13px] font-medium leading-tight text-ink">{label}</span>
        {count !== undefined && (
          <span className={cx('block text-[22px] font-semibold leading-tight tabular-nums', count > 0 ? TONE_TEXT[tone] : 'text-subtle')}>
            {count}
          </span>
        )}
      </span>
    </button>
  );
}

/** A tappable list row. `right` is for a count, a time or a chevron. */
export function Row({ title, meta, right, tone, onClick, leading }: {
  title: ReactNode; meta?: ReactNode; right?: ReactNode; tone?: Tone;
  onClick?: () => void; leading?: ReactNode;
}) {
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={cx(
        'flex w-full items-center gap-3 px-3.5 py-3 text-left min-h-[56px]',
        onClick && 'active:bg-sunken',
      )}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium leading-snug text-ink">{title}</span>
        {meta && <span className="mt-0.5 block truncate text-[12.5px] text-subtle">{meta}</span>}
      </span>
      {right && (
        <span className={cx('shrink-0 text-[12.5px] font-medium tabular-nums', tone ? TONE_TEXT[tone] : 'text-subtle')}>
          {right}
        </span>
      )}
    </Tag>
  );
}

/** Rows grouped into one card, hairline-separated. */
export function List({ children, empty }: { children: ReactNode; empty?: ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children;
  const isEmpty = Array.isArray(items) ? items.length === 0 : !items;
  if (isEmpty && empty) return <>{empty}</>;
  return <div className="card divide-y divide-[var(--border)] overflow-hidden">{items}</div>;
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-semibold',
      TONE_SOFT[tone], TONE_TEXT[tone])}>
      {children}
    </span>
  );
}

export function MButton({ children, variant = 'default', full, onClick, disabled, loading, icon, type = 'button' }: {
  children: ReactNode; variant?: 'default' | 'primary' | 'positive' | 'negative';
  full?: boolean; onClick?: () => void; disabled?: boolean; loading?: boolean;
  icon?: ReactNode; type?: 'button' | 'submit';
}) {
  const styles = {
    default: 'bg-raised text-ink border border-line-strong',
    primary: 'bg-[var(--brand)] text-white border border-transparent',
    positive: 'bg-[var(--positive)] text-white border border-transparent',
    negative: 'bg-[var(--negative)] text-white border border-transparent',
  }[variant];
  return (
    <button
      type={type} onClick={onClick} disabled={disabled || loading}
      className={cx(
        'inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-semibold',
        'active:scale-[0.99] transition-transform duration-100 disabled:opacity-50',
        styles, full && 'w-full',
      )}
    >
      {loading ? <Loader2 size={17} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

export { Sheet } from './sheet';

export function MField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-subtle">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full min-h-[48px] rounded-lg border border-line-strong bg-raised px-3 text-[15px] text-ink '
  + 'placeholder:text-subtle focus:border-[var(--ring)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]/30';

export function Empty({ icon, title, message }: { icon?: ReactNode; title: string; message?: string }) {
  return (
    <div className="card flex flex-col items-center gap-1.5 px-4 py-8 text-center">
      {icon && <span className="text-subtle">{icon}</span>}
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {message && <p className="max-w-[36ch] text-[12.5px] leading-relaxed text-subtle">{message}</p>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-subtle" role="status" aria-live="polite">
      <Loader2 size={18} className="animate-spin" />
      <span className="text-[13.5px]">{label}…</span>
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: any; retry?: () => void }) {
  return (
    <div className="card space-y-3 p-4">
      <p className="text-[14px] font-medium text-ink">That didn’t load</p>
      <p className="text-[12.5px] leading-relaxed text-subtle">{error?.message || 'Something went wrong.'}</p>
      {retry && <MButton onClick={retry} full>Try again</MButton>}
    </div>
  );
}
