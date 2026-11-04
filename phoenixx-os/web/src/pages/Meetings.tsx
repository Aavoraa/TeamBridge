import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, CalendarDays, Check, ListChecks, AlertTriangle, Lightbulb, StickyNote, Lock, Video, MapPin,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateTime, time, relative } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, ConfirmDialog, Drawer, EmptyState, ErrorState, Field,
  Input, Modal, PageHeader, Select, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR,
  Textarea, useToast, cx,
} from '../components/ui';

const POINT_KINDS = [
  { id: 'note', label: 'Note', icon: StickyNote, tone: 'neutral' as const },
  { id: 'decision', label: 'Decision', icon: Check, tone: 'positive' as const },
  { id: 'action', label: 'Action', icon: ListChecks, tone: 'brand' as const },
  { id: 'risk', label: 'Risk', icon: AlertTriangle, tone: 'warning' as const },
];

/** Module A — meetings, agenda and MOM with one-tap conversion to action items. */
export default function Meetings() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(params.get('open'));
  const [filter, setFilter] = useState<'upcoming' | 'past' | 'all'>('upcoming');

  const today = new Date().toISOString();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['meetings', filter],
    queryFn: () => api.get('/meetings', {
      ...(filter === 'upcoming' ? { from: today, status: 'scheduled' } : {}),
      ...(filter === 'past' ? { to: today } : {}),
      limit: 50,
    }).then((r) => r.data),
  });

  return (
    <>
      <PageHeader
        title="Meetings & MOM"
        subtitle="Agenda before, minutes during, action items after — in one place"
        actions={
          <>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as any)}
              aria-label="Filter" className="w-[130px]">
              <option value="upcoming">Upcoming</option>
              <option value="past">Past</option>
              <option value="all">All</option>
            </Select>
            {can('meetings', 'create') && (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>
                Schedule
              </Button>
            )}
          </>
        }
      />

      {error ? <ErrorState error={error} retry={refetch} />
        : isLoading ? <Card><TableSkeleton cols={5} /></Card>
          : !data?.length ? (
            <Card>
              <EmptyState icon={<CalendarDays size={20} />}
                title={filter === 'upcoming' ? 'No meetings scheduled' : 'No meetings found'}
                message="Schedule one with an agenda, then capture MOM points live and convert them to action items."
                action={can('meetings', 'create')
                  ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>Schedule a meeting</Button>
                  : undefined} />
            </Card>
          ) : (
            <Card>
              <Table>
                <THead>
                  <tr>
                    <TH>Meeting</TH>
                    <TH width="160px">Client</TH>
                    <TH width="175px">When</TH>
                    <TH width="140px">MOM</TH>
                    <TH width="120px">Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {data.map((m: any) => (
                    <TR key={m.id} onClick={() => setOpenId(m.id)}>
                      <TD>
                        <span className="block font-medium text-ink">{m.title}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-[12px] text-subtle">
                          {m.meeting_link ? <><Video size={11} /> online</> : m.location ? <><MapPin size={11} /> {m.location}</> : null}
                          <span>{m.duration_minutes} min</span>
                        </span>
                      </TD>
                      <TD><span className="text-muted text-[13px] truncate block max-w-[150px]">{m.client_name || '—'}</span></TD>
                      <TD>
                        <span className="block text-[13px] text-ink">{date(m.scheduled_at)}</span>
                        <span className="block text-[12px] text-subtle">{time(m.scheduled_at)} · {relative(m.scheduled_at)}</span>
                      </TD>
                      <TD>
                        {m.mom_count > 0 ? (
                          <span className="flex items-center gap-1.5 text-[13px]">
                            <span className="text-muted tabular">{m.mom_count} points</span>
                            {m.converted_count > 0 && (
                              <Badge tone="positive">{m.converted_count} converted</Badge>
                            )}
                          </span>
                        ) : <span className="text-subtle text-[13px]">—</span>}
                      </TD>
                      <TD>
                        <span className="flex items-center gap-1.5">
                          <StatusBadge status={m.status} />
                          {m.mom_locked_at && <Lock size={11} className="text-subtle" aria-label="MOM locked" />}
                        </span>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

      {createOpen && <ScheduleModal onClose={() => setCreateOpen(false)} />}
      {openId && <MeetingDrawer id={openId} onClose={() => {
        setOpenId(null);
        const next = new URLSearchParams(params); next.delete('open'); setParams(next, { replace: true });
      }} />}
    </>
  );
}

/* --------------------------------------------------------------- schedule */
function ScheduleModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({
    title: '', agenda: '', client_id: '', location: '', meeting_link: '',
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16),
    duration_minutes: '45',
  });
  const [attendees, setAttendees] = useState<string[]>([]);

  const { data: meta } = useQuery({
    queryKey: ['meeting-meta'],
    queryFn: async () => {
      const [directory, clients] = await Promise.all([
        api.get('/users/directory').then((r) => r.data),
        api.get('/crm/clients', { limit: 200 }).then((r) => r.data).catch(() => []),
      ]);
      return { directory, clients };
    },
    staleTime: 300_000,
  });

  const create = useMutation({
    mutationFn: () => api.post('/meetings', {
      title: form.title.trim(),
      agenda: form.agenda || null,
      client_id: form.client_id || null,
      location: form.location || null,
      meeting_link: form.meeting_link || null,
      scheduled_at: new Date(form.scheduled_at).toISOString(),
      duration_minutes: Number(form.duration_minutes),
      attendees: attendees.map((user_id) => ({ user_id })),
    }),
    onSuccess: () => {
      toast.success('Meeting scheduled and attendees notified.');
      qc.invalidateQueries({ queryKey: ['meetings'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open onClose={onClose} title="Schedule a meeting" size="lg"
      subtitle="A written agenda makes the MOM easier to capture"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={form.title.trim().length < 2}
            onClick={() => create.mutate()}>Schedule</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Title" required>
          <Input value={form.title} onChange={(e) => set('title', e.target.value)}
            placeholder="Cotton India — monthly review" autoFocus />
        </Field>
        <Field label="Agenda" hint="One line per topic; each becomes easy to minute">
          <Textarea value={form.agenda} onChange={(e) => set('agenda', e.target.value)} rows={4}
            placeholder={'1. Performance recap for August\n2. Creative pipeline\n3. Budget for September\n4. Open issues'} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client">
            <Select value={form.client_id} onChange={(e) => set('client_id', e.target.value)}>
              <option value="">Internal meeting</option>
              {meta?.clients?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="When" required>
            <Input type="datetime-local" value={form.scheduled_at} onChange={(e) => set('scheduled_at', e.target.value)} />
          </Field>
          <Field label="Duration (minutes)">
            <Select value={form.duration_minutes} onChange={(e) => set('duration_minutes', e.target.value)}>
              {[15, 30, 45, 60, 90, 120].map((d) => <option key={d} value={d}>{d} minutes</option>)}
            </Select>
          </Field>
          <Field label="Location">
            <Input value={form.location} onChange={(e) => set('location', e.target.value)}
              placeholder="Client office / Google Meet" />
          </Field>
        </div>
        <Field label="Attendees">
          <div className="flex flex-wrap gap-2">
            {meta?.directory?.map((u: any) => (
              <button key={u.id} type="button"
                onClick={() => setAttendees((a) => a.includes(u.id) ? a.filter((x) => x !== u.id) : [...a, u.id])}
                className={cx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors duration-150 cursor-pointer',
                  attendees.includes(u.id)
                    ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]'
                    : 'border-line text-muted hover:border-line-strong')}>
                <Avatar name={u.name} size={18} />
                {u.name}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- drawer */
function MeetingDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [newPoint, setNewPoint] = useState({ kind: 'note', text: '', owner_id: '', due_date: '' });
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [convertPoint, setConvertPoint] = useState<any>(null);

  const { data: meeting, isLoading } = useQuery({
    queryKey: ['meeting', id],
    queryFn: () => api.get(`/meetings/${id}`).then((r) => r.data),
  });

  const { data: directory } = useQuery({
    queryKey: ['directory'],
    queryFn: () => api.get('/users/directory').then((r) => r.data),
    staleTime: 300_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['meeting', id] });
    qc.invalidateQueries({ queryKey: ['meetings'] });
  };

  const addPoint = useMutation({
    mutationFn: () => api.post(`/meetings/${id}/mom`, {
      kind: newPoint.kind,
      text: newPoint.text.trim(),
      owner_id: newPoint.owner_id || null,
      due_date: newPoint.due_date || null,
    }),
    onSuccess: () => { setNewPoint({ kind: 'note', text: '', owner_id: '', due_date: '' }); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });

  const removePoint = useMutation({
    mutationFn: (pointId: string) => api.del(`/meetings/${id}/mom/${pointId}`),
    onSuccess: invalidate,
  });

  const finalize = useMutation({
    mutationFn: () => api.post(`/meetings/${id}/finalize`),
    onSuccess: (res: any) => {
      toast.success(`${res.data.converted} action item(s) created. MOM locked.`);
      invalidate();
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      setFinalizeOpen(false);
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading || !meeting) {
    return <Drawer open onClose={onClose} title="Loading…"><div className="p-4"><TableSkeleton rows={4} cols={2} /></div></Drawer>;
  }

  const locked = !!meeting.mom_locked_at;
  const pendingActions = (meeting.mom_points || []).filter((p: any) => p.kind === 'action' && !p.action_item_id).length;

  return (
    <>
      <Drawer open onClose={onClose} title={meeting.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={meeting.status} />
            <span className="text-subtle">{dateTime(meeting.scheduled_at)} · {meeting.duration_minutes} min</span>
            {meeting.client_name && <Badge tone="brand">{meeting.client_name}</Badge>}
          </span>
        }
        width="max-w-2xl"
        footer={
          can('meetings', 'edit') && !locked ? (
            <>
              <Button onClick={onClose}>Close</Button>
              <Button variant="primary" icon={<ListChecks size={15} />} onClick={() => setFinalizeOpen(true)}>
                Finalize MOM{pendingActions > 0 && ` · convert ${pendingActions}`}
              </Button>
            </>
          ) : <Button onClick={onClose}>Close</Button>
        }>
        <div className="p-5 space-y-5">
          {meeting.agenda && (
            <div>
              <p className="label-cap mb-1.5">Agenda</p>
              <p className="text-[13.5px] text-muted leading-relaxed whitespace-pre-wrap">{meeting.agenda}</p>
            </div>
          )}

          {meeting.attendees?.length > 0 && (
            <div>
              <p className="label-cap mb-2">Attendees</p>
              <div className="flex flex-wrap gap-2">
                {meeting.attendees.map((a: any) => (
                  <span key={a.id} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px] text-muted">
                    <Avatar name={a.user_name || a.contact_name || a.external_name} size={18} />
                    {a.user_name || a.contact_name || a.external_name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* -------------------------------------------------- MOM points */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="label-cap">Minutes {locked && '· locked'}</p>
              {locked && <Badge tone="neutral" dot><Lock size={10} /> locked {relative(meeting.mom_locked_at)}</Badge>}
            </div>

            {!meeting.mom_points?.length ? (
              <p className="rounded-lg border border-dashed border-line py-6 text-center text-[13px] text-subtle">
                No minutes captured yet
              </p>
            ) : (
              <ul className="space-y-2">
                {meeting.mom_points.map((p: any) => {
                  const kind = POINT_KINDS.find((k) => k.id === p.kind) || POINT_KINDS[0];
                  return (
                    <li key={p.id} className="flex items-start gap-2.5 rounded-lg border border-line p-3">
                      <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-full mt-0.5',
                        p.kind === 'risk' ? 'bg-warning-soft text-[var(--warning)]'
                          : p.kind === 'decision' ? 'bg-positive-soft text-[var(--positive)]'
                            : p.kind === 'action' ? 'bg-brand-soft text-[var(--brand)]' : 'bg-sunken text-subtle')}>
                        <kind.icon size={12} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] text-ink leading-snug">{p.text}</p>
                        <p className="mt-0.5 text-[12px] text-subtle flex flex-wrap items-center gap-x-2">
                          <span className="capitalize">{p.kind}</span>
                          {p.owner_name && <span>· {p.owner_name}</span>}
                          {p.due_date && <span>· due {date(p.due_date)}</span>}
                        </p>
                      </div>
                      {p.action_item_id ? (
                        <Badge tone="positive">
                          <ListChecks size={10} /> {p.action_status === 'done' ? 'done' : 'tracked'}
                        </Badge>
                      ) : !locked && can('action_items', 'create') && (
                        <div className="flex gap-1 shrink-0">
                          <Button size="sm" onClick={() => setConvertPoint(p)}>Convert</Button>
                          <Button size="sm" variant="ghost" onClick={() => removePoint.mutate(p.id)}
                            aria-label="Remove point">×</Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {!locked && can('meetings', 'edit') && (
              <div className="mt-3 rounded-lg border border-line bg-sunken p-3">
                <p className="text-[12.5px] font-medium text-ink mb-2">Add a point</p>
                <div className="space-y-2">
                  <Textarea value={newPoint.text} onChange={(e) => setNewPoint((p) => ({ ...p, text: e.target.value }))}
                    rows={2} placeholder="What was said, decided or flagged…"
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && newPoint.text.trim()) addPoint.mutate();
                    }} />
                  <div className="flex flex-wrap gap-2">
                    <Select value={newPoint.kind} onChange={(e) => setNewPoint((p) => ({ ...p, kind: e.target.value }))}
                      aria-label="Point type" className="h-8 w-[110px] text-[13px]">
                      {POINT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </Select>
                    {newPoint.kind === 'action' && (
                      <>
                        <Select value={newPoint.owner_id} onChange={(e) => setNewPoint((p) => ({ ...p, owner_id: e.target.value }))}
                          aria-label="Owner" className="h-8 w-[150px] text-[13px]">
                          <option value="">Owner…</option>
                          {directory?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </Select>
                        <Input type="date" value={newPoint.due_date}
                          onChange={(e) => setNewPoint((p) => ({ ...p, due_date: e.target.value }))}
                          aria-label="Due date" className="h-8 w-[140px] text-[13px]" />
                      </>
                    )}
                    <Button size="sm" variant="primary" className="ml-auto"
                      disabled={!newPoint.text.trim()} loading={addPoint.isPending}
                      onClick={() => addPoint.mutate()}>Add</Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Drawer>

      {convertPoint && (
        <ConvertModal meetingId={id} point={convertPoint} directory={directory || []}
          onClose={() => setConvertPoint(null)} onDone={invalidate} />
      )}

      <ConfirmDialog
        open={finalizeOpen} onClose={() => setFinalizeOpen(false)} onConfirm={() => finalize.mutate()}
        title="Finalize the minutes?" confirmLabel="Finalize and convert" loading={finalize.isPending}
        message={
          <>
            The meeting is marked complete and the minutes are locked.
            {pendingActions > 0
              ? <> {pendingActions} action point{pendingActions === 1 ? '' : 's'} will become tracked action items with their owners and due dates.</>
              : ' No action points are waiting to be converted.'}
          </>
        }
      />
    </>
  );
}

function ConvertModal({ meetingId, point, directory, onClose, onDone }: {
  meetingId: string; point: any; directory: any[]; onClose: () => void; onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ownerId, setOwnerId] = useState(point.owner_id || '');
  const [dueDate, setDueDate] = useState(point.due_date || '');
  const [priority, setPriority] = useState('medium');

  const convert = useMutation({
    mutationFn: () => api.post(`/meetings/${meetingId}/mom/${point.id}/convert`, {
      owner_id: ownerId || undefined,
      due_date: dueDate || undefined,
      priority,
    }),
    onSuccess: () => {
      toast.success('Converted into a tracked action item.');
      onDone();
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title="Convert to action item" size="sm"
      subtitle={point.text}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate()}>Convert</Button>
        </>
      }>
      <div className="space-y-4">
        <Field label="Owner">
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Me</option>
            {directory.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="Due date" hint="Sets the reminder ladder for this item">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['urgent', 'high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
