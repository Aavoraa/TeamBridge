import { type ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePalette, type, spacing, radius, MIN_TOUCH, initials } from './theme';

/* ================================================================== CARD */
export function Card({ children, style, onPress }: {
  children: ReactNode; style?: ViewStyle; onPress?: () => void;
}) {
  const p = usePalette();
  const base: ViewStyle = {
    backgroundColor: p.raised,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: p.line,
  };

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [base, style, pressed && { backgroundColor: p.sunken }]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{children}</View>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={styles.sectionRow}>
      <Text style={[type.label, { color: p.subtle }]}>{children}</Text>
      {action}
    </View>
  );
}

/* ================================================================ BUTTON */
export function Button({ label, onPress, variant = 'secondary', icon, loading, disabled, style, full }: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'accent' | 'ghost' | 'danger';
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  full?: boolean;
}) {
  const p = usePalette();

  const bg = {
    primary: p.brand, accent: p.accentBg, secondary: p.raised, ghost: 'transparent', danger: p.negative,
  }[variant];
  const fg = {
    primary: p.onBrand, accent: '#1F2937', secondary: p.ink, ghost: p.muted, danger: '#FFFFFF',
  }[variant];
  const border = variant === 'secondary' ? p.lineStrong : 'transparent';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border, opacity: disabled || loading ? 0.55 : 1 },
        full && { alignSelf: 'stretch' },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {loading
        ? <ActivityIndicator size="small" color={fg} />
        : icon ? <Ionicons name={icon} size={17} color={fg} /> : null}
      <Text style={[type.body, { color: fg, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  );
}

/* ================================================================= BADGE */
type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning' | 'accent';

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  const p = usePalette();
  const map: Record<Tone, [string, string]> = {
    neutral: [p.sunken, p.muted],
    brand: [p.brandSoft, p.brand],
    positive: [p.positiveSoft, p.positive],
    negative: [p.negativeSoft, p.negative],
    warning: [p.warningSoft, p.warning],
    accent: [p.accentSoft, p.accent],
  };
  const [bg, fg] = map[tone];

  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[type.tiny, { color: fg, fontWeight: '600' }]}>{label}</Text>
    </View>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  open: 'neutral', in_progress: 'brand', blocked: 'negative', done: 'positive', cancelled: 'neutral',
  urgent: 'negative', high: 'warning', medium: 'brand', low: 'neutral',
  pending: 'warning', approved: 'positive', rejected: 'negative',
  present: 'positive', absent: 'negative', half_day: 'warning', wfh: 'brand',
  lead: 'brand', active: 'positive', churned: 'negative',
};

/* ============================================================== STAT TILE */
export function Stat({ label, value, sub, tone, onPress }: {
  label: string; value: string | number; sub?: string; tone?: Tone; onPress?: () => void;
}) {
  const p = usePalette();
  const valueColor = tone === 'negative' ? p.negative
    : tone === 'positive' ? p.positive
      : tone === 'warning' ? p.warning : p.ink;

  return (
    <Card onPress={onPress} style={styles.stat}>
      <Text style={[type.label, { color: p.subtle }]} numberOfLines={1}>{label}</Text>
      <Text style={[type.metric, type.mono, { color: valueColor, marginTop: 2 }]}>{value}</Text>
      {sub ? <Text style={[type.tiny, { color: p.subtle, marginTop: 2 }]} numberOfLines={1}>{sub}</Text> : null}
    </Card>
  );
}

/* ================================================================ AVATAR */
const AVATAR_COLORS = ['#1E40AF', '#7C3AED', '#BE185D', '#0F766E', '#B45309', '#4338CA'];

export function Avatar({ name, size = 32 }: { name?: string | null; size?: number }) {
  let hash = 0;
  for (const ch of name || '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = AVATAR_COLORS[hash % AVATAR_COLORS.length];

  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
      <Text style={{ color: '#fff', fontSize: size * 0.38, fontWeight: '700' }}>{initials(name)}</Text>
    </View>
  );
}

/* =============================================================== STATES */
export function EmptyState({ icon = 'file-tray-outline', title, message }: {
  icon?: keyof typeof Ionicons.glyphMap; title: string; message?: string;
}) {
  const p = usePalette();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: p.sunken }]}>
        <Ionicons name={icon} size={22} color={p.subtle} />
      </View>
      <Text style={[type.h3, { color: p.ink, marginTop: spacing.md }]}>{title}</Text>
      {message ? (
        <Text style={[type.small, { color: p.subtle, textAlign: 'center', marginTop: 4, maxWidth: 260 }]}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  const p = usePalette();
  return (
    <View style={styles.loading} accessibilityLiveRegion="polite">
      <ActivityIndicator color={p.brand} />
      <Text style={[type.small, { color: p.subtle, marginTop: spacing.sm }]}>{label}…</Text>
    </View>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const p = usePalette();
  return (
    <View style={[styles.banner, { backgroundColor: p.negativeSoft, borderColor: p.negative }]}>
      <Ionicons name="alert-circle-outline" size={18} color={p.negative} />
      <Text style={[type.small, { color: p.negative, flex: 1 }]}>{message}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8}>
          <Text style={[type.small, { color: p.negative, fontWeight: '700' }]}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Shown whenever writes are sitting in the offline outbox. */
export function OfflineBanner({ count, onFlush, flushing }: {
  count: number; onFlush: () => void; flushing?: boolean;
}) {
  const p = usePalette();
  if (!count) return null;

  return (
    <View style={[styles.banner, { backgroundColor: p.accentSoft, borderColor: p.accentBg }]}>
      <Ionicons name="cloud-offline-outline" size={18} color={p.accent} />
      <Text style={[type.small, { color: p.accent, flex: 1 }]}>
        {count} change{count === 1 ? '' : 's'} saved on this device, waiting to sync
      </Text>
      <Pressable onPress={onFlush} disabled={flushing} accessibilityRole="button" hitSlop={8}>
        <Text style={[type.small, { color: p.accent, fontWeight: '700' }]}>
          {flushing ? 'Syncing…' : 'Sync now'}
        </Text>
      </Pressable>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Divider() {
  const p = usePalette();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line }} />;
}

const styles = StyleSheet.create({
  sectionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: spacing.sm, marginTop: spacing.lg,
  },
  button: {
    minHeight: MIN_TOUCH,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start',
  },
  stat: { flex: 1, padding: spacing.md, minWidth: 140 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl * 1.5, paddingHorizontal: spacing.lg },
  emptyIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl * 2 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, borderRadius: radius.md, borderLeftWidth: 3, marginBottom: spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
