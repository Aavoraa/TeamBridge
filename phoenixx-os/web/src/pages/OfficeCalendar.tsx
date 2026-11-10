import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays, ChevronLeft, ChevronRight, Clock, MapPin, Palmtree, Plus, Trash2, UserMinus, Video,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  Button, Card, Checkbox, ConfirmDialog, Field, Input, Modal, PageHeader, Select, Textarea, cx, useToast,
} from '../components/ui';

/* ------------------------------------------------------------ date helpers */
// Every date here is a workspace-local calendar day "YYYY-MM-DD"; arithmetic is done in UTC so DST never shifts a day.
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const todayIn = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
const dayInTz = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
const timeInTz = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz });
const clock = (hhmm?: string | null) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;
};
const longDay = (s: string) => parse(s).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The 6-week grid (Monday first) that shows the month containing `month` (YYYY-MM). */
function gridFor(month: string) {
  const first = parse(`${month}-01`);
  const lead = (first.getUTCDay() + 6) % 7;
  const start = addDays(`${month}-01`, -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/* ------------------------------------------------------------- categories */
const CATEGORIES = [
  { id: 'event', label: 'Office event', tone: 'brand' },
  { id: 'deadline', label: 'Deadline', tone: 'negative' },
  { id: 'training', label: 'Training', tone: 'info' },
  { id: 'celebration', label: 'Celebration', tone: 'accent' },
  { id: 'reminder', label: 'Reminder', tone: 'warning' },
  { id: 'other', label: 'Other', tone: 'neutral' },
] as const;
const toneOf = (cat: string) => CATEGORIES.find((c) => c.id === cat)?.tone || 'neutral';
const CHIP: Record<string, string> = {
  brand: 'bg-brand-soft text-[var(--brand)]',
  negative: 'bg-[var(--negative-soft)] text-[var(--negative)]',
  info: 'bg-[var(--info-soft)] text-[var(--info)]',
  accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  positive: 'bg-[var(--positive-soft)] text-[var(--positive)]',
  neutral: 'bg-sunken text-muted',
};

/** Solid colours for the phone view's dots (the soft chip backgrounds are too faint at that size). */
const DOT: Record<string, string> = {
  brand: 'var(--brand)', negative: 'var(--negative)', info: 'var(--info)', accent: 'var(--accent)',
  warning: 'var(--warning)', positive: 'var(--positive)', neutral: 'var(--ink-subtle)',
};

type Item = {
  key: string; kind: 'event' | 'holiday' | 'leave' | 'meeting'; title: string; tone: string;
  time?: string; sort: string; event?: any; meetingId?: string; sub?: string;
};

/* ------------------------------------------------------------------ page */
export default function OfficeCalendar() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const initial = params.get('date') || new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(initial.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(params.get('date'));
  const [show, setShow] = useState({ event: true, holiday: true, leave: true, meeting: true });
  const [editing, setEditing] = useState<any | null>(null); // {} = new event, else the event

  const days = useMemo(() => gridFor(month), [month]);
  const from = days[0];
  const to = days[days.length - 1];
  const { data, isLoading } = useQuery({
    queryKey: ['office-calendar', from, to],
    queryFn: () => api.get('/calendar', { from, to }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });
  const tz: string = data?.timezone || 'Asia/Kolkata';
  const today = todayIn(tz);

  /** Everything on each day, in a sensible order: all-day first, then by time. */
  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>();
    const put = (day: string, it: Item) => { if (!map.has(day)) map.set(day, []); map.get(day)!.push(it); };
    if (!data) return map;
    if (show.holiday) for (const h of data.holidays) put(h.date, { key: `h${h.id}`, kind: 'holiday', title: h.name, tone: 'positive', sort: '0', sub: 'Company holiday' });
    if (show.event) {
      for (const e of data.events) {
        for (let d = e.start_date < from ? from : e.start_date; d <= e.end_date && d <= to; d = addDays(d, 1)) {
          put(d, {
            key: `e${e.id}${d}`, kind: 'event', title: e.title, tone: toneOf(e.category), event: e,
            time: e.all_day ? undefined : (d === e.start_date ? clock(e.start_time) : undefined),
            sort: e.all_day ? '1' : `3${e.start_time}`,
          });
        }
      }
    }
    if (show.leave) {
      for (const l of data.leave) {
        for (let d = l.from_date < from ? from : l.from_date; d <= l.to_date && d <= to; d = addDays(d, 1)) {
          put(d, { key: `l${l.id}${d}`, kind: 'leave', title: `${l.name} — on leave`, tone: 'neutral', sort: '2' });
        }
      }
    }
    if (show.meeting) {
      for (const m of data.meetings) {
        put(dayInTz(m.scheduled_at, tz), {
          key: `m${m.id}`, kind: 'meeting', title: m.title, tone: 'info', meetingId: m.id,
          time: timeInTz(m.scheduled_at, tz), sort: `3${new Date(m.scheduled_at).toLocaleTimeString('en-GB', { timeZone: tz })}`,
          sub: `${m.duration_minutes} min meeting`,
        });
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.sort.localeCompare(b.sort));
    return map;
  }, [data, show, from, to, tz]);

  const go = (delta: number) => {
    const d = parse(`${month}-01`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    setMonth(ymd(d).slice(0, 7));
  };
  const pick = (day: string) => {
    setSelected(day);
    if (params.get('date')) { params.delete('date'); setParams(params, { replace: true }); }
  };
  const monthLabel = parse(`${month}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const openItem = (it: Item) => { if (it.kind === 'event') setEditing(it.event); };

  return (
    <>
      <PageHeader
        title="Office calendar"
        subtitle="One calendar for the whole team. Anyone can add or edit events; holidays, leave and your meetings show alongside."
        actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing({ start_date: selected || (month === today.slice(0, 7) ? today : `${month}-01`) })}>Add event</Button>}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="overflow-hidden">
          {/* Month bar */}
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line">
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => go(-1)}><ChevronLeft size={17} /></Button>
              <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => go(1)}><ChevronRight size={17} /></Button>
            </div>
            <h2 className="text-[17px] font-semibold text-ink min-w-[150px]">{monthLabel}</h2>
            <Button size="sm" onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>Today</Button>
            <div className="ml-auto flex flex-wrap gap-x-4 gap-y-1">
              {([['event', 'Office events'], ['holiday', 'Holidays'], ['leave', 'On leave'], ['meeting', 'My meetings']] as const).map(([k, label]) => (
                <Checkbox key={k} label={<span className="text-[13px]">{label}</span>} checked={show[k]} onChange={(v) => setShow((s) => ({ ...s, [k]: v }))} />
              ))}
            </div>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b border-line bg-sunken/50">
            {WEEKDAYS.map((w) => <div key={w} className="px-2 py-2 text-[12px] font-medium text-subtle text-center sm:text-left">{w}</div>)}
          </div>

          {/* Days */}
          <div className={cx('grid grid-cols-7', isLoading && 'opacity-60')}>
            {days.map((d, i) => {
              const items = byDay.get(d) || [];
              const inMonth = d.slice(0, 7) === month;
              const isToday = d === today;
              const isSel = d === selected;
              const weekend = i % 7 >= 5;
              return (
                <div key={d} role="button" tabIndex={0} aria-label={longDay(d)}
                  onClick={() => pick(d)} onKeyDown={(e) => { if (e.key === 'Enter') pick(d); }}
                  onDoubleClick={() => setEditing({ start_date: d })}
                  className={cx(
                    'group relative min-h-[64px] sm:min-h-[108px] border-b border-r border-line p-1 sm:p-1.5 text-left cursor-pointer outline-none',
                    'transition-colors hover:bg-sunken/60 focus-visible:ring-2 focus-visible:ring-[var(--brand)]',
                    (i + 1) % 7 === 0 && 'border-r-0',
                    !inMonth && 'bg-sunken/40',
                    weekend && inMonth && 'bg-sunken/20',
                    isSel && 'bg-brand-soft/60',
                  )}>
                  <div className="flex items-center justify-between">
                    <span className={cx(
                      'grid h-6 min-w-6 place-items-center rounded-full px-1 text-[12.5px] tabular',
                      isToday ? 'bg-[var(--brand)] text-white font-semibold' : inMonth ? 'text-ink' : 'text-subtle',
                    )}>{Number(d.slice(8))}</span>
                    <button type="button" aria-label={`Add an event on ${longDay(d)}`}
                      onClick={(e) => { e.stopPropagation(); setEditing({ start_date: d }); }}
                      className="hidden sm:grid h-6 w-6 place-items-center rounded-md text-subtle opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-ink">
                      <Plus size={14} />
                    </button>
                  </div>
                  {/* Phones: dots. Larger screens: the first few entries. */}
                  <div className="mt-1 flex flex-wrap gap-0.5 sm:hidden">
                    {items.slice(0, 4).map((it) => <span key={it.key} className="h-1.5 w-1.5 rounded-full" style={{ background: DOT[it.tone] }} />)}
                  </div>
                  <div className="mt-1 hidden sm:block space-y-0.5">
                    {items.slice(0, 3).map((it) => (
                      <button key={it.key} type="button" title={it.title}
                        onClick={(e) => { e.stopPropagation(); if (it.kind === 'event') openItem(it); else pick(d); }}
                        className={cx('flex w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-left text-[11.5px] font-medium', CHIP[it.tone])}>
                        {it.time && <span className="shrink-0 opacity-80 tabular">{it.time}</span>}
                        <span className="truncate">{it.title}</span>
                      </button>
                    ))}
                    {items.length > 3 && <span className="block px-1.5 text-[11px] text-subtle">+{items.length - 3} more</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <DayPanel day={selected || today} items={byDay.get(selected || today) || []}
          onAdd={(d) => setEditing({ start_date: d })} onOpen={openItem} />
      </div>

      {editing && (
        <EventModal initial={editing} onClose={() => setEditing(null)}
          onSaved={(d?: string) => {
            qc.invalidateQueries({ queryKey: ['office-calendar'] });
            if (d) { setMonth(d.slice(0, 7)); setSelected(d); }
            setEditing(null);
          }} />
      )}
    </>
  );
}

/* ------------------------------------------------------------- day panel */
function DayPanel({ day, items, onAdd, onOpen }: {
  day: string; items: Item[]; onAdd: (d: string) => void; onOpen: (it: Item) => void;
}) {
  return (
    <Card className="self-start">
      <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-2">
        <div>
          <p className="text-[12px] text-subtle">Selected day</p>
          <h3 className="text-[15px] font-semibold text-ink">{longDay(day)}</h3>
        </div>
        <Button size="sm" icon={<Plus size={14} />} onClick={() => onAdd(day)}>Add</Button>
      </div>
      <div className="px-4 pb-4 space-y-2">
        {!items.length && <p className="py-6 text-center text-[13px] text-subtle">Nothing on this day.</p>}
        {items.map((it) => {
          const Icon = it.kind === 'holiday' ? Palmtree : it.kind === 'leave' ? UserMinus : it.kind === 'meeting' ? Video : CalendarDays;
          const body = (
            <div className="flex gap-2.5">
              <span className={cx('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg', CHIP[it.tone])}><Icon size={14} /></span>
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-ink leading-snug">{it.title}</p>
                <p className="text-[12px] text-subtle">
                  {it.kind === 'event' ? eventWhen(it.event) : [it.time, it.sub].filter(Boolean).join(' · ')}
                </p>
                {it.event?.location && <p className="text-[12px] text-subtle flex items-center gap-1"><MapPin size={11} />{it.event.location}</p>}
              </div>
            </div>
          );
          if (it.kind === 'event') return <button key={it.key} type="button" onClick={() => onOpen(it)} className="block w-full rounded-lg p-2 text-left hover:bg-sunken">{body}</button>;
          if (it.kind === 'meeting') return <Link key={it.key} to={`/ai-meetings/m/${it.meetingId}`} className="block rounded-lg p-2 hover:bg-sunken">{body}</Link>;
          return <div key={it.key} className="p-2">{body}</div>;
        })}
      </div>
    </Card>
  );
}

function eventWhen(e: any) {
  const label = CATEGORIES.find((c) => c.id === e.category)?.label || 'Event';
  const span = e.end_date !== e.start_date
    ? `${parse(e.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })} – ${parse(e.end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`
    : '';
  const time = e.all_day ? 'All day' : `${clock(e.start_time)}${e.end_time ? ` – ${clock(e.end_time)}` : ''}`;
  return [label, span, time].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------ add / edit */
function EventModal({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: (day?: string) => void }) {
  const toast = useToast();
  const isNew = !initial.id;
  const [f, setF] = useState({
    title: initial.title || '',
    category: initial.category || 'event',
    all_day: initial.all_day ?? true,
    start_date: initial.start_date || '',
    end_date: initial.end_date || initial.start_date || '',
    start_time: initial.start_time || '10:00',
    end_time: initial.end_time || '11:00',
    location: initial.location || '',
    description: initial.description || '',
    notify_team: false,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (k: keyof typeof f, v: any) => setF((s) => {
    const next = { ...s, [k]: v };
    // Moving the start past the end drags the end along.
    if (k === 'start_date' && (!s.end_date || s.end_date < v || s.end_date === s.start_date)) next.end_date = v;
    return next;
  });

  const save = useMutation({
    mutationFn: () => {
      const body: any = {
        title: f.title.trim(), category: f.category, all_day: f.all_day, start_date: f.start_date, end_date: f.end_date || f.start_date,
        location: f.location.trim() || null, description: f.description.trim() || null,
        start_time: f.all_day ? null : f.start_time, end_time: f.all_day ? null : (f.end_time || null),
      };
      if (isNew) body.notify_team = f.notify_team;
      return isNew ? api.post('/calendar/events', body) : api.patch(`/calendar/events/${initial.id}`, body);
    },
    onSuccess: () => { toast.success(isNew ? (f.notify_team ? 'Added, and the team was told.' : 'Added to the office calendar.') : 'Event updated.'); onSaved(f.start_date); },
    onError: (e: any) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/calendar/events/${initial.id}`),
    onSuccess: () => { toast.success('Event deleted.'); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  const ready = f.title.trim().length >= 2 && !!f.start_date && (f.all_day || !!f.start_time);

  return (
    <Modal open onClose={onClose} size="md" title={isNew ? 'Add to the office calendar' : 'Edit event'}
      subtitle={isNew ? 'Everyone on the team will see it and can edit it.'
        : `Added by ${initial.created_by_name || 'someone'}${initial.updated_by_name && initial.updated_by_name !== initial.created_by_name ? ` · last edited by ${initial.updated_by_name}` : ''}`}
      footer={(
        <>
          {!isNew && initial.can_delete && (
            <Button variant="ghost" className="mr-auto text-[var(--negative)]" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>Delete</Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!ready} onClick={() => save.mutate()}>
            {isNew ? 'Add event' : 'Save changes'}
          </Button>
        </>
      )}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate(); }}>
        <Field label="What" required>
          <Input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Team lunch, client visit, GST filing…" autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Select value={f.category} onChange={(e) => set('category', e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox label="All day" checked={f.all_day} onChange={(v) => set('all_day', v)} />
          </div>
          <Field label="Starts" required>
            <Input type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} />
          </Field>
          <Field label="Ends" hint="Leave as is for a one-day event">
            <Input type="date" value={f.end_date} min={f.start_date} onChange={(e) => set('end_date', e.target.value)} />
          </Field>
          {!f.all_day && (
            <>
              <Field label="From" required>
                <Input type="time" value={f.start_time} onChange={(e) => set('start_time', e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="time" value={f.end_time} onChange={(e) => set('end_time', e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <Field label="Where">
          <Input value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Office, conference room, address or link" />
        </Field>
        <Field label="Details">
          <Textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        {isNew && (
          <Checkbox label={<span className="flex items-center gap-1.5"><Clock size={13} className="text-subtle" />Notify everyone on the team</span>}
            checked={f.notify_team} onChange={(v) => set('notify_team', v)} />
        )}
      </form>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={() => remove.mutate()}
        title="Delete this event?" danger confirmLabel="Delete" loading={remove.isPending}
        message={`"${initial.title}" is removed from everyone's calendar.`} />
    </Modal>
  );
}
