import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, Card, Divider, EmptyState, ErrorBanner, Loading, Row } from '../components';
import { usePalette, type, spacing, relativeDay } from '../theme';

/**
 * Notifications - the last of the six. The same alerts the deadline engine
 * sends over WhatsApp and email, readable in-app with an audit of what was sent.
 */
export default function AlertsScreen() {
  const p = usePalette();
  const { user, tenant, signOut, queued, syncing, sync } = useAuth();

  const [items, setItems] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get('/notifications', { limit: 50 });
      setItems(res.data);
      setUnread(res.meta?.unread || 0);
    } catch (err: any) {
      setError(err.message || 'Could not load your alerts.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const markRead = async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
    api.post(`/notifications/${id}/read`).catch(() => {});
  };

  const markAll = async () => {
    try {
      await api.post('/notifications/read-all');
      load();
    } catch (err: any) {
      Alert.alert('Could not mark all read', err.message);
    }
  };

  const confirmSignOut = () => {
    Alert.alert('Sign out?', queued > 0
      ? `${queued} change${queued === 1 ? '' : 's'} on this device have not synced yet. Sync before signing out or they will be lost.`
      : 'You will need your password to sign back in.',
    [
      { text: 'Cancel', style: 'cancel' },
      ...(queued > 0 ? [{ text: 'Sync first', onPress: () => sync() }] : []),
      { text: 'Sign out', style: 'destructive' as const, onPress: signOut },
    ]);
  };

  const iconFor = (key: string): keyof typeof Ionicons.glyphMap => {
    if (key.includes('overdue') || key.includes('escalation')) return 'alert-circle-outline';
    if (key.includes('paid') || key.includes('accepted')) return 'checkmark-circle-outline';
    if (key.includes('invoice')) return 'receipt-outline';
    if (key.includes('leave')) return 'calendar-outline';
    if (key.includes('digest')) return 'today-outline';
    return 'notifications-outline';
  };

  const toneFor = (key: string) =>
    (key.includes('overdue') || key.includes('escalation') ? p.negative
      : key.includes('paid') || key.includes('accepted') ? p.positive : p.subtle);

  if (loading) return <Loading label="Loading alerts" />;

  return (
    <View style={{ flex: 1, backgroundColor: p.surface }}>
      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={p.brand} />
        }
        ListHeaderComponent={
          <View>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View>
                <Text style={[type.h1, { color: p.ink }]}>Alerts</Text>
                <Text style={[type.small, { color: p.subtle, marginTop: 2 }]}>
                  {unread ? `${unread} unread` : 'All caught up'}
                </Text>
              </View>
              {unread > 0 ? (
                <Pressable onPress={markAll} hitSlop={10} accessibilityRole="button">
                  <Text style={[type.small, { color: p.brand, fontWeight: '600' }]}>Mark all read</Text>
                </Pressable>
              ) : null}
            </Row>
            {error ? <View style={{ marginTop: spacing.md }}><ErrorBanner message={error} onRetry={load} /></View> : null}
            <View style={{ height: spacing.lg }} />
          </View>
        }
        ListEmptyComponent={
          <EmptyState icon="notifications-off-outline" title="Nothing yet"
            message="Due work, escalations, payments and reports all show up here." />
        }
        renderItem={({ item }) => (
          <Card
            style={[styles.item, !item.read_at && { borderLeftWidth: 3, borderLeftColor: p.brand }]}
            onPress={() => !item.read_at && markRead(item.id)}
          >
            <Row style={{ alignItems: 'flex-start' }}>
              <Ionicons name={iconFor(item.event_key)} size={18} color={toneFor(item.event_key)} />
              <View style={{ flex: 1 }}>
                <Text style={[type.small, { color: p.ink, fontWeight: '600' }]}>{item.title}</Text>
                {item.body ? (
                  <Text style={[type.small, { color: p.muted, marginTop: 2 }]} numberOfLines={3}>{item.body}</Text>
                ) : null}
                <Text style={[type.tiny, { color: p.subtle, marginTop: 4 }]}>{relativeDay(item.created_at)}</Text>
              </View>
              {!item.read_at ? <View style={[styles.dot, { backgroundColor: p.brand }]} /> : null}
            </Row>
          </Card>
        )}
        ListFooterComponent={
          <View style={{ marginTop: spacing.xl }}>
            <Divider />
            <View style={{ paddingTop: spacing.lg }}>
              <Text style={[type.label, { color: p.subtle, marginBottom: spacing.sm }]}>Signed in as</Text>
              <Text style={[type.body, { color: p.ink, fontWeight: '600' }]}>{user?.name}</Text>
              <Text style={[type.small, { color: p.subtle }]}>{user?.email}</Text>
              <Text style={[type.small, { color: p.subtle, marginTop: 2 }]}>
                {tenant?.name} · {user?.role?.replace('_', ' ')}
              </Text>

              {queued > 0 ? (
                <Button label={syncing ? 'Syncing…' : `Sync ${queued} pending change${queued === 1 ? '' : 's'}`}
                  icon="cloud-upload-outline" onPress={() => sync()} loading={syncing}
                  style={{ marginTop: spacing.lg }} full />
              ) : null}

              <Button label="Sign out" variant="ghost" icon="log-out-outline" onPress={confirmSignOut}
                style={{ marginTop: spacing.md }} full />
            </View>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  item: { padding: spacing.md, marginBottom: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
});
