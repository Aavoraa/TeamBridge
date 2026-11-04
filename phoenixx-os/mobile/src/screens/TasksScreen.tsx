import { useCallback, useEffect, useState } from 'react';
import {
  Alert, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, writeOrQueue } from '../api';
import { useAuth } from '../auth';
import {
  Badge, Button, Card, EmptyState, ErrorBanner, Loading, OfflineBanner, Row, STATUS_TONE,
} from '../components';
import { usePalette, type, spacing, radius, relativeDay, daysUntil, MIN_TOUCH } from '../theme';

/**
 * Two more of the six: my work, and quick-add. Both work offline - a task
 * captured on site is queued and replayed, and completion is queued the same way.
 */
export default function TasksScreen() {
  const p = usePalette();
  const { queued, syncing, sync, refreshQueueCount } = useAuth();

  const [buckets, setBuckets] = useState<{ overdue: any[]; today: any[]; upcoming: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await api.get('/action-items/me/today');
      setBuckets(res.data);
    } catch (err: any) {
      setError(err.message || 'Could not load your work.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const complete = async (item: any) => {
    try {
      const { queued: wasQueued } = await writeOrQueue(
        'action_item.complete',
        { id: item.id },
        () => api.patch(`/action-items/${item.id}`, { status: 'done' }),
      );
      await refreshQueueCount();
      if (wasQueued) Alert.alert('Saved on this device', 'This will sync when you have a signal.');
      load();
    } catch (err: any) {
      Alert.alert('Could not update', err.message);
    }
  };

  if (loading) return <Loading label="Loading your work" />;

  const sections = [
    { key: 'overdue', title: 'Overdue', items: buckets?.overdue || [] },
    { key: 'today', title: 'Due today', items: buckets?.today || [] },
    { key: 'upcoming', title: 'Coming up', items: buckets?.upcoming || [] },
  ].filter((s) => s.items.length > 0);

  const flat = sections.flatMap((s) => [{ header: s.title, key: s.key }, ...s.items]);

  return (
    <View style={{ flex: 1, backgroundColor: p.surface }}>
      <FlatList
        data={flat}
        keyExtractor={(row: any, i) => row.id || `${row.key}-${i}`}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={p.brand} />
        }
        ListHeaderComponent={
          <View>
            <Text style={[type.h1, { color: p.ink }]}>My work</Text>
            <Text style={[type.small, { color: p.subtle, marginTop: 2, marginBottom: spacing.lg }]}>
              What is overdue, due today, and coming up
            </Text>
            <OfflineBanner count={queued} onFlush={sync} flushing={syncing} />
            {error ? <ErrorBanner message={error} onRetry={load} /> : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState icon="checkmark-done-outline" title="You're clear"
            message="Nothing overdue or due today. A good moment to get ahead on this week." />
        }
        renderItem={({ item }: any) => {
          if (item.header) {
            return (
              <Text style={[type.label, { color: p.subtle, marginTop: spacing.lg, marginBottom: spacing.sm }]}>
                {item.header}
              </Text>
            );
          }
          const days = daysUntil(item.due_date);
          const overdue = days != null && days < 0;

          return (
            <Card style={styles.item}>
              <Row style={{ alignItems: 'flex-start' }}>
                <Pressable
                  onPress={() => complete(item)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${item.title} done`}
                  style={[styles.check, { borderColor: p.lineStrong }]}
                >
                  <Ionicons name="checkmark" size={14} color={p.positive} />
                </Pressable>

                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: p.ink, fontWeight: '600' }]}>{item.title}</Text>
                  <Row style={{ marginTop: 4, flexWrap: 'wrap' }}>
                    {item.client_name ? (
                      <Text style={[type.tiny, { color: p.subtle }]}>{item.client_name}</Text>
                    ) : null}
                    <Text style={[type.tiny, { color: overdue ? p.negative : p.subtle, fontWeight: overdue ? '700' : '400' }]}>
                      {overdue ? `${Math.abs(days!)} days overdue` : `due ${relativeDay(item.due_date)}`}
                    </Text>
                    {item.escalation_level > 0 ? <Badge label={`escalated L${item.escalation_level}`} tone="negative" /> : null}
                  </Row>
                </View>

                <Badge label={item.priority} tone={STATUS_TONE[item.priority] || 'neutral'} />
              </Row>
            </Card>
          );
        }}
      />

      <Pressable
        onPress={() => setAddOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Quick add an action item"
        style={[styles.fab, { backgroundColor: p.brand }]}
      >
        <Ionicons name="add" size={26} color="#fff" />
      </Pressable>

      <QuickAddModal
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => { setAddOpen(false); load(); }}
      />
    </View>
  );
}

/* --------------------------------------------------------------- quick add */
function QuickAddModal({ visible, onClose, onSaved }: {
  visible: boolean; onClose: () => void; onSaved: () => void;
}) {
  const p = usePalette();
  const { refreshQueueCount } = useAuth();

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [dueOffset, setDueOffset] = useState(1);
  const [clients, setClients] = useState<any[]>([]);
  const [clientId, setClientId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTitle(''); setPriority('medium'); setDueOffset(1); setClientId('');
    // The register, not the pipeline list - that one is scoped to the clients
    // you own, which leaves an employee with an empty picker.
    api.get('/crm/clients/options').then((r) => setClients(r.data)).catch(() => setClients([]));
  }, [visible]);

  const save = async () => {
    setSaving(true);
    const due = new Date(Date.now() + dueOffset * 86_400_000).toISOString().slice(0, 10);
    const payload = {
      title: title.trim(),
      priority,
      due_date: due,
      ...(clientId ? { client_id: clientId } : {}),
    };
    try {
      const { queued } = await writeOrQueue(
        'action_item.create', payload, () => api.post('/action-items', payload),
      );
      await refreshQueueCount();
      if (queued) Alert.alert('Saved on this device', 'This task will sync when you have a signal.');
      onSaved();
    } catch (err: any) {
      Alert.alert('Could not save', err.message);
    } finally {
      setSaving(false);
    }
  };

  const DUE_OPTIONS = [
    { label: 'Today', days: 0 },
    { label: 'Tomorrow', days: 1 },
    { label: 'In 3 days', days: 3 },
    { label: 'Next week', days: 7 },
  ];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.sheet, { backgroundColor: p.raised }]}>
          <Row style={{ justifyContent: 'space-between', marginBottom: spacing.lg }}>
            <Text style={[type.h2, { color: p.ink }]}>Quick add</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={p.subtle} />
            </Pressable>
          </Row>

          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="What needs doing?"
            placeholderTextColor={p.subtle}
            style={[styles.input, { backgroundColor: p.surface, borderColor: p.lineStrong, color: p.ink }]}
            autoFocus
            multiline
            accessibilityLabel="Task title"
          />

          <Text style={[type.label, { color: p.subtle, marginTop: spacing.lg, marginBottom: spacing.sm }]}>Due</Text>
          <Row style={{ flexWrap: 'wrap' }}>
            {DUE_OPTIONS.map((o) => (
              <Chip key={o.days} label={o.label} active={dueOffset === o.days} onPress={() => setDueOffset(o.days)} />
            ))}
          </Row>

          <Text style={[type.label, { color: p.subtle, marginTop: spacing.lg, marginBottom: spacing.sm }]}>Priority</Text>
          <Row style={{ flexWrap: 'wrap' }}>
            {['low', 'medium', 'high', 'urgent'].map((pr) => (
              <Chip key={pr} label={pr} active={priority === pr} onPress={() => setPriority(pr)} />
            ))}
          </Row>

          {clients.length > 0 ? (
            <>
              <Text style={[type.label, { color: p.subtle, marginTop: spacing.lg, marginBottom: spacing.sm }]}>
                Client (optional)
              </Text>
              <Row style={{ flexWrap: 'wrap' }}>
                <Chip label="None" active={!clientId} onPress={() => setClientId('')} />
                {clients.slice(0, 8).map((c) => (
                  <Chip key={c.id} label={c.name} active={clientId === c.id} onPress={() => setClientId(c.id)} />
                ))}
              </Row>
            </>
          ) : null}

          <Button
            label="Add task"
            variant="primary"
            onPress={save}
            loading={saving}
            disabled={title.trim().length < 2}
            style={{ marginTop: spacing.xl }}
            full
          />
        </View>
      </View>
    </Modal>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, {
        backgroundColor: active ? p.brandSoft : 'transparent',
        borderColor: active ? p.brand : p.line,
      }]}
    >
      <Text style={[type.small, { color: active ? p.brand : p.muted, fontWeight: active ? '600' : '400' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 100 },
  item: { padding: spacing.md, marginBottom: spacing.sm },
  check: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  fab: {
    position: 'absolute', right: spacing.lg, bottom: spacing.xl,
    width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.5)' },
  sheet: { padding: spacing.xl, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: spacing.xxl },
  input: {
    minHeight: 72, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md,
    padding: spacing.md, fontSize: 16, textAlignVertical: 'top',
  },
  chip: {
    minHeight: 36, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    marginRight: spacing.sm, marginBottom: spacing.sm, justifyContent: 'center',
  },
});
