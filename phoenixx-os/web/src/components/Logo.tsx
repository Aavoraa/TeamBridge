/**
 * The Phoenixx identity.
 *
 * The bird is the real Phoenixx IT mark, taken from the master artwork in
 * logo.svg at the repo root. That file is not usable as-is: it is 90KB, it
 * paints the bird as a raster driven through an SVG luminance mask, and it
 * bakes the wordmark in as outlined paths locked to one colour. Here the mark
 * ships as a plain transparent PNG (public/phoenix-mark.png) and the wordmark
 * is live text, so the type stays crisp at any size, is selectable and
 * searchable, and can take its colour from the theme.
 *
 * The bird carries its own ember colouring and reads on light, on dark and on
 * the brand panel, so there is no "on dark" variant of the mark itself — only
 * the wordmark beside it changes.
 */

/** Intrinsic 185 x 230 — `size` is the height and the width follows. */
const MARK_SRC = '/phoenix-mark.png';
const MARK_RATIO = 185 / 230;

export function Logo({ size = 40, className, alt = 'Phoenixx' }: {
  size?: number; className?: string; alt?: string;
}) {
  return (
    <img
      src={MARK_SRC}
      alt={alt}
      width={Math.round(size * MARK_RATIO)}
      height={size}
      // Width and height are set so the mark cannot arrive late and shift the
      // layout; the style keeps it honest if a caller scales the box.
      style={{ height: size, width: 'auto' }}
      className={className}
      draggable={false}
    />
  );
}

/**
 * The mark set in a circular disc — the lockup badge and the card crest.
 * `size` is the disc diameter; the bird is inset to about 60% of it.
 */
export function LogoDisc({ size = 62, tone = 'dark', className, alt = '' }: {
  size?: number; tone?: 'dark' | 'light'; className?: string; alt?: string;
}) {
  const dark = tone === 'dark';
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full ${className || ''}`}
      style={{
        width: size,
        height: size,
        background: dark
          ? 'radial-gradient(circle at 50% 40%, #2a1408 0%, #140a05 70%)'
          : 'radial-gradient(circle at 50% 35%, #fdeae0 0%, #fbf1ea 100%)',
        boxShadow: dark
          ? 'inset 0 0 0 1px rgba(255,138,70,0.28), 0 0 26px -6px rgba(226,89,38,0.55)'
          : 'inset 0 0 0 1px rgba(225,89,38,0.12)',
      }}
    >
      <Logo size={Math.round(size * 0.62)} alt={alt} />
    </span>
  );
}

/**
 * Mark plus name — the lockup used on the sign-in page.
 * The name is two-tone, as the master artwork sets it: "PHOENIXX" in the
 * panel's own ink and "OS" in the mark's orange.
 */
export function Wordmark({ size = 62, variant = 'brand', tagline, className }: {
  size?: number;
  variant?: 'brand' | 'onDark' | 'plain';
  tagline?: string;
  className?: string;
}) {
  const onDark = variant === 'onDark';
  const nameColor = onDark ? 'text-white' : variant === 'plain' ? 'text-current' : 'text-ink';
  const taglineColor = onDark ? 'text-white/55' : 'text-subtle';

  return (
    <div className={`flex items-center gap-4 ${className || ''}`}>
      {/* The name is right here in text, so the disc is decorative. */}
      <LogoDisc size={size} tone={onDark ? 'dark' : 'light'} />
      <div className="leading-tight">
        <p className={`font-bold uppercase tracking-[0.005em] ${nameColor}`}
          style={{ fontSize: Math.round(size * 0.45) }}>
          Phoenixx <span className="text-[var(--brand-vivid)]">OS</span>
        </p>
        {tagline && (
          <p className={`mt-1 ${taglineColor}`} style={{ fontSize: Math.round(size * 0.24) }}>
            {tagline}
          </p>
        )}
      </div>
    </div>
  );
}
