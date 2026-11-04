/**
 * Home — "What do you need today?"
 *
 * The spec's test is that someone understands their most important actions
 * within a few seconds. So the order is: who you are and whether you are
 * checked in, then the four counts that decide your morning, then the actual
 * list of work. Company-wide numbers deliberately do not appear — those live on
 * the web dashboard.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock, Bell, CalendarClock, CheckCircle2, ClipboardList, Plus, ShieldCheck, Sun,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  date as fmtDate, clockTime, workspaceToday, workspaceTime,
} from '../../lib/format';
import { useToast } from '../../components/ui';
import { HOME_KEY, useHomeFeed } from '../MobileApp';
import {
  Empty, ErrorNote, List, Loading, MButton, MField, Pill, Row, Screen, Section, Sheet, inputClass,
} from '../ui';

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const PRIORITY_TONE = {
  urgent: 'negative', high: 'warning', medium: 'info', low: 'neutral',
} as const;

export default function MobileHome() {
  const { user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useHomeFeed();
  const [createOpen, setCreateOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/action-items/${id}`, { status: 'done' }),
    onSuccess: (res: any) => {
      // Done is not the end of it when somebody else raised the task.
      toast.success(res?.data?.validation_status === 'pending'
        ? 'Marked done — sent to whoever raised it for validation.'
        : 'Marked done.');
      qc.invalidateQueries({ queryKey: HOME_KEY });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <Loading label="Getting your day" />;
  if (error) return <div className="p-4"><ErrorNote error={error} retry={refetch} /></div>;

  const c = data?.counters || {};
  const items: any[] = data?.today_items || [];
  const approvals = Number(data?.pending_approvals?.leave || 0)
    + Number(data?.pending_approvals?.regularizations || 0);
  const checkedIn = !!data?.attendance?.check_in_at;

  return (
    <>
      <Screen
        title={`Hi ${data?.greeting_name || user?.name?.split(' ')[0] || 'there'}`}
        subtitle={fmtDate(new Date().toISOString(), 'long')}
        action={(
          <button
            type="button" onClick={() => nav('/m/hr')}
            className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-line-strong px-3 text-[12.5px] font-semibold"
          >
            <span className={checkedIn ? 'text-positive' : 'text-subtle'}>●</span>
            {checkedIn ? 'In' : 'Out'}
          </button>
        )}
      >
        <p className="text-[15px] font-semibold text-ink">What do you need today?</p>

        <div className="grid grid-cols-2 gap-3">
          <Tile2 icon={<AlarmClock size={17} />} label="Overdue" count={Number(c.overdue || 0)}
            tone="negative" onClick={() => nav('/m/today')} />
          <Tile2 icon={<CalendarClock size={17} />} label="Due today" count={Number(c.due_today || 0)}
            tone="warning" onClick={() => nav('/m/today')} />
          <Tile2 icon={<ClipboardList size={17} />} label="In progress" count={Number(c.in_progress || 0)}
            tone="info" onClick={() => nav('/m/today')} />
          <Tile2 icon={<Bell size={17} />} label="Notifications" count={Number(c.unread || 0)}
            tone="brand" onClick={() => setNotifOpen(true)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <MButton variant="primary" full icon={<Plus size={17} />} onClick={() => setCreateOpen(true)}>
            New task
          </MButton>
          <MButton full icon={<ShieldCheck size={17} />} onClick={() => nav('/m/hr')}>
            Approvals{approvals > 0 ? ` (${approvals})` : ''}
          </MButton>
        </div>

        <Section title={`My tasks${items.length ? ` · ${items.length}` : ''}`}>
          <List empty={<Empty icon={<Sun size={22} />} title="Nothing due"
            message="No open work is due today or overdue. Anything new will show up here." />}>
            {items.map((it) => (
              <Row
                key={it.id}
                title={it.title}
                meta={[
                  it.client_name,
                  it.due_date
                    ? `due ${fmtDate(it.due_date, 'day')}${it.due_time ? `, ${clockTime(it.due_time)}` : ''}`
                    : null,
                ].filter(Boolean).join(' · ')}
                right={(
                  <span className="flex items-center gap-2">
                    <Pill tone={PRIORITY_TONE[it.priority as keyof typeof PRIORITY_TONE] || 'neutral'}>
                      {it.priority}
                    </Pill>
                    <button
                      type="button"
                      aria-label={`Mark ${it.title} done`}
                      onClick={() => complete.mutate(it.id)}
                      className="text-subtle active:text-positive"
                    >
                      <CheckCircle2 size={22} />
                    </button>
                  </span>
                )}
              />
            ))}
          </List>
        </Section>

        {(data?.recent_notifications || []).length > 0 && (
          <Section title="Latest">
            <List>
              {(data.recent_notifications as any[]).slice(0, 4).map((n) => (
                <Row key={n.id} title={n.title} meta={n.body}
                  right={n.read_at ? undefined : <span className="text-brand">●</span>} />
              ))}
            </List>
          </Section>
        )}
      </Screen>

      <CreateTaskSheet open={createOpen} onClose={() => setCreateOpen(false)} />
      <NotificationsSheet
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        items={data?.recent_notifications || []}
        unread={Number(c.unread || 0)}
      />
    </>
  );
}

function NotificationsSheet({ open, onClose, items, unread }: {
  open: boolean; onClose: () => void; items: any[]; unread: number;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const readAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => {
      toast.success('All caught up.');
      qc.invalidateQueries({ queryKey: HOME_KEY });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Sheet
      open={open} onClose={onClose} title="Notifications"
      footer={unread > 0 ? (
        <MButton full loading={readAll.isPending} onClick={() => readAll.mutate()}>
          Mark all as read
        </MButton>
      ) : undefined}
    >
      <List empty={<Empty icon={<Bell size={22} />} title="Nothing new" />}>
        {items.map((n) => (
          <Row key={n.id} title={n.title} meta={n.body}
            right={n.read_at ? undefined : <span className="text-brand">●</span>} />
        ))}
      </List>
    </Sheet>
  );
}

/** Slightly richer tile than the shared one: count and label share a baseline. */
function Tile2({ icon, label, count, tone, onClick }: {
  icon: React.ReactNode; label: string; count: number;
  tone: 'negative' | 'warning' | 'info' | 'brand'; onClick: () => void;
}) {
  const text = {
    negative: 'text-negative', warning: 'text-warning', info: 'text-info', brand: 'text-brand',
  }[tone];
  const soft = {
    negative: 'bg-negative-soft', warning: 'bg-warning-soft', info: 'bg-info-soft', brand: 'bg-brand-soft',
  }[tone];
  return (
    <button type="button" onClick={onClick}
      className="card flex min-h-[86px] flex-col justify-between p-3 text-left transition-transform duration-100 active:scale-[0.98]">
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${soft} ${text}`}>{icon}</span>
      <span className="mt-2 flex items-end justify-between gap-2">
        <span className="text-[13px] font-medium leading-tight text-ink">{label}</span>
        <span className={`text-[24px] font-semibold leading-none tabular-nums ${count > 0 ? text : 'text-subtle'}`}>
          {count}
        </span>
      </span>
    </button>
  );
}

/** The next whole hour on the workspace clock, capped inside the same day. */
const nextHour = () => {
  const [h] = workspaceTime().split(':').map(Number);
  return h >= 22 ? '23:59' : `${String(h + 1).padStart(2, '0')}:00`;
};

function CreateTaskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState(workspaceToday());
  // The sheet opens on today, so it opens needing a time. An hour ahead, on the
  // hour, is the answer most people would have typed anyway.
  const [dueTime, setDueTime] = useState(nextHour);
  const [priority, setPriority] = useState<typeof PRIORITIES[number]>('medium');

  const isToday = dueDate === workspaceToday();
  const dueProblem = !isToday ? ''
    : !dueTime ? 'A task due today needs a time.'
      : dueTime < workspaceTime()
        ? `${clockTime(dueTime)} has already passed — it is ${clockTime(workspaceTime())} now.`
        : '';

  const create = useMutation({
    mutationFn: () => api.post('/action-items', {
      title: title.trim(),
      due_date: dueDate || null,
      due_time: dueDate ? (dueTime || null) : null,
      priority,
    }),
    onSuccess: () => {
      toast.success('Task created.');
      qc.invalidateQueries({ queryKey: HOME_KEY });
      setTitle('');
      setPriority('medium');
      setDueTime(nextHour());
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Sheet
      open={open} onClose={onClose} title="New task"
      footer={(
        <MButton variant="primary" full loading={create.isPending}
          disabled={title.trim().length < 2 || !!dueProblem} onClick={() => create.mutate()}>
          Create task
        </MButton>
      )}
    >
      <MField label="What needs doing?">
        <input className={inputClass} value={title} autoFocus
          placeholder="Send the Q3 proposal to Zenith"
          onChange={(e) => setTitle(e.target.value)} />
      </MField>

      <div className="grid grid-cols-2 gap-3">
        <MField label="Due date">
          <input type="date" className={inputClass} value={dueDate}
            onChange={(e) => setDueDate(e.target.value)} />
        </MField>
        <MField label={isToday ? 'Due time *' : 'Due time'}>
          <input type="time" className={inputClass} value={dueTime} disabled={!dueDate}
            min={isToday ? workspaceTime() : undefined}
            onChange={(e) => setDueTime(e.target.value)} />
        </MField>
      </div>
      {dueProblem
        ? <p className="-mt-1 mb-3 text-[12px] text-[var(--negative)]">{dueProblem}</p>
        : (
          <p className="-mt-1 mb-3 text-[12px] text-subtle">
            {isToday ? 'A same-day task goes overdue the minute this time passes.'
              : 'Optional — left blank it is due by the end of that day.'}
          </p>
        )}

      <MField label="Priority">
        <div className="grid grid-cols-4 gap-2">
          {PRIORITIES.map((p) => (
            <button
              key={p} type="button" onClick={() => setPriority(p)}
              className={`min-h-[44px] rounded-lg border text-[13px] font-semibold capitalize ${
                priority === p
                  ? 'border-[var(--brand)] bg-brand-soft text-brand'
                  : 'border-line-strong bg-raised text-subtle'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </MField>

      <p className="text-[12px] leading-relaxed text-subtle">
        It is assigned to you and lands in the same list the web app uses. Reassign it there if it
        belongs to someone else.
      </p>
    </Sheet>
  );
}
