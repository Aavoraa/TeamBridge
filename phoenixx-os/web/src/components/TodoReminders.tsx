import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, BellRing, CheckCircle2, ListTodo } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Modal, cx, useToast } from './ui';
import { TODOS_KEY, clock, today } from './PersonalTodos';

/**
 * Pop-up reminders for the personal to-do list.
 *
 * Two moments:
 *  - **Check-in.** The first check-in of the day opens today's open to-dos,
 *    so the day starts with them in view.
 *  - **Ten minutes before.** A to-do with a time pops up ten minutes ahead,
 *    on whatever page the person is on, with Done / Snooze / Dismiss.
 *
 * Runs in the browser, so it only fires while Phoenixx OS is open in a tab.
 * What has already been shown is remembered on this device, so a refresh or a
 * second tab does not show the same reminder twice.
 */

const LEAD_MINUTES = 10;
const SNOOZE_MINUTES = 5;
const CHECKED_IN = 'phoenixx:checked-in';

/** Called by every check-in button after the day's first check-in succeeds. */
export const announceCheckIn = () => window.dispatchEvent(new Event(CHECKED_IN));

type Todo = {
  id: string; title: string; todo_date: string; due_time: string | null;
  priority: 'low' | 'normal' | 'high'; status: 'pending' | 'completed';
};

// ------------------------------------------------- what has been shown
const memory = new Map<string, string>();
const seenKey = (t: Todo) => `todo-reminder:${t.id}:${t.todo_date}:${t.due_time}`;
const readSeen = (k: string) => {
  try { return localStorage.getItem(k) ?? memory.get(k) ?? null; } catch { return memory.get(k) ?? null; }
};
const writeSeen = (k: string, v: string) => {
  memory.set(k, v);
  try { localStorage.setItem(k, v); } catch { /* private mode: memory only */ }
};

/** The instant a to-do is due, on this device's clock. */
const dueAt = (t: Todo) => {
  const [h, m] = String(t.due_time).split(':').map(Number);
  const d = new Date(`${t.todo_date}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d;
};

const desktopAlert = (title: string, body: string) => {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  } catch { /* not supported */ }
};

export default function TodoReminders() {
  const qc = useQueryClient();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState<Todo[]>([]);

  // Same key and shape as the card, so both share one cache.
  const { data } = useQuery({
    queryKey: TODOS_KEY,
    queryFn: () => api.get('/todos', { date: today() }).then((r) => ({ items: r.data as Todo[], meta: r.meta })),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const pending = useMemo(() => (data?.items || []).filter((t) => t.status === 'pending'), [data]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  // ------------------------------------------------------- at check-in
  useEffect(() => {
    const onCheckIn = async () => {
      await qc.invalidateQueries({ queryKey: ['todos'] });
      setCheckInOpen(true);
    };
    window.addEventListener(CHECKED_IN, onCheckIn);
    return () => window.removeEventListener(CHECKED_IN, onCheckIn);
  }, [qc]);

  // ------------------------------------------------- 10 minutes before
  useEffect(() => {
    const due = pending.filter((t) => {
      if (!t.due_time || t.todo_date !== today()) return false;
      const at = dueAt(t).getTime();
      const seen = readSeen(seenKey(t));
      if (seen === 'done') return false;
      if (seen && Number(seen) > now) return false; // still snoozed
      // From ten minutes before until a few minutes after - a laptop that was
      // asleep at the exact minute still gets told. A snooze can run past the
      // due time, so a snoozed one keeps coming back for up to an hour.
      const until = at + (seen ? 60 : 5) * 60_000;
      return now >= at - LEAD_MINUTES * 60_000 && now <= until;
    });
    const fresh = due.filter((t) => !dueOpen.some((d) => d.id === t.id));
    if (fresh.length) {
      setDueOpen((list) => [...list, ...fresh]);
      for (const t of fresh) desktopAlert(`Reminder at ${clock(t.due_time)}`, t.title);
    }
  }, [now, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const complete = useMutation({
    mutationFn: (id: string) => api.post(`/todos/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['todos'] }),
    onError: (e: any) => toast.error(e.message),
  });

  const closeDue = (t: Todo, how: 'done' | 'dismiss' | 'snooze') => {
    writeSeen(seenKey(t), how === 'snooze' ? String(Date.now() + SNOOZE_MINUTES * 60_000) : 'done');
    if (how === 'done') complete.mutate(t.id);
    setDueOpen((list) => list.filter((x) => x.id !== t.id));
  };

  const canAskDesktop = typeof window !== 'undefined' && 'Notification' in window
    && Notification.permission === 'default';

  // ------------------------------------------------------------ render
  const current = dueOpen[0];
  if (current) {
    const mins = Math.round((dueAt(current).getTime() - now) / 60_000);
    return (
      <Modal open onClose={() => closeDue(current, 'dismiss')}
        title={mins > 0 ? `Reminder · in ${mins} min` : 'Reminder · now'}
        subtitle={`Due at ${clock(current.due_time)}${dueOpen.length > 1 ? ` · ${dueOpen.length - 1} more after this` : ''}`}
        footer={
          <>
            <Button onClick={() => closeDue(current, 'dismiss')}>Dismiss</Button>
            <Button icon={<AlarmClock size={14} />} onClick={() => closeDue(current, 'snooze')}>
              Snooze {SNOOZE_MINUTES} min
            </Button>
            <Button variant="primary" icon={<CheckCircle2 size={14} />} onClick={() => closeDue(current, 'done')}>
              Mark done
            </Button>
          </>
        }>
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning-soft text-[var(--warning)]">
            <BellRing size={17} />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-ink leading-snug">{current.title}</p>
            {current.priority === 'high' && <p className="mt-1 text-[12.5px] font-medium text-[var(--negative)]">High priority</p>}
            {canAskDesktop && (
              <button type="button" onClick={() => Notification.requestPermission()}
                className="mt-2 text-[12.5px] text-[var(--brand)] hover:underline cursor-pointer">
                Also alert me on the desktop
              </button>
            )}
          </div>
        </div>
      </Modal>
    );
  }

  if (checkInOpen && pending.length) {
    return (
      <Modal open onClose={() => setCheckInOpen(false)} title="Your to-dos for today"
        subtitle={`${pending.length} open · timed ones will remind you ${LEAD_MINUTES} minutes before`}
        footer={<Button variant="primary" onClick={() => setCheckInOpen(false)}>Got it</Button>}>
        <ul className="divide-y divide-[var(--border)] -mx-1">
          {pending.map((t) => (
            <li key={t.id} className="flex items-start gap-2.5 px-1 py-2.5">
              <ListTodo size={15} className="mt-0.5 shrink-0 text-subtle" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-ink leading-snug">{t.title}</span>
                <span className="mt-0.5 block text-[11.5px] text-subtle">
                  {[t.due_time && clock(t.due_time), t.priority !== 'normal' && t.priority,
                    t.todo_date < today() && 'carried over'].filter(Boolean).join(' · ')}
                </span>
              </span>
              <button type="button" onClick={() => complete.mutate(t.id)}
                className={cx('text-[12.5px] text-subtle hover:text-[var(--positive)] cursor-pointer')}>
                Done
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }
  return null;
}
