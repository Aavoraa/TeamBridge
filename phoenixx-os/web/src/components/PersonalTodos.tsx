import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, CalendarDays, CheckCircle2, ListTodo, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { date as fmtDate } from '../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Select, Skeleton, cx, useToast } from './ui';

/**
 * To-do & reminders - the personal list.
 *
 * A quiet counterpart to the action-item queue beside it: nobody assigns these,
 * nobody chases them, and nobody else can see them. That is the whole point, so
 * the card stays deliberately plain - a line to type in, a checkbox, and a way
 * to fix a typo. Anything heavier belongs in an action item instead.
 */

export const TODOS_KEY = ['todos', 'today'];
export const UPCOMING_KEY = ['todos', 'upcoming'];

type Todo = {
  id: string; title: string; todo_date: string; due_time: string | null;
  priority: 'low' | 'normal' | 'high'; status: 'pending' | 'completed';
};

/** Today on this device's calendar - the day the person means by "today". */
export const today = () => new Date().toLocaleDateString('en-CA');

/** "18:30" as the reader would say it. Shared with the mobile Today screen. */
export const clock = (hhmm?: string | null) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${suffix}`;
};

export default function PersonalTodos({ className }: { className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [priority, setPriority] = useState<Todo['priority']>('normal');
  const [day, setDay] = useState(today());
  const [detailed, setDetailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: TODOS_KEY,
    queryFn: () => api.get('/todos', { date: today() }).then((r) => ({ items: r.data as Todo[], meta: r.meta })),
    staleTime: 30_000,
  });
  const upcoming = useQuery({
    queryKey: UPCOMING_KEY,
    queryFn: () => api.get('/todos/upcoming', { date: today() }).then((r) => r.data as Todo[]),
    staleTime: 30_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['todos'] });

  const add = useMutation({
    mutationFn: (body: Record<string, any>) => api.post('/todos', body),
    onSuccess: (_res, body) => {
      if (body.todo_date && body.todo_date !== today()) toast.success(`Saved for ${fmtDate(body.todo_date)}.`);
      setTitle('');
      setTime('');
      setPriority('normal');
      setDay(today());
      refresh();
      // Straight back to the field: adding three things in a row is the norm.
      inputRef.current?.focus();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const toggle = useMutation({
    mutationFn: (id: string) => api.post(`/todos/${id}/toggle`),
    onSuccess: () => refresh(),
    onError: (e: any) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, any> }) => api.patch(`/todos/${id}`, body),
    onSuccess: () => { setEditing(null); refresh(); },
    onError: (e: any) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/todos/${id}`),
    onSuccess: () => { toast.success('Removed.'); refresh(); },
    onError: (e: any) => toast.error(e.message),
  });

  const pullForward = useMutation({
    mutationFn: (id: string) => api.post(`/todos/${id}/move`, { todo_date: today() }),
    onSuccess: () => refresh(),
    onError: (e: any) => toast.error(e.message),
  });

  const clearDone = useMutation({
    mutationFn: () => api.post('/todos/clear-completed', {}),
    onSuccess: () => { toast.success('Cleared the finished ones.'); refresh(); },
    onError: (e: any) => toast.error(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    add.mutate({
      title: text,
      todo_date: day || today(),
      ...(time ? { due_time: time } : {}),
      ...(priority !== 'normal' ? { priority } : {}),
    });
  };

  const items = data?.items || [];
  const pending = items.filter((t) => t.status === 'pending');
  const done = items.filter((t) => t.status === 'completed');
  const carried = data?.meta?.carried_over || 0;

  return (
    <Card className={className}>
      <CardHeader
        title="To-do & reminders"
        subtitle="Private to you. Add a time to get a reminder 10 minutes before"
        icon={<ListTodo size={16} />}
        action={done.length > 0 && (
          <button onClick={() => clearDone.mutate()}
            className="text-[12.5px] text-subtle hover:text-ink transition-colors cursor-pointer">
            Clear done
          </button>
        )}
      />

      {/* ------------------------------------------------------- add a line */}
      <form onSubmit={submit} className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Plus size={15} className="shrink-0 text-subtle" aria-hidden />
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setDetailed(true)}
            placeholder="Add a to-do or reminder…"
            aria-label="New to-do or reminder"
            maxLength={200}
            className="h-8 min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-subtle
                       border-0 outline-none focus:ring-0"
          />
          <Button type="submit" variant="primary" size="sm" loading={add.isPending} disabled={!title.trim()}>
            Add
          </Button>
        </div>

        {/* Time and priority stay out of the way until the field is in use. */}
        {detailed && (
          <div className="mt-2 flex flex-wrap items-center gap-2 pl-[23px] pr-0.5">
            <Input type="date" value={day} min={today()} onChange={(e) => setDay(e.target.value || today())}
              aria-label="Day" className="h-8 min-w-[130px] flex-1 text-[13px]" />
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)}
              aria-label="Due time (optional)" className="h-8 min-w-[96px] flex-1 text-[13px]" />
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}
              aria-label="Priority" className="h-8 min-w-[92px] flex-1 text-[13px]">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </Select>
            {(time || priority !== 'normal' || day !== today()) && (
              <button type="button" onClick={() => { setTime(''); setPriority('normal'); setDay(today()); }}
                className="text-[12.5px] text-subtle hover:text-ink transition-colors cursor-pointer">
                Reset
              </button>
            )}
          </div>
        )}
      </form>

      {/* ----------------------------------------------------------- list */}
      {isLoading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6" />)}
        </div>
      ) : !items.length ? (
        <EmptyState compact icon={<ListTodo size={20} />} title="Nothing for today"
          message="Jot down a to-do, or pick a later day to save a reminder for then." />
      ) : (
        <>
          <ul className="divide-y divide-[var(--border)]">
            {pending.map((t) => (
              <TodoRow
                key={t.id} todo={t}
                editing={editing === t.id}
                onEdit={() => setEditing(t.id)}
                onCancelEdit={() => setEditing(null)}
                onSave={(body) => save.mutate({ id: t.id, body })}
                onToggle={() => toggle.mutate(t.id)}
                onRemove={() => remove.mutate(t.id)}
                onPullForward={() => pullForward.mutate(t.id)}
              />
            ))}
          </ul>

          {done.length > 0 && (
            <>
              <p className="label-cap border-t border-line px-4 pb-1 pt-2.5">
                Done today · {done.length}
              </p>
              <ul className="divide-y divide-[var(--border)]">
                {done.map((t) => (
                  <TodoRow
                    key={t.id} todo={t}
                    editing={false}
                    onEdit={() => {}}
                    onCancelEdit={() => {}}
                    onSave={() => {}}
                    onToggle={() => toggle.mutate(t.id)}
                    onRemove={() => remove.mutate(t.id)}
                  />
                ))}
              </ul>
            </>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
            <p className="text-[12.5px] text-subtle">
              {pending.length} to go · {done.length} done
            </p>
            {carried > 0 && (
              <Badge tone="warning">{carried} from earlier</Badge>
            )}
          </div>
        </>
      )}

      {/* ------------------------------------------------- later days */}
      {!!upcoming.data?.length && (
        <>
          <p className="label-cap flex items-center gap-1.5 border-t border-line px-4 pb-1 pt-2.5">
            <CalendarDays size={12} aria-hidden /> Upcoming · {upcoming.data.length}
          </p>
          <ul className="divide-y divide-[var(--border)]">
            {upcoming.data.map((t) => (
              <TodoRow
                key={t.id} todo={t}
                editing={editing === t.id}
                onEdit={() => setEditing(t.id)}
                onCancelEdit={() => setEditing(null)}
                onSave={(body) => save.mutate({ id: t.id, body })}
                onToggle={() => toggle.mutate(t.id)}
                onRemove={() => remove.mutate(t.id)}
                onPullForward={() => pullForward.mutate(t.id)}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------- row */
function TodoRow({ todo: t, editing, onEdit, onCancelEdit, onSave, onToggle, onRemove, onPullForward }: {
  todo: Todo;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (body: Record<string, any>) => void;
  onToggle: () => void;
  onRemove: () => void;
  onPullForward?: () => void;
}) {
  const [draft, setDraft] = useState(t.title);
  const [time, setTime] = useState(t.due_time || '');
  const [priority, setPriority] = useState(t.priority);
  const [day, setDay] = useState(t.todo_date);

  const isDone = t.status === 'completed';
  const stale = !isDone && t.todo_date < today();
  const later = !isDone && t.todo_date > today();

  if (editing) {
    return (
      <li className="px-4 py-2.5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            onSave({ title: draft.trim(), due_time: time || null, priority, ...(day !== t.todo_date ? { todo_date: day } : {}) });
          }}
          className="space-y-2"
        >
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
            aria-label="Edit to-do" maxLength={200} className="h-8 text-[13.5px]" />
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value || t.todo_date)}
              aria-label="Day" className="h-8 min-w-[130px] flex-1 text-[13px]" />
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)}
              aria-label="Due time" className="h-8 min-w-[96px] flex-1 text-[13px]" />
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Todo['priority'])}
              aria-label="Priority" className="h-8 min-w-[92px] flex-1 text-[13px]">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </Select>
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onCancelEdit}>Cancel</Button>
              <Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>Save</Button>
            </div>
          </div>
        </form>
      </li>
    );
  }

  const meta = [
    later && fmtDate(t.todo_date),
    t.due_time && clock(t.due_time),
    // Priority reads as a word, not only as a colour.
    !isDone && t.priority !== 'normal' && t.priority,
    stale && 'carried over',
  ].filter(Boolean);

  return (
    <li className="group relative flex items-start gap-2.5 px-4 py-2.5 row-hover">
      <button
        onClick={onToggle}
        aria-label={isDone ? `Reopen "${t.title}"` : `Mark "${t.title}" done`}
        aria-pressed={isDone}
        className={cx(
          'mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2 cursor-pointer',
          'transition-colors duration-150',
          isDone
            ? 'border-[var(--positive)] bg-[var(--positive)] text-white'
            : t.priority === 'high'
              ? 'border-[var(--negative)] hover:bg-negative-soft'
              : 'border-line-strong hover:border-[var(--positive)] hover:bg-positive-soft',
        )}
      >
        <CheckCircle2 size={11} className={cx(isDone ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 text-[var(--positive)]')} />
      </button>

      <span className="min-w-0 flex-1">
        <span className={cx('block text-[13.5px] leading-snug',
          isDone ? 'text-subtle line-through' : 'text-ink')}>
          {t.title}
        </span>
        {!!meta.length && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-subtle">
            {meta.map((m, i) => (
              <span key={m as string} className={cx(
                m === 'high' && 'font-medium text-[var(--negative)]',
                m === 'carried over' && 'text-[var(--warning)]',
              )}>
                {i > 0 && <span className="mr-1.5 text-subtle" aria-hidden>·</span>}
                {m}
              </span>
            ))}
          </span>
        )}
      </span>

      {/* The controls overlay the row rather than sit in the flow: this card
          lives in a narrow column, and reflowing the title on hover would make
          the list jump under the pointer. */}
      <span className="absolute right-2 top-1.5 flex items-center gap-0.5 rounded-md
                       bg-[var(--surface-hover)] pl-1 opacity-0 transition-opacity
                       group-hover:opacity-100 focus-within:opacity-100">
        {(stale || later) && onPullForward && (
          <IconButton label={`Move "${t.title}" to today`} onClick={onPullForward}>
            <ArrowDownToLine size={14} />
          </IconButton>
        )}
        {!isDone && (
          <IconButton label={`Edit "${t.title}"`} onClick={onEdit}>
            <Pencil size={14} />
          </IconButton>
        )}
        <IconButton label={`Delete "${t.title}"`} onClick={onRemove} danger>
          <Trash2 size={14} />
        </IconButton>
      </span>
    </li>
  );
}

function IconButton({ label, onClick, children, danger }: {
  label: string; onClick: () => void; children: React.ReactNode; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick} aria-label={label} title={label}
      className={cx(
        'grid h-7 w-7 place-items-center rounded transition-colors duration-150 cursor-pointer',
        danger ? 'text-subtle hover:bg-negative-soft hover:text-[var(--negative)]'
          : 'text-subtle hover:bg-sunken hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
