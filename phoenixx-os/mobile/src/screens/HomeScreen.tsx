import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { api, writeOrQueue } from '../api';
import { useAuth } from '../auth';
import {
  Button, Card, EmptyState, ErrorBanner, Loading, OfflineBanner, Row, SectionTitle, Stat, Badge,
} from '../components';
import { usePalette, type, spacing, money, timeOfDay, relativeDay } from '../theme';

/**
 * Two of the six high-frequency mobile actions live here: attendance check-in
 * and the condensed dashboard (H5). Check-in works offline and geo-tags when
 * permission has been granted.
 */
export default function HomeScreen() {
  const p = usePalette();
  const { user, tenant, can, queued, syncing, sync, refreshQueueCount } = useAuth();

  const [home, setHome] = useState<any>(null);
  const [dash, setDash] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [homeRes, dashRes] = await Promise.all([
        api.get('/dashboard/home'),
        can('dashboard', 'view') ? api.get('/dashboard/mobile') : Promise.resolve(null),
      ]);
      setHome(homeRes.data);
      setDash(dashRes?.data ?? null);
    } catch (err: any) {
      setError(err.message || 'Could not load your day.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [can]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  const geoTag = async () => {
    // Location is a nice-to-have: if it is declined, check-in still works.
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return {};
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? undefined };
    } catch {
      return {};
    }
  };

  const checkIn = async () => {
    setBusy(true);
    try {
      const geo = await geoTag();
      const { queued: wasQueued } = await writeOrQueue(
        'attendance.check_in',
        { ...geo, work_date: new Date().toISOString().slice(0, 10) },
        () => api.post('/hr/attendance/check-in', { source: 'mobile', geo }),
      );
      await refreshQueueCount();
      if (wasQueued) Alert.alert('Saved on this device', 'Your check-in will sync when you have a signal.');
      else await load();
    } catch (err: any) {
      Alert.alert('Could not check in', err.message);
    } finally {
      setBusy(false);
    }
  };

  const checkOut = async () => {
    setBusy(true);
    try {
      const geo = await geoTag();
      const { queued: wasQueued } = await writeOrQueue(
        'attendance.check_out',
        { ...geo, work_date: new Date().toISOString().slice(0, 10) },
        () => api.post('/hr/attendance/check-out', { geo }),
      );
      await refreshQueueCount();
      if (wasQueued) Alert.alert('Saved on this device', 'Your check-out will sync when you have a signal.');
      else await load();
    } catch (err: any) {
      Alert.alert('Could not check out', err.message);
    } finally {
      setBusy(false);
    }
  };

  const onSync = async () => {
    const result = await sync();
    if (result?.conflicts?.length) {
      Alert.alert('Synced with changes', result.conflicts.join('\n\n'));
    }
    load();
  };

  if (loading) return <Loading label="Loading your day" />;

  const attendance = home?.attendance;
  const c = home?.counters || {};
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <ScrollView
      style={{ backgroundColor: p.surface }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={p.brand} />}
    >
      <Text style={[type.h1, { color: p.ink }]}>{greeting}, {user?.name?.split(' ')[0]}</Text>
      <Text style={[type.small, { color: p.subtle, marginTop: 2 }]}>
        {tenant?.name} · {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}
      </Text>

      <View style={{ marginTop: spacing.lg }}>
        <OfflineBanner count={queued} onFlush={onSync} flushing={syncing} />
        {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      </View>

      {/* ---------------------------------------------------- attendance */}
      <Card style={styles.attendance}>
        {!attendance?.check_in_at ? (
          <>
            <Text style={[type.h3, { color: p.ink }]}>You have not checked in</Text>
            <Text style={[type.small, { color: p.subtle, marginTop: 2, marginBottom: spacing.md }]}>
              Location is recorded only if you allow it.
            </Text>
            <Button label="Check in" variant="accent" icon="log-in-outline" onPress={checkIn} loading={busy} full />
          </>
        ) : !attendance?.check_out_at ? (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <View>
                <Text style={[type.h3, { color: p.ink }]}>Checked in</Text>
                <Text style={[type.small, { color: p.subtle, marginTop: 2 }]}>
                  Since {timeOfDay(attendance.check_in_at)}
                  {attendance.late_minutes > 0 ? ` · ${attendance.late_minutes} min late` : ''}
                </Text>
              </View>
              <Badge label="on the clock" tone="positive" />
            </Row>
            <Button label="Check out" icon="log-out-outline" onPress={checkOut} loading={busy}
              style={{ marginTop: spacing.md }} full />
          </>
        ) : (
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Text style={[type.h3, { color: p.ink }]}>
                {Math.floor((attendance.work_minutes || 0) / 60)}h {(attendance.work_minutes || 0) % 60}m logged
              </Text>
              <Text style={[type.small, { color: p.subtle, marginTop: 2 }]}>
                {timeOfDay(attendance.check_in_at)} → {timeOfDay(attendance.check_out_at)}
              </Text>
            </View>
            <Ionicons name="checkmark-circle" size={26} color={p.positive} />
          </Row>
        )}
      </Card>

      {/* ------------------------------------------------------ counters */}
      <SectionTitle>Your day</SectionTitle>
      <View style={styles.grid}>
        <Stat label="Overdue" value={c.overdue ?? 0} tone={c.overdue ? 'negative' : undefined} />
        <Stat label="Due today" value={c.due_today ?? 0} />
        <Stat label="Follow-ups" value={c.follow_ups ?? 0} />
        <Stat label="Escalations" value={c.escalations ?? 0} tone={c.escalations ? 'warning' : undefined} />
      </View>

      {/* ---------------------------------------------- company pillars */}
      {dash?.pillars?.length ? (
        <>
          <SectionTitle>Company traction</SectionTitle>
          <View style={styles.grid}>
            {dash.pillars.map((pillar: any) => (
              <Stat
                key={pillar.key}
                label={pillar.label}
                value={pillar.value_minor != null ? money(pillar.value_minor, true) : pillar.value}
                sub={pillar.sub}
                tone={pillar.key === 'profit' && pillar.value_minor < 0 ? 'negative' : undefined}
              />
            ))}
          </View>

          {dash.lagging ? (
            <Card style={styles.lagging}>
              <Text style={[type.label, { color: p.subtle, marginBottom: spacing.sm }]}>Lagging indicators</Text>
              <Row style={{ flexWrap: 'wrap', gap: spacing.lg }}>
                <LagItem label="overdue items" value={dash.lagging.overdue_action_items} />
                <LagItem label="escalations" value={dash.lagging.open_escalations} />
                <LagItem label="overdue invoices" value={dash.lagging.overdue_invoices} />
              </Row>
            </Card>
          ) : null}
        </>
      ) : null}

      {/* ------------------------------------------------------ meetings */}
      <SectionTitle>Today's meetings</SectionTitle>
      {!home?.meetings?.length ? (
        <Card style={{ paddingVertical: spacing.sm }}>
          <EmptyState icon="calendar-outline" title="Nothing scheduled" />
        </Card>
      ) : (
        home.meetings.map((m: any) => (
          <Card key={m.id} style={styles.listItem}>
            <Text style={[type.body, { color: p.ink, fontWeight: '600' }]}>{m.title}</Text>
            <Text style={[type.small, { color: p.subtle, marginTop: 2 }]}>
              {timeOfDay(m.scheduled_at)} · {m.duration_minutes} min
              {m.client_name ? ` · ${m.client_name}` : ''}
            </Text>
          </Card>
        ))
      )}

      {/* ------------------------------------------------------- alerts */}
      <SectionTitle>Recent alerts</SectionTitle>
      {!home?.recent_notifications?.length ? (
        <Card style={{ paddingVertical: spacing.sm }}>
          <EmptyState icon="notifications-outline" title="All quiet" />
        </Card>
      ) : (
        home.recent_notifications.slice(0, 5).map((n: any) => (
          <Card key={n.id} style={[styles.listItem, !n.read_at && { borderLeftWidth: 3, borderLeftColor: p.brand }]}>
            <Text style={[type.small, { color: p.ink, fontWeight: '600' }]}>{n.title}</Text>
            <Text style={[type.tiny, { color: p.subtle, marginTop: 2 }]}>{relativeDay(n.created_at)}</Text>
          </Card>
        ))
      )}

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

function LagItem({ label, value }: { label: string; value: number }) {
  const p = usePalette();
  return (
    <View>
      <Text style={[type.h2, type.mono, { color: value ? p.negative : p.ink }]}>{value ?? 0}</Text>
      <Text style={[type.tiny, { color: p.subtle }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingTop: spacing.xl },
  attendance: { padding: spacing.lg, marginTop: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  lagging: { padding: spacing.lg, marginTop: spacing.sm },
  listItem: { padding: spacing.md, marginBottom: spacing.sm },
});
