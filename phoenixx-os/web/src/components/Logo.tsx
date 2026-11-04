/**
 * The TeamBridge identity: two people joined by an endless loop - the team,
 * bridged. Drawn as a stroke SVG so it stays crisp at any size and needs no
 * image request; the wordmark is live text in the app's font.
 *
 * The export names (Logo, LogoDisc, Wordmark) are kept from the previous
 * identity, so every screen that shows the mark picks this up unchanged.
 */

const BLUE_TOP = '#3B82F6';
const BLUE_BOTTOM = '#1D5FD6';

/** The mark alone. `size` is its height; it is a little wider than tall. */
export function Logo({ size = 40, className, alt = 'TeamBridge' }: {
  size?: number; className?: string; alt?: string;
}) {
  const id = `tb-${size}`;
  return (
    <svg
      viewBox="0 0 40 34" height={size} width={Math.round(size * (40 / 34))}
      role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}
      className={className}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={BLUE_TOP} />
          <stop offset="100%" stopColor={BLUE_BOTTOM} />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${id})`} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        {/* two heads */}
        <circle cx="11.5" cy="7.5" r="4.6" />
        <circle cx="28.5" cy="7.5" r="4.6" />
        {/* the loop that joins them */}
        <path d="M20 24.5 C16 18.5 4 17 4 24.5 C4 32 16 30.5 20 24.5 C24 18.5 36 17 36 24.5 C36 32 24 30.5 20 24.5 Z" />
      </g>
    </svg>
  );
}

/** The mark in a soft disc - for headers of auth screens and empty panels. */
export function LogoDisc({ size = 62, tone = 'light', className, alt = '' }: {
  size?: number; tone?: 'dark' | 'light'; className?: string; alt?: string;
}) {
  const dark = tone === 'dark';
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full ${className || ''}`}
      style={{
        width: size, height: size,
        background: dark ? 'rgba(255,255,255,0.08)' : '#EEF4FE',
        boxShadow: dark ? 'inset 0 0 0 1px rgba(255,255,255,0.12)' : 'inset 0 0 0 1px rgba(37,99,235,0.10)',
      }}
    >
      <Logo size={Math.round(size * 0.5)} alt={alt} />
    </span>
  );
}

/** Mark plus name, as in the app's sidebar. */
export function Wordmark({ size = 34, variant = 'brand', tagline, className }: {
  size?: number;
  variant?: 'brand' | 'onDark' | 'plain';
  tagline?: string;
  className?: string;
}) {
  const onDark = variant === 'onDark';
  const nameColor = onDark ? 'text-white' : variant === 'plain' ? 'text-current' : 'text-ink';
  const taglineColor = onDark ? 'text-white/60' : 'text-subtle';
  return (
    <div className={`flex items-center gap-2.5 ${className || ''}`}>
      <Logo size={size} alt="" />
      <div className="leading-tight">
        <p className={`font-semibold tracking-[-0.02em] ${nameColor}`} style={{ fontSize: Math.round(size * 0.62) }}>TeamBridge</p>
        {tagline && <p className={`mt-0.5 ${taglineColor}`} style={{ fontSize: Math.round(size * 0.36) }}>{tagline}</p>}
      </div>
    </div>
  );
}
