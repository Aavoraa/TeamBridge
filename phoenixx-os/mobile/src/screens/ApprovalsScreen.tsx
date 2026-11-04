import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api } from '../api';
import { useAuth } from '../auth';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorBanner, Loading, Row, STATUS_TONE,
} from '../components';
import { usePalette, type, spacing, relativeDay } from '../theme';

/**
 * Approvals - the sixth high-frequency action. Leave requests and attendance
 * regularizations in one queue, decided in a tap. Approvals are deliberately
 * online-only: a decision the requester can see must actually have been made.
 */
export default function ApprovalsScreen() {
  const p = usePalette();
  const { can } = useAuth();

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);

  const canApproveLeave = can('hr_leave', 'approve');
  const canApproveAttendance = can('hr_attendance', 'approve');

  const load = useCallback(async () => {
    setError('');
    try {
      const [leave, regs] = await Promise.all([
        canApproveLeave
          ? api.get('/hr/leave/requests', { status: 'pending', limit: 50 }).then((r) => r.data)
          : Promise.resolve([]),
        canApproveAttendance
          ? api.get('/hr/attendance/regularizations', { status: 'pending' }).then((r) => r.data)
          : Promise.resolve([]),
      ]);

      setItems([
        ...leave.map((l: any) => ({ ...l, kind: 'leave' as const })),
        ...regs.map((r: any) => ({ ...r, kind: 'regularization' as const })),
      ]);
    } catch (err: any) {
      setError(err.message || 'Could not load approvals.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [canApproveLeave, canApproveAttendance]);

  useEffect(() => { load(); }, [load]);

  const decide = async (item: any, decision: 'approved' | 'rejected') => {
    setDeciding(item.id);
    try {
      const path = item.kind === 'leave'
        ? `/hr/leave/requests/${item.id}/decide`
        : `/hr/attendance/regularizations/${item.id}/decide`;
      await api.post(path, { decision });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (err: any) {
      Alert.alert('Could not record the decision', err.message);
    } finally {
      setDeciding(null);
    }
  };

  if (!canApproveLeave && !canApproveAttendance) {
    return (
      <View style={{ flex: 1, backgroundColor: p.surface, justifyContent: 'center' }}>
        <EmptyState icon="lock-closed-outline" title="No approvals for your role"
          message="Leave and attendance approvals are handled by managers and HR." />
      </View>
    );
  }

  if (loading) return <Loading label="Loading approvals" />;

  return (
    <View style={{ flex: 1, backgroundColor: p.surface }}>
      <FlatList
        data={items}
        keyExtractor={(i) => `${i.kind}-${i.id}`}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={p.brand} />
        }
        ListHeaderComponent={
          <View>
            <Text style={[type.h1, { color: p.ink }]}>Approvals</Text>
            <Text style={[type.small, { color: p.subtle, marginTop: 2, marginBottom: spacing.lg }]}>
              {items.length
                ? `${items.length} waiting on you`
                : 'Leave and attendance requests land here'}
            </Text>
            {error ? <ErrorBanner message={error} onRetry={load} /> : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState icon="checkmark-done-outline" title="Nothing waiting"
            message="You are up to date. New requests will appear here." />
        }
        renderItem={({ item }) => (
          <Card style={styles.item}>
            <Row style={{ alignItems: 'flex-start' }}>
              <Avatar name={item.user_name} size={36} />
              <View style={{ flex: 1 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <Text style={[type.body, { color: p.ink, fontWeight: '600' }]}>{item.user_name}</Text>
                  <Badge
                    label={item.kind === 'leave' ? item.leave_type_name : 'attendance'}
                    tone={item.kind === 'leave' ? 'brand' : 'warning'}
                  />
                </Row>

                <Text style={[type.small, { color: p.muted, marginTop: 4 }]}>
                  {item.kind === 'leave'
                    ? `${item.days} day${item.days === 1 ? '' : 's'} · ${item.from_date}${item.from_date !== item.to_date ? ` to ${item.to_date}` : ''}`
                    : `Regularize ${item.work_date}`}
                </Text>

                <Text style={[type.small, { color: p.subtle, marginTop: 2 }]} numberOfLines={3}>
                  {item.reason}
                </Text>

                <Text style={[type.tiny, { color: p.subtle, marginTop: 4 }]}>
                  requested {relativeDay(item.created_at)}
                </Text>
              </View>
            </Row>

            <Row style={{ marginTop: spacing.md, gap: spacing.sm }}>
              <Button
                label="Reject"
                variant="ghost"
                icon="close-outline"
                onPress={() => decide(item, 'rejected')}
                loading={deciding === item.id}
                style={{ flex: 1 }}
              />
              <Button
                label="Approve"
                variant="primary"
                icon="checkmark-outline"
                onPress={() => decide(item, 'approved')}
                loading={deciding === item.id}
                style={{ flex: 1 }}
              />
            </Row>
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  item: { padding: spacing.md, marginBottom: spacing.md },
});
