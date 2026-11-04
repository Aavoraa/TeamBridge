import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Send } from 'lucide-react';
import { api } from '../lib/api';
import { relative, dateTime, dueLabel } from '../lib/format';
import {
  Avatar, Badge, Button, Field, Input, Modal, Select, Textarea, cx, useToast,
} from './ui';

/**
 * The daily update — the standup, written down.
 *
 * Six questions in a fixed order, because the value of this is that every
 * update reads the same way on the manager's board: what moved, what is
 * moving, what has not started, what is in the way, what happens next, and
 * anything else. Only "completed today" is nudged as the one to fill; the API
 * accepts any one of them, so a day where the only news is a blocker is still
 * a valid update.
 *
 * One update per person per task per day. Opening it again the same day loads
 * what you already wrote and tops it up rather than starting a second entry.
 */

const STATUSES = ['open', 'in_progress', 'blocked', 'done'];

/** The six fields, in the order they are asked. */
export const UPDATE_FIELDS = [
  {
    key: 'completed_today',
    label: 'Work completed today',
    placeholder: 'Pulled the August numbers and drafted the summary',
    rows: 2,
  },
  {
    key: 'in_progress',
    label: 'Work in progress',
    placeholder: 'Charts for the media section',
    rows: 2,
  },
  {
    key: 'pending',
    label: 'Pending work',
    placeholder: 'Client sign-off on the creative',
    rows: 2,
  },
  {
    key: 'blockers',
    label: 'Issues / blockers',
    placeholder: 'Waiting on brand assets — chased twice',
    hint: 'Anyone named here gets told today: the accountable owner and your manager',
    rows: 2,
    tone: 'negative' as const,
  },
  {
    key: 'next_action',
    label: 'Next action',
    placeholder: 'Send the draft to Divya tomorrow morning',
    rows: 2,
  },
  {
    key: 'remarks',
    label: 'Remarks',
    placeholder: 'Anything else worth knowing',
    rows: 2,
  },
];

type Existing = Record<string, any> | null;

export function DailyUpdateModal({ task, existing, onClose, onSaved }: {
  task: any; existing?: Existing; onClose: () => void; onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(UPDATE_FIELDS.map((f) => [f.key, existing?.[f.key] || ''])));
  const [progress, setProgress] = useState(String(existing?.progress_pct ?? ''));
  const [hours, setHours] = useState(String(existing?.hours_spent ?? ''));
  const [status, setStatus] = useState(task.status || 'open');

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.post(`/action-items/${task.id}/updates`, {
      // Send every field, empty ones as null, so clearing a line actually
      // clears it. The API merges only what it is given.
      ...Object.fromEntries(UPDATE_FIELDS.map((f) => [f.key, form[f.key].trim() || null])),
      progress_pct: progress === '' ? null : Number(progress),
      hours_spent: hours === '' ? null : Number(hours),
      ...(status !== task.status ? { status } : {}),
    }),
    onSuccess: () => {
      toast.success(existing ? 'Update saved.' : 'Update logged.');
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['action-item', task.id] });
      qc.invalidateQueries({ queryKey: ['my-updates'] });
      qc.invalidateQueries({ queryKey: ['team-updates'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'home'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      onSaved?.();
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const anything = UPDATE_FIELDS.some((f) => form[f.key].trim());

  return (
    <Modal
      open onClose={onClose} size="lg"
      title={existing ? "Edit today's update" : 'Daily update'}
      subtitle={task.title}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send size={15} />} loading={save.isPending}
            disabled={!anything} onClick={() => save.mutate()}>
            {existing ? 'Save update' : 'Submit update'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {existing && (
          <p className="rounded-md border border-line bg-sunken px-3 py-2 text-[12.5px] text-subtle">
            You logged this {relative(existing.updated_at)}. Saving again tops up the same
            entry rather than adding a second one.
          </p>
        )}

        {UPDATE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <Textarea
              rows={f.rows} value={form[f.key]} placeholder={f.placeholder}
              onChange={(e) => set(f.key, e.target.value)}
              className={cx(f.tone === 'negative' && form[f.key].trim()
                && 'border-[color-mix(in_srgb,var(--negative)_45%,transparent)]')}
            />
          </Field>
        ))}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Progress" hint="Your own estimate">
            <div className="flex items-center gap-2">
              <Input type="number" min={0} max={100} step={5} value={progress}
                onChange={(e) => setProgress(e.target.value)} placeholder="60" />
              <span className="text-[13px] text-subtle">%</span>
            </div>
          </Field>
          <Field label="Hours spent">
            <Input type="number" min={0} max={24} step={0.5} value={hours}
              onChange={(e) => setHours(e.target.value)} placeholder="3.5" />
          </Field>
          <Field label="Task status" hint="Moves the task as you log">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ read view */
/** One submitted update, as everybody else reads it. */
export function UpdateCard({ update, showPerson, showTask, compact }: {
  update: any; showPerson?: boolean; showTask?: boolean; compact?: boolean;
}) {
  const lines = UPDATE_FIELDS.filter((f) => update[f.key]?.trim());

  return (
    <div className={cx('rounded-lg border border-line bg-raised', compact ? 'p-3' : 'p-3.5')}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {showPerson && (
          <span className="flex items-center gap-1.5">
            <Avatar name={update.user_name} url={update.avatar_url} size={22} />
            <span className="text-[13px] font-medium text-ink">{update.user_name}</span>
          </span>
        )}
        {showTask && (
          <span className="text-[13px] font-medium text-ink truncate max-w-[280px]">{update.task_title}</span>
        )}
        {update.progress_pct != null && (
          <Badge tone={update.progress_pct >= 80 ? 'positive' : update.progress_pct >= 40 ? 'brand' : 'neutral'}>
            {update.progress_pct}%
          </Badge>
        )}
        {update.blockers?.trim() && <Badge tone="negative" dot>blocked</Badge>}
        {update.hours_spent != null && (
          <span className="text-[12px] text-subtle tabular">{update.hours_spent}h</span>
        )}
        <span className="ml-auto text-[11.5px] text-subtle">{dateTime(update.updated_at)}</span>
      </div>

      <dl className="space-y-1.5">
        {lines.map((f) => (
          <div key={f.key} className="grid grid-cols-[124px_1fr] gap-2 max-sm:grid-cols-1 max-sm:gap-0.5">
            <dt className={cx('text-[12px] font-medium',
              f.tone === 'negative' ? 'text-[var(--negative)]' : 'text-subtle')}>
              {f.label}
            </dt>
            <dd className="text-[13px] text-ink leading-snug whitespace-pre-wrap">{update[f.key]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A row that asks for an update it has not had. */
export function NeedsUpdateRow({ task, onLog }: { task: any; onLog: () => void }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 row-hover">
      <CircleAlert size={15} className="shrink-0 text-[var(--warning)]" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-ink">{task.title}</span>
        <span className="text-[12px] text-subtle">
          {[task.client_name, task.due_date && `due ${dueLabel(task)}`].filter(Boolean).join(' · ')
            || 'no due date'}
        </span>
      </span>
      <Button size="sm" variant="primary" onClick={onLog}>Update</Button>
    </li>
  );
}
