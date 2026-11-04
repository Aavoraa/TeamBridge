import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardList, ListChecks, Plus, Trash2, Check, CheckCircle2, MessageSquare, Send, Undo2, Users2, Clock, AlertTriangle,
  ArrowUpRight, ShieldCheck, User,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, time, dateTime, clockTime } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, Select, Skeleton, StatusBadge, Textarea, useToast, cx,
} from './ui';

/**
 * Advance Planner: the plan each person files for their next working day,
 * and the reporting person's review of it. The server decides every rule
 * (who may edit, what is late, who reviews); these screens only show it.
 */

type Tone = 'neutral' | 'brand' | 'positive' | 'negative' | 'warning' | 'accent' | 'info';

export const PLAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Submitted', tone: 'brand' },
  UNDER_REVIEW: { label: 'Under review', tone: 'info' },
  APPROVED: { label: 'Approved', tone: 'positive' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'warning' },
  LATE: { label: 'Submitted late', tone: 'warning' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  MISSED: { label: 'Missed', tone: 'negative' },
};

/** The Action Items scale and order, so a planned task becomes an item without translation. */
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const PRIORITY: Record<string, { label: string; dot: string }> = {
  urgent: { label: 'Urgent', dot: 'bg-[var(--negative)]' },
  high: { label: 'High', dot: 'bg-[var(--warning)]' },
  medium: { label: 'Medium', dot: 'bg-[var(--brand)]' },
  low: { label: 'Low', dot: 'bg-[var(--positive)]' },
};

/** Ticked off in the planner, or - once it is an action item - marked done there. */
const taskDone = (t: any) => !!t.done_at || t.action_item?.status === 'done';

/** The sign-off state of a linked action item, in the Action Items wording. */
function ItemValidation({ v, status }: { v: string; status: string }) {
  if (v === 'validated') return <Badge tone="positive" dot>validated</Badge>;
  if (v === 'changes_requested') return <Badge tone="warning" dot>needs changes</Badge>;
  if (status === 'done') return <Badge tone="warning" dot>awaiting validation</Badge>;
  return null;
}

/**
 * The plan's tasks against Action Items: how many are there, how many are not,
 * the button that converts the rest, and what the last run did.
 */
