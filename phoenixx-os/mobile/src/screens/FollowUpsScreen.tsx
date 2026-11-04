import { useCallback, useEffect, useState } from 'react';
import {
  Alert, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api, writeOrQueue } from '../api';
import { useAuth } from '../auth';
import {
  Badge, Button, Card, EmptyState, ErrorBanner, Loading, OfflineBanner, Row,
} from '../components';
import { Chip } from './TasksScreen';
import { usePalette, type, spacing, radius, relativeDay, daysUntil, money } from '../theme';

/**
 * The follow-up log: the fifth high-frequency action. Logging a touchpoint and
 * setting the next action happen in the same step, which is what keeps the
 * "every lead always has a next action" rule true in practice (E4).
 */
export default function FollowUpsScreen() {
  const p = usePalette();
  const { queued, syncing, sync } = useAuth();

  const [clients, setClients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [logging, setLogging] = useState<any>(null);
  const [filter, setFilter] = useState<'due' | 'missing' | 'all'>('due');

  const load = useCallback(async () => {
    setError('');
    try {
      const params: Record<string, any> = { limit: 60 };
      if (filter === 'due') params.filter = 'follow_up_due';
      if (filter === 'missing') params.filter = 'no_next_action';
      const res = await api.get('/crm/clients', params);
      setClients(res.data);
    } catch (err: any) {
      setError(err.message || 'Could not load your follow-ups.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading label="Loading follow-ups" />;

  return (
    <View style={{ flex: 1, backgroundColor: p.surface }}>
      <FlatList
        data={clients}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={p.brand} />
        }
        ListHeaderComponent={
          <View>
            <Text style={[type.h1, { color: p.ink }]}>Follow-ups</Text>
            <Text style={[type.small, { color: p.subtle, marginTop: 2, marginBottom: spacing.lg }]}>
              Every lead carries a next action and a date
            </Text>

            <OfflineBanner count={queued} onFlush={sync} flushing={syncing} />
            {error ? <ErrorBanner message={error} onRetry={load} /> : null}

            <Row style={{ flexWrap: 'wrap', marginBottom: spacing.sm }}>
              <Chip label="Due now" active={filter === 'due'} onPress={() => setFilter('due')} />
              <Chip label="No next action" active={filter === 'missing'} onPress={() => setFilter('missing')} />
              <Chip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
            </Row>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            icon="call-outline"
            title={filter === 'missing' ? 'Every lead has a next action' : 'Nothing due'}
            message={filter === 'missing'
              ? 'Nothing is sitting without a planned next step.'
              : 'No follow-ups are waiting on you right now.'}
          />
        }
        renderItem={({ item }) => {
          const days = daysUntil(item.next_action_date);
          const overdue = days != null && days < 0;
          const missing = !item.next_action || !item.next_action_date;

          return (
            <Card style={styles.item} onPress={() => setLogging(item)}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={[type.body, { color: p.ink, fontWeight: '600' }]}>{item.name}</Text>
                  <Text style={[type.tiny, { color: p.subtle, marginTop: 2 }]}>
                    {item.industry || 'Uncategorised'}
                    {item.city ? ` · ${item.city}` : ''}
                    {item.deal_value_minor ? ` · ${money(item.deal_value_minor, true)}` : ''}
                  </Text>
                </View>
                <Row>
                  <Text style={[type.small, type.mono, {
                    color: item.health_score >= 65 ? p.positive : item.health_score >= 45 ? p.warning : p.negative,
                    fontWeight: '700',
                  }]}>
                    {Math.round(item.health_score)}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={p.subtle} />
                </Row>
              </Row>

              {missing ? (
                <Row style={{ marginTop: spacing.sm }}>
                  <Ionicons name="alert-circle-outline" size={14} color={p.accent} />
                  <Text style={[type.small, { color: p.accent, fontWeight: '600' }]}>No next action set</Text>
                </Row>
              ) : (
                <View style={{ marginTop: spacing.sm }}>
                  <Text style={[type.small, { color: p.muted }]} numberOfLines={1}>{item.next_action}</Text>
                  <Text style={[type.tiny, {
                    color: overdue ? p.negative : p.subtle, fontWeight: overdue ? '700' : '400', marginTop: 2,
                  }]}>
                    {relativeDay(item.next_action_date)}
                  </Text>
                </View>
              )}
            </Card>
          );
        }}
      />

      <LogTouchpointModal client={logging} onClose={() => setLogging(null)} onSaved={() => { setLogging(null); load(); }} />
    </View>
  );
}

/* ------------------------------------------------------------ log a touch */
function LogTouchpointModal({ client, onClose, onSaved }: {
  client: any | null; onClose: () => void; onSaved: () => void;
}) {
  const p = usePalette();
  const { refreshQueueCount } = useAuth();

  const [type_, setType] = useState('call');
  const [outcome, setOutcome] = useState('connected');
  const [note, setNote] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [nextOffset, setNextOffset] = useState(2);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!client) return;
    setType('call'); setOutcome('connected'); setNote('');
    setNextAction(client.next_action || '');
    setNextOffset(2);
  }, [client]);

  if (!client) return null;

  const save = async () => {
    setSaving(true);
    const nextDate = new Date(Date.now() + nextOffset * 86_400_000).toISOString().slice(0, 10);
    const payload = {
      client_id: client.id,
      type: type_,
      outcome,
      subject: `${type_[0].toUpperCase()}${type_.slice(1)} with ${client.name}`,
      body: note || null,
      next_action: nextAction.trim() || undefined,
      next_action_date: nextAction.trim() ? nextDate : undefined,
    };

    try {
      const { queued } = await writeOrQueue(
        'activity.log', payload,
        () => api.post(`/crm/clients/${client.id}/activities`, payload),
      );
      await refreshQueueCount();
      if (queued) Alert.alert('Saved on this device', 'This touchpoint will sync when you have a signal.');
      onSaved();
    } catch (err: any) {
      Alert.alert('Could not log it', err.message);
    } finally {
      setSaving(false);
    }
  };

  const NEXT_OPTIONS = [
    { label: 'Tomorrow', days: 1 },
    { label: 'In 2 days', days: 2 },
    { label: 'In a week', days: 7 },
    { label: 'In 2 weeks', days: 14 },
  ];

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.sheet, { backgroundColor: p.raised }]}>
          <Row style={{ justifyContent: 'space-between', marginBottom: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Text style={[type.h2, { color: p.ink }]} numberOfLines={1}>{client.name}</Text>
              <Text style={[type.tiny, { color: p.subtle }]}>Log a touchpoint</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={p.subtle} />
            </Pressable>
          </Row>

          <Text style={[type.label, { color: p.subtle, marginBottom: spacing.sm }]}>How</Text>
          <Row style={{ flexWrap: 'wrap' }}>
            {['call', 'whatsapp', 'email', 'meeting'].map((t) => (
              <Chip key={t} label={t} active={type_ === t} onPress={() => setType(t)} />
            ))}
          </Row>

          <Text style={[type.label, { color: p.subtle, marginTop: spacing.md, marginBottom: spacing.sm }]}>Outcome</Text>
          <Row style={{ flexWrap: 'wrap' }}>
            {['connected', 'no_response', 'positive', 'negative'].map((o) => (
              <Chip key={o} label={o.replace('_', ' ')} active={outcome === o} onPress={() => setOutcome(o)} />
            ))}
          </Row>

          <Text style={[type.label, { color: p.subtle, marginTop: spacing.md, marginBottom: spacing.sm }]}>Notes</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What was discussed"
            placeholderTextColor={p.subtle}
            style={[styles.input, { backgroundColor: p.surface, borderColor: p.lineStrong, color: p.ink }]}
            multiline
            accessibilityLabel="Notes"
          />

          <View style={[styles.nextBlock, { backgroundColor: p.surface, borderColor: p.line }]}>
            <Text style={[type.small, { color: p.ink, fontWeight: '600', marginBottom: spacing.sm }]}>
              Next action
            </Text>
            <TextInput
              value={nextAction}
              onChangeText={setNextAction}
              placeholder="Send the revised scope"
              placeholderTextColor={p.subtle}
              style={[styles.inputSingle, { backgroundColor: p.raised, borderColor: p.lineStrong, color: p.ink }]}
              accessibilityLabel="Next action"
            />
            <Row style={{ flexWrap: 'wrap', marginTop: spacing.sm }}>
              {NEXT_OPTIONS.map((o) => (
                <Chip key={o.days} label={o.label} active={nextOffset === o.days} onPress={() => setNextOffset(o.days)} />
              ))}
            </Row>
            {!nextAction.trim() ? (
              <Text style={[type.tiny, { color: p.accent, marginTop: 4 }]}>
                Leaving this blank flags the lead on the dashboard.
              </Text>
            ) : null}
          </View>

          <Button label="Log touchpoint" variant="primary" onPress={save} loading={saving}
            style={{ marginTop: spacing.lg }} full />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xxl },
  item: { padding: spacing.md, marginBottom: spacing.sm },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.5)' },
  sheet: { padding: spacing.xl, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: spacing.xxl },
  input: {
    minHeight: 64, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md,
    padding: spacing.md, fontSize: 15, textAlignVertical: 'top',
  },
  inputSingle: {
    minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md,
    paddingHorizontal: spacing.md, fontSize: 15,
  },
  nextBlock: {
    marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth,
  },
});
