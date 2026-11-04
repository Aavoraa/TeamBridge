import { StyleSheet, useColorScheme } from 'react-native';

/**
 * The same tokens as the web app, so the two clients look like one product.
 * Colours are resolved per scheme rather than hardcoded, because the mobile app
 * is used outdoors as often as at a desk.
 */

const light = {
  surface: '#F8FAFC',
  raised: '#FFFFFF',
  sunken: '#F1F5F9',
  line: '#E2E8F0',
  lineStrong: '#CBD5E1',
  ink: '#0F172A',
  muted: '#475569',
  subtle: '#64748B',
  brand: '#1E40AF',
  brandSoft: '#EFF6FF',
  accent: '#B45309',
  accentBg: '#F59E0B',
  accentSoft: '#FFFBEB',
  positive: '#15803D',
  positiveSoft: '#F0FDF4',
  negative: '#B91C1C',
  negativeSoft: '#FEF2F2',
  warning: '#A16207',
  warningSoft: '#FEFCE8',
  onBrand: '#FFFFFF',
};

const dark: typeof light = {
  surface: '#0B1120',
  raised: '#131C31',
  sunken: '#1A2436',
  line: '#253046',
  lineStrong: '#33415C',
  ink: '#F1F5F9',
  muted: '#B6C2D4',
  subtle: '#8FA0B8',
  brand: '#60A5FA',
  brandSoft: '#17233C',
  accent: '#FBBF24',
  accentBg: '#F59E0B',
  accentSoft: '#2A2110',
  positive: '#4ADE80',
  positiveSoft: '#10241A',
  negative: '#F87171',
  negativeSoft: '#2A1416',
  warning: '#FBBF24',
  warningSoft: '#251D0D',
  onBrand: '#FFFFFF',
};

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? dark : light;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 };

/** Touch targets never drop below 44pt, per the accessibility baseline. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };
export const MIN_TOUCH = 44;

export const type = StyleSheet.create({
  h1: { fontSize: 24, fontWeight: '600', letterSpacing: -0.3 },
  h2: { fontSize: 18, fontWeight: '600' },
  h3: { fontSize: 16, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  tiny: { fontSize: 11.5, lineHeight: 16 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  metric: { fontSize: 26, fontWeight: '700' },
  mono: { fontVariant: ['tabular-nums'] },
});

/* ------------------------------------------------------------ formatting */
export function money(minor?: number | null, compact = false) {
  const value = (minor ?? 0) / 100;
  if (compact) {
    const abs = Math.abs(value);
    if (abs >= 1e7) return `₹${(value / 1e7).toFixed(1)} Cr`;
    if (abs >= 1e5) return `₹${(value / 1e5).toFixed(1)} L`;
    if (abs >= 1e3) return `₹${Math.round(value / 1e3)}K`;
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(value);
}

export function relativeDay(iso?: string | null) {
  if (!iso) return '—';
  const target = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  const days = Math.round((target.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

export function timeOfDay(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export const daysUntil = (iso?: string | null) => {
  if (!iso) return null;
  const target = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Math.round((target.getTime() - Date.now()) / 86_400_000);
};

export const initials = (name?: string | null) =>
  (name || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