function ConversionPanel({ planId, c, outcome, busy, onConvert }: {
  planId: string; c: any; outcome: any; busy: boolean; onConvert: () => void;
}) {
  const issues = outcome ? [...outcome.skipped, ...outcome.failed] : [];
  return (
    <div className="rounded-lg border border-line bg-sunken p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label-cap">Action items</p>
        <span className="flex flex-wrap items-center gap-2">
          {c.converted > 0 && (
            <Link to={`/action-items?source_plan_id=${planId}`}
              className="inline-flex items-center gap-0.5 text-[12.5px] font-medium text-[var(--brand)] hover:underline">
              View in Action Items <ArrowUpRight size={13} />
            </Link>
          )}
          {c.can_convert && (
            <Button size="sm" variant="primary" icon={<ListChecks size={14} />} loading={busy} disabled={busy} onClick={onConvert}>
              Create Action Items
            </Button>
          )}
        </span>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-[var(--border)]">
        {[
          ['Planner tasks', c.total, ''],
          ['Converted', c.converted, c.converted ? 'text-[var(--positive)]' : ''],
          ['Not converted', c.not_converted, c.not_converted ? 'text-[var(--warning)]' : ''],
        ].map(([label, n, tone]) => (
          <div key={label as string} className="bg-raised px-3 py-2">
            <p className="text-[11.5px] text-subtle">{label}</p>
            <p className={cx('text-[17px] font-semibold tabular text-ink', tone as string)}>{n}</p>
          </div>
        ))}
      </div>
      {c.reviewer && (
        <p className="mt-2 text-[12.5px] text-subtle">
          Each task becomes one action item assigned to {c.assignee?.name}, validated by {c.reviewer.name}. Progress is tracked there from then on.
        </p>
      )}
      {c.problem && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12.5px] text-[var(--negative)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {c.problem}
        </p>
      )}
      {outcome && (
        <div className="mt-2.5 rounded-md border border-line bg-raised px-3 py-2 text-[12.5px]">
          <p className="text-ink">
            <span className="font-medium">Last run:</span> {outcome.created.length} created
            · {outcome.already_converted.length} already converted
            {outcome.skipped.length > 0 && <> · {outcome.skipped.length} skipped</>}
            {outcome.failed.length > 0 && <span className="text-[var(--negative)]"> · {outcome.failed.length} failed</span>}
          </p>
          {issues.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-muted">
              {issues.map((x: any) => <li key={x.task_id}>“{x.task}” — {x.reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The fields one planned task is made of, shared by the plan editor and "add task". */
function TaskFields({ row, set, options, error, autoFocus, todoDate }: {
  row: TaskRow; set: (k: keyof TaskRow, v: string) => void; options: { projects: any[]; clients: any[] };
  error?: string; autoFocus?: boolean; todoDate?: string;
}) {
  return (
    <>
      <Field label="Title" required error={error}>
        <Input value={row.task} maxLength={300} autoFocus={autoFocus}
          placeholder="e.g. Follow up with 20 prospects" onChange={(e) => set('task', e.target.value)} />
      </Field>
      <Field label="Description">
        <Textarea rows={2} value={row.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)}
          placeholder="Context, links, what 'done' looks like…" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project">
          <Select value={row.project_id} onChange={(e) => set('project_id', e.target.value)}>
            <option value="">No project</option>
            {options.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        {options.clients.length > 0 && (
          <Field label="Client">
            <Select value={row.client_id} onChange={(e) => set('client_id', e.target.value)}>
              <option value="">No client</option>
              {options.clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Priority">
          <Select value={row.priority} onChange={(e) => set('priority', e.target.value)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
      </div>
      {/* The day is the plan's; only the time on it is the task's own. */}
      <div className="rounded-lg border border-line bg-sunken p-3">
        <p className="label-cap mb-2.5">Due</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Due date">
            <Input type="date" value={todoDate || ''} disabled readOnly />
          </Field>
          <Field label="Due time">
            <Input type="time" value={row.expected_time} onChange={(e) => set('expected_time', e.target.value)} />
          </Field>
        </div>
        <p className="mt-2 text-[12.5px] text-subtle">Optional. Left blank, it is due by the end of the planned day.</p>
      </div>
    </>
  );
}

/** Who the plan's action items go to, read from the server - never picked here. */
function AssignmentPanel({ assignee, reviewer }: { assignee?: string | null; reviewer?: string | null }) {
  return (
    <div className="rounded-lg border border-line bg-sunken p-3">
      <p className="label-cap mb-2.5">Assign to</p>
      <div className="grid gap-3 sm:grid-cols-2 text-[13px]">
        <div>
          <p className="text-muted mb-1">Assigned to</p>
          <p className="flex items-center gap-1.5 font-medium text-ink"><User size={14} /> {assignee || 'You'}</p>
        </div>
        <div>
          <p className="text-muted mb-1">Validated by</p>
          {reviewer
            ? <p className="flex items-center gap-1.5 font-medium text-ink"><ShieldCheck size={14} /> {reviewer}</p>
            : <p className="text-[var(--negative)]">No reporting person on record. Ask the owner to set one.</p>}
        </div>
      </div>
      <p className="mt-2 text-[12.5px] text-subtle">
        Each task becomes its own action item, assigned to the person who planned it and validated by their reporting person.
      </p>
    </div>
  );
}

/** "Task 2: describe the task" from the server, as the row and the message. */
const rowError = (message: string) => {
  const m = /^Task (\d+): (.*)$/.exec(message || '');
  return m ? { index: Number(m[1]) - 1, message: m[2] } : null;
};
/** The server drops rows nobody filled in before numbering them; so does this. */
const touched = (t: TaskRow) => !!(t.task.trim() || t.notes.trim() || t.project_id || t.client_id || t.checklist.length);

const FILED = ['SUBMITTED', 'LATE', 'UNDER_REVIEW', 'APPROVED'];

export function PlanStatus({ status }: { status?: string | null }) {
  if (!status) return <Badge tone="neutral" dot>Not submitted</Badge>;
  const s = PLAN_STATUS[status] || { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone} dot>{s.label}</Badge>;
}

const PriorityDot = ({ p }: { p: string }) => (
  <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', PRIORITY[p]?.dot)} aria-label={`${PRIORITY[p]?.label} priority`} />
);

/* ================================================================ the row on Home */
/**
 * Sits between the counters and the chat. The person's own card is always
 * first; a reporting person also gets their team beside it.
 */
export function TodoPlanSection() {
  const [params, setParams] = useSearchParams();
  const openId = params.get('plan');
  const [editing, setEditing] = useState(false);

  const mine = useQuery({ queryKey: ['todo-plan', 'mine'], queryFn: () => api.get('/todo-plan/mine').then((r) => r.data) });
  const team = useQuery({ queryKey: ['todo-plan', 'team'], queryFn: () => api.get('/todo-plan/team').then((r) => r.data) });

  const close = () => { params.delete('plan'); params.delete('add'); setParams(params, { replace: true }); };
  const view = (id: string, add = false) => {
    params.set('plan', id);
    if (add) params.set('add', '1'); else params.delete('add');
    setParams(params, { replace: true });
  };

  const showMine = !!mine.data?.expected && !!mine.data?.settings?.enabled;
  const showTeam = !!team.data?.is_reviewer;
  if (mine.isLoading || team.isLoading) return <Skeleton className="h-[150px] mb-5" />;
  if (!showMine && !showTeam) return null;

  return (
    <>
      <div className={cx('grid gap-5 mb-5', showMine && showTeam && 'lg:grid-cols-3')}>
        {showMine && <MyPlanCard data={mine.data} onCreate={() => setEditing(true)} onView={view} />}
        {showTeam && <TeamPlanCard initial={team.data} onView={view} className={showMine ? 'lg:col-span-2' : ''} />}
      </div>
      {editing && <PlanEditor onClose={() => setEditing(false)} />}
      {openId && !editing && (
        <PlanModal id={openId} startAdding={params.get('add') === '1'} onClose={close} onEdit={() => { close(); setEditing(true); }} />
      )}
    </>
  );
}

/* ================================================================ employee card */
function MyPlanCard({ data, onCreate, onView }: { data: any; onCreate: () => void; onView: (id: string, add?: boolean) => void }) {
  const { window: win, settings, plan, reporting_person: rp, history, today_plan: today } = data;
  const status = plan?.status;
  const filed = status && FILED.includes(status);
  const lastNote = plan?.comments?.filter((c: any) => c.kind === 'changes_requested').at(-1);
  const deadline = clockTime(settings.deadline_time);

  let body;
  if (!win.todo_date && !plan) {
    body = <EmptyState compact icon={<ClipboardList size={18} />} title="No plan to file today"
      message="Today is not a working day. Your next plan opens on the next working day." />;
  } else if (status === 'CHANGES_REQUESTED') {
    body = (
      <div className="space-y-3">
        <div className="rounded-md border border-[var(--warning)]/40 bg-warning-soft px-3 py-2.5 text-[13px]">
          <p className="font-medium text-ink">{lastNote?.user_name || 'Your reporting person'} asked for changes</p>
          {lastNote?.body && <p className="text-muted mt-0.5">“{lastNote.body}”</p>}
        </div>
        <Button variant="primary" icon={<Undo2 size={15} />} onClick={onCreate}>Edit & resubmit</Button>
      </div>
    );
  } else if (filed) {
    body = (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
          <CheckCircle2 size={17} className="text-[var(--positive)]" /> Submitted
          <span className="text-muted font-normal">at {time(plan.submitted_at)}</span>
          {plan.minutes_late ? <span className="text-[12.5px] text-[var(--warning)] font-normal">· {plan.minutes_late} min late</span> : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <PlanStatus status={status} />
          <span className="text-[12.5px] text-subtle">{plan.tasks.length} task(s)</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onView(plan.id)}>View submission</Button>
          {plan.can_edit && <Button variant="ghost" onClick={onCreate}>Edit before deadline</Button>}
        </div>
      </div>
    );
  } else if (status === 'MISSED') {
    body = <p className="text-[13px] text-muted">The plan for {date(plan.todo_date, 'long')} was not submitted.</p>;
  } else {
    const closed = win.phase === 'past_deadline' && !settings.allow_late;
    body = (
      <div className="space-y-3">
        <div className="text-[13px] space-y-1">
          <p className="text-muted">Submission deadline <span className="text-ink font-medium">{deadline}</span>
            {win.phase === 'not_open' && <span> · opens {clockTime(settings.open_time)}</span>}</p>
          <p className="flex items-center gap-2 text-muted">Status
            {status === 'OVERDUE' || (win.phase === 'past_deadline' && !plan)
              ? <PlanStatus status="OVERDUE" />
              : status === 'DRAFT' ? <PlanStatus status="DRAFT" /> : <PlanStatus status={null} />}
          </p>
        </div>
        {closed ? (
          <p className="text-[12.5px] text-[var(--negative)]">The deadline has passed and late plans are not accepted.</p>
        ) : (
          <Button variant="primary" icon={<Plus size={15} />} onClick={onCreate}>
            {plan ? 'Continue my plan' : 'Create advance plan'}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader title="Advance Planner" icon={<ClipboardList size={16} />}
        subtitle={(win.todo_date || plan?.todo_date)
          ? `For ${date(plan?.todo_date || win.todo_date, 'long')}${rp ? ` · goes to ${rp.name}` : ''}`
          : undefined} />
      {today && <TodayStrip plan={today} onView={onView} />}
      <div className="p-4">{body}</div>
      {history?.length > 0 && (
        <details className="border-t border-line">
          <summary className="px-4 py-2 text-[12.5px] text-subtle cursor-pointer hover:text-ink">Previous plans</summary>
          <ul className="px-4 pb-3 space-y-1.5">
            {history.slice(0, 7).map((h: any) => (
              <li key={h.id}>
                <button onClick={() => onView(h.id)}
                  className="w-full flex items-center justify-between gap-2 text-[12.5px] cursor-pointer hover:text-ink text-muted">
                  <span>{date(h.todo_date, 'day')} · {h.task_count} task(s)</span>
                  <PlanStatus status={h.status} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

/* ================================================================ editor */
type CheckItem = { key: string; text: string; done: boolean };
type TaskRow = {
  key: string; task: string; project_id: string; client_id: string; priority: string; expected_time: string; notes: string;
  checklist: CheckItem[];
};
const newKey = () => Math.random().toString(36).slice(2);
const blank = (): TaskRow => ({ key: newKey(), task: '', project_id: '', client_id: '', priority: 'medium', expected_time: '', notes: '', checklist: [] });

function PlanEditor({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { data } = useQuery({ queryKey: ['todo-plan', 'mine'], queryFn: () => api.get('/todo-plan/mine').then((r) => r.data) });
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  // Keyed by row, like the Action Items form keys its errors by field.
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data || rows) return;
    const existing = data.plan?.tasks || [];
    setRows(existing.length
      ? existing.map((t: any) => ({ ...blank(), ...t, project_id: t.project_id || '', client_id: t.client_id || '', expected_time: t.expected_time || '', notes: t.notes || '',
        checklist: (t.checklist || []).map((c: any) => ({ key: newKey(), text: c.text, done: !!c.done })) }))
      : [blank()]);
  }, [data]);

  const todoDate = data?.plan?.todo_date || data?.window?.todo_date;
  const save = useMutation({
    mutationFn: (submit: boolean) => api.put(`/todo-plan/mine/${todoDate}`, {
      submit,
      tasks: (rows || []).map(({ key, ...t }) => ({
        ...t, project_id: t.project_id || null, client_id: t.client_id || null, expected_time: t.expected_time || null,
        checklist: t.checklist.map(({ key: _k, ...c }) => c),
      })),
    }),
    onSuccess: (r: any, submit) => {
      qc.invalidateQueries({ queryKey: ['todo-plan'] });
      if (submit) {
        toast.success(r.data.status === 'LATE' ? `Submitted (${r.data.minutes_late} min late).` : `Submitted to ${r.data.reporting_person_name || 'your reporting person'}.`);
        onClose();
      } else toast.success('Draft saved.');
    },
    onError: (e: any) => {
      const hit = rowError(e.message);
      const row = hit && (rows || []).filter(touched)[hit.index];
      if (row) setErrors({ [row.key]: hit.message });
      toast.error(e.fieldErrors?.reporting_person_id || e.message);
    },
  });

  /** The required-field check the Action Items form makes, before the round trip. */
  const attempt = (submit: boolean) => {
    const missing = (rows || []).filter((r) => touched(r) && !r.task.trim());
    if (missing.length) {
      setErrors(Object.fromEntries(missing.map((r) => [r.key, 'Give the task a title'])));
      return;
    }
    save.mutate(submit);
  };

  const set = (key: string, k: keyof TaskRow, v: string) => {
    setRows((rs) => (rs || []).map((r) => (r.key === key ? { ...r, [k]: v } : r)));
    setErrors((e) => ({ ...e, [key]: '' }));
  };
  const setChecklist = (key: string, fn: (list: CheckItem[]) => CheckItem[]) =>
    setRows((rs) => (rs || []).map((r) => (r.key === key ? { ...r, checklist: fn(r.checklist) } : r)));
  const opts = data?.options || { projects: [], clients: [] };
  const lastNote = data?.plan?.comments?.filter((c: any) => c.kind === 'changes_requested').at(-1);

  return (
    <Modal open onClose={onClose} size="lg" title="Advance Planner"
      subtitle={data ? `${user?.name} · ${date(todoDate, 'long')} · reporting to ${data.reporting_person?.name || '—'}` : undefined}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending && save.variables === false} disabled={save.isPending} onClick={() => attempt(false)}>Save draft</Button>
          <Button variant="primary" icon={<Send size={15} />} loading={save.isPending && save.variables === true}
            disabled={save.isPending || (!!data && !data.reporting_person)} onClick={() => attempt(true)}>
            {data?.plan?.status === 'CHANGES_REQUESTED' ? 'Resubmit' : 'Submit plan'}
          </Button>
        </>
      )}>
      {!rows ? <Skeleton className="h-40" /> : (
        <div className="space-y-4">
          {lastNote?.body && (
            <div className="rounded-md border border-[var(--warning)]/40 bg-warning-soft px-3 py-2.5 text-[13px]">
              <span className="font-medium text-ink">{lastNote.user_name}:</span> <span className="text-muted">{lastNote.body}</span>
            </div>
          )}
          <AssignmentPanel assignee={user?.name} reviewer={data?.reporting_person?.name} />
          {rows.map((r, i) => (
            <fieldset key={r.key} className="rounded-lg border border-line p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <legend className="text-[12.5px] font-semibold text-subtle">Task {i + 1}</legend>
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                    className="text-subtle hover:text-[var(--negative)] cursor-pointer" aria-label={`Remove task ${i + 1}`}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <TaskFields row={r} set={(k, v) => set(r.key, k, v)} options={opts} error={errors[r.key]}
                autoFocus={i === rows.length - 1} todoDate={todoDate} />
              <ChecklistEditor items={r.checklist} onChange={(fn) => setChecklist(r.key, fn)} />
            </fieldset>
          ))}
          {rows.length < 30 && (
            <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setRows([...rows, blank()])}>Add another task</Button>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ================================================================ one plan, read + review */
/** One line of the activity feed, in the words a person would use. */
function activityText(c: any) {
  switch (c.kind) {
    case 'submitted': return c.body ? 'resubmitted the plan with changes' : 'submitted the plan';
    case 'approved': return 'approved the plan';
    case 'changes_requested': return 'asked for changes';
    case 'task_done': return <>marked <span className="text-ink font-medium">“{c.body}”</span> as complete</>;
    case 'task_reopened': return <>reopened <span className="text-ink font-medium">“{c.body}”</span></>;
    case 'check_done': return <>checked off <span className="text-ink font-medium">“{c.body}”</span></>;
    case 'check_reopened': return <>unchecked <span className="text-ink font-medium">“{c.body}”</span></>;
    case 'task_added': return <>added <span className="text-ink font-medium">“{c.body}”</span></>;
    case 'converted': return <>turned {c.body}</>;
    case 'carried_over': return <>carried over unfinished <span className="text-ink font-medium">“{c.body}”</span> from the day before</>;
    case 'moved_on': {
      const [task, day] = String(c.body || '').split(' → ');
      return <>moved unfinished <span className="text-ink font-medium">“{task}”</span> to {day}</>;
    }
    default: return null;
  }
}

/**
 * A plan opened like a card: the plan on the left, and the conversation with
 * the reporting person on the right - comments and every step it went
 * through, newest first.
 */
function PlanModal({ id, onClose, onEdit, startAdding = false }: {
  id: string; onClose: () => void; onEdit: () => void; startAdding?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const key = ['todo-plan', 'submission', id];
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [writing, setWriting] = useState(false);

  const { data: plan, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/todo-plan/submissions/${id}`).then((r) => r.data) });

  // The reporting person opening a fresh plan marks it under review.
  const opened = useRef(false);
  useEffect(() => {
    if (!plan || opened.current || !plan.can_review || !['SUBMITTED', 'LATE'].includes(plan.status)) return;
    opened.current = true;
    api.post(`/todo-plan/submissions/${id}/open`).then((r) => {
      qc.setQueryData(key, r.data);
      qc.invalidateQueries({ queryKey: ['todo-plan', 'team'] });
    }).catch(() => {});
  }, [plan]);

  const done = (r: any, msg?: string) => {
    qc.setQueryData(key, r.data);
    qc.invalidateQueries({ queryKey: ['todo-plan', 'team'] });
    qc.invalidateQueries({ queryKey: ['todo-plan', 'mine'] });
    if (msg) toast.success(msg);
  };
  const approve = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${id}/approve`, { note: note || undefined }),
    onSuccess: (r: any) => {
      // Approval also turns the plan's tasks into action items.
      const c = r.data.conversion_result;
      const n = c?.created?.length || 0;
      done(r, n ? `Approved. ${n} action item${n === 1 ? '' : 's'} created.` : 'Approved.');
      if (c?.error) toast.error(`Approved, but no action items were created: ${c.error}`);
      if (n) qc.invalidateQueries({ queryKey: ['action-items'] });
      setNote('');
    },
    onError: (e: any) => toast.error(e.message),
  });
  const changes = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${id}/request-changes`, { note }),
    onSuccess: (r) => { done(r, 'Sent back for changes.'); setNote(''); setAsking(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const comment = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${id}/comments`, { body: commentText }),
    onSuccess: (r) => { done(r); setCommentText(''); setWriting(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const tick = useMutation({
    mutationFn: ({ taskId, value }: { taskId: string; value: boolean }) =>
      api.post(`/todo-plan/submissions/${id}/tasks/${taskId}`, { done: value }),
    onSuccess: (r) => done(r),
    onError: (e: any) => toast.error(e.message),
  });

  const check = useMutation({
    mutationFn: ({ taskId, index, value }: { taskId: string; index: number; value: boolean }) =>
      api.post(`/todo-plan/submissions/${id}/tasks/${taskId}/checklist/${index}`, { done: value }),
    onSuccess: (r) => done(r),
    onError: (e: any) => toast.error(e.message),
  });

  // The last run's outcome, so what was skipped or failed stays on screen after the toast.
  const [outcome, setOutcome] = useState<any>(null);
  const convert = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${id}/action-items`),
    onSuccess: (r: any) => {
      const { created, already_converted: already, skipped, failed, plan: next } = r.data;
      qc.setQueryData(key, next);
      qc.invalidateQueries({ queryKey: ['todo-plan', 'mine'] });
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['home-counters'] });
      setOutcome(r.data);
      const n = created.length;
      if (n) toast.success(`${n} action item${n === 1 ? '' : 's'} created.`);
      else if (already.length && !skipped.length && !failed.length) toast.success('Every task is already an action item.');
      if (failed.length) toast.error(`${failed.length} task${failed.length === 1 ? '' : 's'} could not be converted.`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const reviewable = plan?.can_review && ['SUBMITTED', 'LATE', 'UNDER_REVIEW'].includes(plan.status);
  const own = plan && plan.user_id === user?.id;
  const [adding, setAdding] = useState(startAdding);
  const canTick = !!plan?.can_tick;
  // A task that moved to the next day no longer counts here.
  const live = (plan?.tasks || []).filter((t: any) => !t.carried_to_date);
  const doneCount = live.filter(taskDone).length;
  const feed = [...(plan?.comments || [])].reverse();

  return (
    <Modal open onClose={onClose} size="xl"
      title={plan ? `${own ? 'My' : `${plan.employee_name}'s`} plan · ${date(plan.todo_date, 'long')}` : 'Advance Planner'}
      subtitle={plan ? `${plan.employee_name} → ${plan.reporting_person_name || 'Owner'}` : undefined}
      footer={plan && (
        <>
          {own && plan.can_edit && <Button onClick={onEdit}>Edit plan</Button>}
          {reviewable && !asking && (
            <>
              <Button icon={<Undo2 size={15} />} onClick={() => setAsking(true)}>Request changes</Button>
              <Button variant="primary" icon={<CheckCircle2 size={15} />} loading={approve.isPending} onClick={() => approve.mutate()}>Approve</Button>
            </>
          )}
          {reviewable && asking && (
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>Back</Button>
              <Button variant="primary" loading={changes.isPending} disabled={!note.trim()} onClick={() => changes.mutate()}>Send back for changes</Button>
            </>
          )}
          {!reviewable && !(own && plan.can_edit) && <Button onClick={onClose}>Close</Button>}
        </>
      )}>
      {error ? (
        <EmptyState compact icon={<AlertTriangle size={18} />} title="Not available" message="This plan does not exist or is not yours to see." />
      ) : isLoading || !plan ? <Skeleton className="h-64" /> : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
          {/* ------------------------------------------------ the plan */}
          <section className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <PlanStatus status={plan.status} />
              {plan.submitted_at && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-muted">
                  <Clock size={13} /> Submitted {dateTime(plan.submitted_at)}
                </span>
              )}
              {plan.minutes_late ? (
                <span className="rounded-md border border-[var(--warning)]/40 bg-warning-soft px-2 py-1 text-ink">{plan.minutes_late} min late</span>
              ) : null}
              {plan.status === 'APPROVED' && plan.reviewed_by_name && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-muted">
                  <CheckCircle2 size={13} className="text-[var(--positive)]" /> Approved by {plan.reviewed_by_name}
                </span>
              )}
            </div>

            {plan.conversion?.total > 0 && (
              <ConversionPanel planId={plan.id} c={plan.conversion} outcome={outcome}
                busy={convert.isPending} onConvert={() => convert.mutate()} />
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink"><ClipboardList size={16} /> Tasks</h3>
                <span className="flex items-center gap-3">
                  {live.length > 0 && <span className="text-[12px] text-subtle tabular">{doneCount}/{live.length} done</span>}
                  {plan.can_add_task && !adding && (
                    <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add task</Button>
                  )}
                </span>
              </div>
              {live.length > 0 && (
                <div className="h-1.5 rounded-full bg-sunken overflow-hidden mb-3" aria-hidden>
                  <div className="h-full bg-[var(--positive)] transition-all duration-300"
                    style={{ width: `${Math.round((doneCount / live.length) * 100)}%` }} />
                </div>
              )}
              {adding && plan.can_add_task && (
                <AddTaskForm planId={plan.id} todoDate={plan.todo_date} options={plan.options || { projects: [], clients: [] }}
                  onCancel={() => setAdding(false)}
                  onAdded={(r) => { done(r, 'Task added.'); setAdding(false); }} />
              )}
              {plan.tasks.length === 0 ? (
                <p className="text-[13px] text-subtle">No tasks yet.</p>
              ) : (
                <ul className="space-y-2">
                  {plan.tasks.map((t: any) => {
                    const isDone = taskDone(t);
                    const movedOn = !!t.carried_to_date;
                    // Converted work is tracked on its action item; the planner only reads it back.
                    const item = t.action_item;
                    const canTickThis = canTick && !item;
                    return (
                      <li key={t.id} className={cx('flex gap-3 rounded-lg border border-line bg-raised px-3.5 py-3', movedOn && 'opacity-60')}>
                        <button type="button" disabled={!canTickThis || movedOn || tick.isPending}
                          onClick={() => tick.mutate({ taskId: t.id, value: !isDone })}
                          aria-label={isDone ? `Reopen “${t.task}”` : `Mark “${t.task}” complete`}
                          title={item ? 'Tracked in Action Items' : canTick ? (isDone ? 'Reopen' : 'Mark complete') : undefined}
                          className={cx('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors duration-150',
                            isDone ? 'border-[var(--positive)] bg-[var(--positive)] text-white' : 'border-line-strong',
                            canTickThis ? 'cursor-pointer hover:border-[var(--positive)]' : 'cursor-default')}>
                          {isDone && <Check size={13} strokeWidth={3.5} className="text-white" />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className={cx('flex items-center gap-2 text-[14px] font-medium', isDone ? 'text-subtle line-through' : 'text-ink')}>
                            <PriorityDot p={t.priority} /> {t.task}
                          </p>
                          <p className="text-[12.5px] text-subtle mt-0.5">
                            {[PRIORITY[t.priority]?.label, t.project_name, t.client_name, t.expected_time && `by ${clockTime(t.expected_time)}`].filter(Boolean).join(' · ')}
                          </p>
                          {item && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              {item.deleted ? (
                                <span className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-muted">Action item deleted</span>
                              ) : (
                                <>
                                  <StatusBadge status={item.status} />
                                  {item.validation_status && <ItemValidation v={item.validation_status} status={item.status} />}
                                  <Link to={`/action-items?open=${item.id}`}
                                    className="inline-flex items-center gap-0.5 text-[12px] font-medium text-[var(--brand)] hover:underline">
                                    Open action item <ArrowUpRight size={12} />
                                  </Link>
                                </>
                              )}
                            </div>
                          )}
                          {!item && !movedOn && t.conversion_block && !plan.conversion?.problem && (
                            <p className="text-[12px] text-subtle mt-1">Not converted · {t.conversion_block}</p>
                          )}
                          {(t.carried_from_date || t.added_at || movedOn) && (
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              {t.carried_from_date && (
                                <span className="rounded border border-[var(--warning)]/40 bg-warning-soft px-1.5 py-0.5 text-[11.5px] text-ink">
                                  Carried over from {date(t.carried_from_date, 'day')}
                                </span>
                              )}
                              {t.added_at && t.added_by_name && (
                                <span className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-muted">
                                  Added by {t.added_by_name} · {dateTime(t.added_at)}
                                </span>
                              )}
                              {movedOn && (
                                <span className="rounded border border-line px-1.5 py-0.5 text-[11.5px] text-muted">
                                  Not finished · moved to {date(t.carried_to_date, 'day')}
                                </span>
                              )}
                            </div>
                          )}
                          {t.notes && <p className="text-[13px] text-muted mt-1.5 whitespace-pre-line">{t.notes}</p>}
                          {t.checklist?.length > 0 && (
                            <ChecklistView items={t.checklist} canTick={canTickThis && !movedOn} busy={check.isPending}
                              onTick={(index, value) => check.mutate({ taskId: t.id, index, value })} />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {reviewable && asking && (
              <Field label="What needs to change?" required>
                <Textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Please add the expected number of leads to be completed." />
              </Field>
            )}
          </section>

          {/* ------------------------------------------- comments and activity */}
          <aside className="rounded-lg bg-sunken p-3.5 md:max-h-[62vh] md:overflow-y-auto">
            <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink mb-3">
              <MessageSquare size={16} /> Comments and activity
            </h3>

            <div className="mb-4">
              {writing || commentText ? (
                <div className="space-y-2">
                  <Textarea rows={3} autoFocus value={commentText} maxLength={2000} placeholder="Write a comment…"
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && commentText.trim()) comment.mutate(); }} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" icon={<Send size={13} />} loading={comment.isPending}
                      disabled={!commentText.trim()} onClick={() => comment.mutate()}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setCommentText(''); setWriting(false); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setWriting(true)}
                  className="w-full rounded-md border border-line bg-raised px-3 py-2 text-left text-[13px] text-subtle hover:border-line-strong cursor-text">
                  Write a comment…
                </button>
              )}
            </div>

            {feed.length === 0 ? (
              <p className="text-[12.5px] text-subtle">Nothing yet.</p>
            ) : (
              <ul className="space-y-3.5">
                {feed.map((c: any) => {
                  const action = activityText(c);
                  const bubble = c.kind === 'comment' || (['approved', 'changes_requested'].includes(c.kind) && c.body);
                  return (
                    <li key={c.id} className="flex gap-2.5">
                      <Avatar name={c.user_name || 'System'} size={28} />
                      <div className="min-w-0 flex-1 text-[13px] leading-snug">
                        <p className="text-muted">
                          <span className="font-semibold text-ink">{c.user_name || 'System'}</span>
                          {action && <> {action}</>}
                        </p>
                        {bubble && (
                          <p className={cx('mt-1 rounded-md border bg-raised px-2.5 py-1.5 text-ink whitespace-pre-line break-words',
                            c.kind === 'changes_requested' ? 'border-[var(--warning)]/50' : 'border-line')}>
                            {c.body}
                          </p>
                        )}
                        <p className="mt-0.5 text-[11.5px] text-[var(--brand)]">{dateTime(c.created_at)}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      )}
    </Modal>
  );
}

/* ================================================================ today and adding */
/** The plan being worked today, on top of the employee card: progress, open it, add to it. */
function TodayStrip({ plan, onView }: { plan: any; onView: (id: string, add?: boolean) => void }) {
  const live = plan.tasks.filter((t: any) => !t.carried_to_date);
  const doneCount = live.filter(taskDone).length;
  const carried = live.filter((t: any) => t.carried_from_date).length;
  return (
    <div className="border-b border-line bg-sunken/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-[13px] font-semibold text-ink">Today · {date(plan.todo_date, 'day')}</p>
        <PlanStatus status={plan.status} />
        <span className="text-[12.5px] text-subtle tabular">{doneCount}/{live.length} done</span>
        {carried > 0 && <span className="text-[12px] text-[var(--warning)]">{carried} carried over</span>}
      </div>
      {live.length > 0 && (
        <div className="h-1 rounded-full bg-[var(--border)] overflow-hidden mt-2" aria-hidden>
          <div className="h-full bg-[var(--positive)]" style={{ width: `${Math.round((doneCount / live.length) * 100)}%` }} />
        </div>
      )}
      <div className="flex flex-wrap gap-2 mt-2.5">
        <Button size="sm" onClick={() => onView(plan.id)}>Open today's plan</Button>
        {plan.can_add_task && <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onView(plan.id, true)}>Add task</Button>}
      </div>
    </div>
  );
}

/** One more task on a plan already filed. Saved straight away: no re-approval. */
function AddTaskForm({ planId, todoDate, options, onAdded, onCancel }: {
  planId: string; todoDate: string; options: { projects: any[]; clients: any[] }; onAdded: (r: any) => void; onCancel: () => void;
}) {
  const toast = useToast();
  const [row, setRow] = useState<TaskRow>(blank());
  const set = (k: keyof TaskRow, v: string) => setRow((r) => ({ ...r, [k]: v }));
  const add = useMutation({
    mutationFn: () => api.post(`/todo-plan/submissions/${planId}/tasks`, {
      task: row.task, priority: row.priority, project_id: row.project_id || null, client_id: row.client_id || null,
      expected_time: row.expected_time || null, notes: row.notes, checklist: row.checklist.map(({ key: _k, ...c }) => c),
    }),
    onSuccess: onAdded,
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <div className="rounded-lg border border-[var(--brand)]/40 bg-raised p-3.5 mb-3 space-y-3">
      <TaskFields row={row} set={set} options={options} autoFocus todoDate={todoDate} />
      <ChecklistEditor items={row.checklist} onChange={(fn) => setRow((r) => ({ ...r, checklist: fn(r.checklist) }))} />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" icon={<Plus size={14} />} loading={add.isPending} disabled={!row.task.trim()}
          onClick={() => add.mutate()}>Add to plan</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <span className="self-center text-[12px] text-subtle">Added straight away, no approval needed.</span>
      </div>
    </div>
  );
}

/* ================================================================ checklists */
/** The checklist under a task in the form: type a step, Enter adds the next one. */
function ChecklistEditor({ items, onChange }: { items: CheckItem[]; onChange: (fn: (list: CheckItem[]) => CheckItem[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const text = draft.trim();
    if (!text || items.length >= 20) return;
    onChange((list) => [...list, { key: newKey(), text, done: false }]);
    setDraft('');
  };
  return (
    <div>
      <p className="flex items-center justify-between text-[12.5px] font-medium text-ink mb-1.5">
        <span className="flex items-center gap-1.5"><ListChecks size={14} /> Checklist</span>
        {items.length > 0 && <span className="text-subtle font-normal tabular">{items.length}/20</span>}
      </p>
      {items.length > 0 && (
        <ul className="space-y-1.5 mb-2">
          {items.map((c) => (
            <li key={c.key} className="flex items-center gap-2">
              <span className={cx('grid h-4 w-4 shrink-0 place-items-center rounded border',
                c.done ? 'border-[var(--positive)] bg-[var(--positive)] text-white' : 'border-line-strong')} aria-hidden>
                {c.done && <Check size={11} strokeWidth={3.5} />}
              </span>
              <Input value={c.text} maxLength={200} aria-label="Checklist item" className="h-8 text-[13px]"
                onChange={(e) => onChange((list) => list.map((x) => (x.key === c.key ? { ...x, text: e.target.value } : x)))} />
              <button type="button" onClick={() => onChange((list) => list.filter((x) => x.key !== c.key))}
                className="text-subtle hover:text-[var(--negative)] cursor-pointer shrink-0" aria-label={`Remove “${c.text}”`}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length < 20 && (
        <div className="flex gap-2">
          <Input value={draft} maxLength={200} placeholder="Add a checklist item…" className="h-8 text-[13px]"
            aria-label="New checklist item"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <Button size="sm" icon={<Plus size={14} />} disabled={!draft.trim()} onClick={add}>Add</Button>
        </div>
      )}
    </div>
  );
}

/** The checklist under a task in the card view; the person who planned it ticks items off. */
function ChecklistView({ items, canTick, busy, onTick }: {
  items: { text: string; done: boolean }[]; canTick: boolean; busy: boolean; onTick: (index: number, value: boolean) => void;
}) {
  const doneCount = items.filter((c) => c.done).length;
  return (
    <div className="mt-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[12px] text-subtle tabular">{doneCount}/{items.length}</span>
        <div className="h-1 flex-1 rounded-full bg-sunken overflow-hidden" aria-hidden>
          <div className="h-full bg-[var(--positive)] transition-all duration-300" style={{ width: `${Math.round((doneCount / items.length) * 100)}%` }} />
        </div>
      </div>
      <ul className="space-y-1">
        {items.map((c, i) => (
          <li key={i}>
            <label className={cx('flex items-start gap-2 text-[13px]', canTick ? 'cursor-pointer' : 'cursor-default')}>
              <input type="checkbox" checked={c.done} disabled={!canTick || busy} onChange={(e) => onTick(i, e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-line-strong accent-[var(--positive)] cursor-pointer disabled:cursor-default" />
              <span className={c.done ? 'text-subtle line-through' : 'text-ink'}>{c.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ================================================================ reviewer card */
function TeamPlanCard({ initial, onView, className }: { initial: any; onView: (id: string) => void; className?: string }) {
  const [day, setDay] = useState<string>(initial.todo_date);
  const [all, setAll] = useState(false); // "My team" first; "Everyone" for those allowed it
  const { data = initial } = useQuery({
    queryKey: ['todo-plan', 'team', day, all],
    queryFn: () => api.get('/todo-plan/team', { date: day, ...(all ? { scope: 'all' } : {}) }).then((r) => r.data),
    initialData: day === initial.todo_date && !all ? initial : undefined,
    placeholderData: (prev: any) => prev,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const reporting = useMutation({
    mutationFn: ({ userId, managerId }: { userId: string; managerId: string | null }) =>
      api.put(`/todo-plan/reporting/${userId}`, { manager_id: managerId }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['todo-plan', 'team'] });
      toast.success(r.data.manager_name ? `Now reports to ${r.data.manager_name}.` : 'Now reports to the owner.');
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Reporting to an owner and reporting to nobody route the same way, so both read "Owner (direct)".
  const ownerIds = new Set<string>((data.reporting_options || []).filter((o: any) => o.role === 'owner').map((o: any) => o.id));

  const c = data.counts;
  const submitted = c.SUBMITTED + c.LATE + c.UNDER_REVIEW + c.APPROVED + c.CHANGES_REQUESTED;
  // Lateness outlives the LATE status: a late plan that has since been reviewed still counts.
  const late = data.rows.filter((r: any) => r.plan?.minutes_late > 0).length;
  const toReview = c.SUBMITTED + c.LATE + c.UNDER_REVIEW;

  return (
    <Card className={className}>
      <CardHeader title={data.scope === 'everyone' ? 'Team Advance Planner · everyone' : data.is_admin ? 'Team Advance Planner · reporting to you' : 'Team Advance Planner'}
        icon={<Users2 size={16} />}
        subtitle={`Plans for ${date(data.todo_date, 'long')} · deadline ${clockTime(data.deadline_time)}`}
        action={(
          <span className="flex items-center gap-2">
            {data.can_see_all && (
              <span className="inline-flex rounded-md border border-line-strong p-0.5 text-[12.5px]" role="group" aria-label="Whose plans">
                {[[false, 'My team'], [true, 'Everyone']].map(([v, label]) => (
                  <button key={String(v)} type="button" aria-pressed={all === v} onClick={() => setAll(v as boolean)}
                    className={cx('rounded px-2.5 py-1 whitespace-nowrap cursor-pointer transition-colors duration-150',
                      all === v ? 'bg-brand-soft text-ink font-medium' : 'text-muted hover:text-ink')}>
                    {label as string}
                  </button>
                ))}
              </span>
            )}
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value || initial.todo_date)}
              aria-label="Planned day" className="h-8 w-[150px] text-[13px]" />
          </span>
        )} />

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-[var(--border)] border-b border-line">
        {[
          ['People', c.total, ''],
          ['Submitted', submitted, ''],
          ['Approved', c.APPROVED, 'text-[var(--positive)]'],
          ['To review', toReview, toReview ? 'text-[var(--brand)]' : ''],
          ['Late', late, late ? 'text-[var(--warning)]' : ''],
          ['Not in', c.not_submitted, c.not_submitted ? 'text-[var(--negative)]' : ''],
        ].map(([label, n, tone]) => (
          <div key={label as string} className="bg-raised px-3 py-2.5">
            <p className="text-[11.5px] text-subtle">{label}</p>
            <p className={cx('text-[18px] font-semibold tabular text-ink', tone as string)}>{n}</p>
          </div>
        ))}
      </div>

      {data.pending.length > 0 && (
        <div className="border-b border-line">
          <p className="px-4 pt-3 pb-1.5 text-[12.5px] font-semibold text-subtle">Waiting on your review</p>
          <ul>
            {data.pending.map((p: any) => (
              <li key={p.id}>
                <button onClick={() => onView(p.id)} className="w-full flex items-center gap-3 px-4 py-2 row-hover cursor-pointer text-left">
                  <span className="min-w-0 flex-1 text-[13.5px] text-ink font-medium truncate">{p.employee_name}</span>
                  <span className="text-[12.5px] text-subtle">{date(p.todo_date, 'day')} · {time(p.submitted_at)}{p.minutes_late ? ` · ${p.minutes_late}m late` : ''}</span>
                  <PlanStatus status={p.status} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.can_assign && (
        <div className="px-4 py-3 border-b border-line bg-brand-soft/30">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink"><Plus size={14} /> Build your team</span>
            {data.assignable.length > 0 ? (
              <Select value="" disabled={reporting.isPending} aria-label="Add someone to my team"
                onChange={(e) => e.target.value && reporting.mutate({ userId: e.target.value, managerId: user!.id })}
                className="h-8 w-auto min-w-[220px] text-[13px]">
                <option value="">Add a person to my team…</option>
                {data.assignable.map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.designation ? ` · ${u.designation}` : ''}</option>)}
              </Select>
            ) : null}
          </div>
          <p className="text-[12px] text-subtle mt-1.5">
            {data.assignable.length > 0
              ? 'Lists people who are not on anyone\'s team yet. Someone on another manager\'s team can only be moved by the owner.'
              : 'Everyone already has a manager. Ask the owner to move someone to your team.'}
          </p>
        </div>
      )}

      {data.rows.length === 0 ? (
        <EmptyState compact title="Nobody reports to you"
          message={data.can_assign ? 'Add people who are not on anyone\'s team yet.' : 'The owner decides who reports to whom.'} />
      ) : (
        <ul className="divide-y divide-[var(--border)] max-h-[360px] overflow-y-auto">
          {data.rows.map((r: any) => (
            <li key={r.user.id} className={cx('flex items-center gap-3 px-4 py-2', r.plan && 'row-hover')}>
              <button disabled={!r.plan} onClick={() => r.plan && onView(r.plan.id)}
                className={cx('min-w-0 flex-1 flex items-center gap-3 text-left', r.plan ? 'cursor-pointer' : 'cursor-default')}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] text-ink truncate">{r.user.name}</span>
                  {!data.is_admin && data.scope === 'everyone' && (
                    <span className="block text-[11.5px] text-subtle truncate">reports to {r.reporting_person_name || '—'}</span>
                  )}
                </span>
                {r.plan?.submitted_at && <span className="hidden sm:inline text-[12px] text-subtle">{time(r.plan.submitted_at)} · {r.plan.task_count} task(s)</span>}
              </button>
              {data.is_admin && (
                <Select value={r.manager_id && !ownerIds.has(r.manager_id) ? r.manager_id : ''} disabled={reporting.isPending} aria-label={`${r.user.name} reports to`}
                  onChange={(e) => reporting.mutate({ userId: r.user.id, managerId: e.target.value || null })}
                  className="h-8 w-[170px] shrink-0 text-[12.5px]">
                  <option value="">Owner (direct)</option>
                  {data.reporting_options.filter((o: any) => o.id !== r.user.id && o.role !== 'owner')
                    .map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              )}
              <PlanStatus status={r.plan?.status === 'DRAFT' ? null : r.plan?.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
