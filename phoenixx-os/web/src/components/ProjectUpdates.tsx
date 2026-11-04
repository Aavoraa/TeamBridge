import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarDays, CheckCircle2, CircleSlash, ClipboardList, Crown, PencilLine, Send, ShieldAlert,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, relative, titleCase } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Meter, Modal,
  Select, TableSkeleton, Textarea, useToast, cx,
} from './ui';

/**
 * The daily project update - filed by each project's manager and lead, read
 * by its owners. The form mirrors the owner's standard template field for
 * field; the feed puts what the filer says (status, self-reported progress)
 * beside what the tasks say, because neither alone is the whole picture.
 */

export const UPDATE_STATUS: Record<string, { label: string; tone: any; icon: any }> = {
  on_track: { label: 'On track', tone: 'positive', icon: CheckCircle2 },
  at_risk: { label: 'At risk', tone: 'warning', icon: AlertTriangle },
  blocked: { label: 'Blocked', tone: 'negative', icon: ShieldAlert },
};
/** Spelled out in full so Tailwind can see every class at build time. */
const STATUS_PICK: Record<string, string> = {
  on_track: 'border-[var(--positive)] bg-positive-soft text-[var(--positive)]',
  at_risk: 'border-[var(--warning)] bg-warning-soft text-[var(--warning)]',
  blocked: 'border-[var(--negative)] bg-negative-soft text-[var(--negative)]',
};
const TONE_TEXT: Record<string, string> = {
  positive: 'text-[var(--positive)]', warning: 'text-[var(--warning)]', negative: 'text-[var(--negative)]',
};
const BLOCKER_TYPES = ['technical', 'client', 'resource', 'dependency', 'other'];
const SEAT_LABEL: Record<string, string> = { manager: 'Project manager', lead: 'Team lead' };

/** Workspace roles that may own a project - mirrors OWNER_ROLES on the server. */
export const OWNER_ROLES = ['owner', 'manager'];

export function UpdateStatusBadge({ status }: { status?: string | null }) {
  if (!status) return <Badge tone="neutral">No update</Badge>;
  const ui = UPDATE_STATUS[status];
  const Icon = ui.icon;
  return (
    <Badge tone={ui.tone}>
      <Icon size={11} className="mr-0.5 inline-block -mt-px" aria-hidden />
      {ui.label}
    </Badge>
  );
}

const invalidateUpdates = (qc: ReturnType<typeof useQueryClient>, projectId?: string) => {
  qc.invalidateQueries({ queryKey: ['project-updates-feed'] });
  qc.invalidateQueries({ queryKey: ['project-updates-to-file'] });
  if (projectId) qc.invalidateQueries({ queryKey: ['project-updates', projectId] });
};

/* =============================================================== FORM */
export function ProjectUpdateModal({ project, existing, previous, onClose }: {
  project: { id: string; name: string; client_name?: string; seat?: string };
  existing?: any; previous?: any; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(() => ({
    // A fresh day starts from yesterday's plan - that is usually today's work.
    todays_work: existing?.todays_work ?? previous?.tomorrow_plan ?? '',
    completed_today: existing?.completed_today ?? '',
    tomorrow_plan: existing?.tomorrow_plan ?? '',
    progress_pct: String(existing?.progress_pct ?? previous?.progress_pct ?? ''),
    has_blocker: !!existing?.has_blocker,
    blocker_type: existing?.blocker_type ?? '',
    blocker_description: existing?.blocker_description ?? '',
    help_required: existing?.help_required ?? '',
    estimated_delay_days: String(existing?.estimated_delay_days ?? ''),
    status: existing?.status ?? 'on_track',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: string, v: any) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  const save = useMutation({
    mutationFn: () => api.post(`/projects/${project.id}/updates`, {
      todays_work: form.todays_work.trim() || null,
      completed_today: form.completed_today.trim() || null,
      tomorrow_plan: form.tomorrow_plan.trim() || null,
      progress_pct: form.progress_pct === '' ? null : Math.max(0, Math.min(100, Number(form.progress_pct))),
      has_blocker: form.has_blocker,
      blocker_type: form.has_blocker ? form.blocker_type || null : null,
      blocker_description: form.has_blocker ? form.blocker_description.trim() || null : null,
      help_required: form.has_blocker ? form.help_required.trim() || null : null,
      estimated_delay_days: form.has_blocker && form.estimated_delay_days !== '' ? Number(form.estimated_delay_days) : null,
      status: form.status,
    }),
    onSuccess: () => {
      toast.success(existing ? 'Update saved. Owners already have it.' : 'Update filed. The project owners have been told.');
      invalidateUpdates(qc, project.id);
      onClose();
    },
    onError: (e: any) => { setErrors(e.fieldErrors || {}); toast.error(e.message); },
  });

  const said = form.todays_work.trim() || form.completed_today.trim();
  const blockerOk = !form.has_blocker || (form.blocker_type && form.blocker_description.trim());
  const blockedOk = form.status !== 'blocked' || form.has_blocker;

  return (
    <Modal open onClose={onClose} size="lg"
      title={existing ? "Edit today's project update" : 'Daily project update'}
      subtitle={`${project.name}${project.client_name ? ` · ${project.client_name}` : ''}${project.seat ? ` · you file as ${SEAT_LABEL[project.seat] || project.seat}` : ''}`}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send size={15} />} loading={save.isPending}
            disabled={!said || !blockerOk || !blockedOk} onClick={() => save.mutate()}>
            {existing ? 'Save update' : 'Submit update'}
          </Button>
        </>
      )}>
      <div className="space-y-4">
        {existing && (
          <p className="rounded-md border border-line bg-sunken px-3 py-2 text-[12.5px] text-subtle">
            You filed this {relative(existing.updated_at)}. Saving again updates the same entry.
          </p>
        )}

        <Field label="Status" required>
          <div className="grid grid-cols-3 gap-2">
            {Object.entries(UPDATE_STATUS).map(([id, ui]) => {
              const Icon = ui.icon;
              const on = form.status === id;
              return (
                <button key={id} type="button" onClick={() => set('status', id)}
                  className={cx('flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors cursor-pointer',
                    on ? STATUS_PICK[id] : 'border-line text-muted hover:border-line-strong')}
                  aria-pressed={on}>
                  <Icon size={14} aria-hidden /> {ui.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Today's work" required={!form.completed_today.trim()} error={errors.todays_work}>
          <Textarea rows={2} value={form.todays_work} onChange={(e) => set('todays_work', e.target.value)}
            placeholder="Backend API integration" />
        </Field>
        <Field label="Completed today">
          <Textarea rows={2} value={form.completed_today} onChange={(e) => set('completed_today', e.target.value)}
            placeholder="API authentication completed" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label="Tomorrow's plan">
            <Textarea rows={2} value={form.tomorrow_plan} onChange={(e) => set('tomorrow_plan', e.target.value)}
              placeholder="Frontend API integration" />
          </Field>
          <Field label="Progress" hint="Your estimate for the whole project">
            <div className="flex items-center gap-2">
              <Input type="number" min={0} max={100} step={5} value={form.progress_pct}
                onChange={(e) => set('progress_pct', e.target.value)} placeholder="75" />
              <span className="text-[13px] text-subtle">%</span>
            </div>
          </Field>
        </div>

        <div className={cx('rounded-lg border p-3 space-y-3',
          form.has_blocker ? 'border-[color-mix(in_srgb,var(--negative)_40%,transparent)]' : 'border-line')}>
          <Checkbox label="There is a blocker" checked={form.has_blocker} onChange={(v) => set('has_blocker', v)} />
          {form.has_blocker && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Blocker type" required>
                <Select value={form.blocker_type} onChange={(e) => set('blocker_type', e.target.value)}>
                  <option value="">Choose…</option>
                  {BLOCKER_TYPES.map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}
                </Select>
              </Field>
              <Field label="Estimated delay (days)">
                <Input type="number" min={0} max={365} value={form.estimated_delay_days}
                  onChange={(e) => set('estimated_delay_days', e.target.value)} placeholder="1" />
              </Field>
              <Field label="Blocker description" required error={errors.blocker_description} className="sm:col-span-2">
                <Textarea rows={2} value={form.blocker_description} onChange={(e) => set('blocker_description', e.target.value)}
                  placeholder="API response format mismatch" />
              </Field>
              <Field label="Help required" hint="What you need, and from whom" className="sm:col-span-2">
                <Textarea rows={2} value={form.help_required} onChange={(e) => set('help_required', e.target.value)}
                  placeholder="Need backend developer review" />
              </Field>
            </div>
          )}
          {!blockedOk && (
            <p className="text-[12px] text-[var(--negative)]">A blocked project needs the blocker described.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ============================================================ READ VIEW */
function UpdateBody({ u }: { u: any }) {
  const rows: [string, string | null | undefined][] = [
    ["Today's work", u.todays_work],
    ['Completed today', u.completed_today],
    ["Tomorrow's plan", u.tomorrow_plan],
  ];
  return (
    <div className="space-y-1.5">
      <dl className="space-y-1">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[120px_1fr] gap-2 max-sm:grid-cols-1 max-sm:gap-0">
            <dt className="text-[12px] text-subtle">{k}</dt>
            <dd className="text-[13px] text-ink whitespace-pre-line">{v}</dd>
          </div>
        ))}
      </dl>
      {u.has_blocker && (
        <div className="rounded-md bg-negative-soft px-2.5 py-2 text-[12.5px]">
          <p className="font-medium text-[var(--negative)]">
            Blocker{u.blocker_type ? ` · ${titleCase(u.blocker_type)}` : ''}
            {u.estimated_delay_days != null && ` · ~${u.estimated_delay_days} day${u.estimated_delay_days === 1 ? '' : 's'} delay`}
          </p>
          <p className="text-ink">{u.blocker_description}</p>
          {u.help_required && <p className="mt-0.5 text-muted"><span className="font-medium">Help needed:</span> {u.help_required}</p>}
        </div>
      )}
    </div>
  );
}

/** One filed update, with who filed it and when. */
export function ProjectUpdateCard({ update: u, showDate }: { update: any; showDate?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-raised p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Avatar name={u.user_name} url={u.avatar_url} size={22} />
        <span className="text-[13px] font-medium text-ink">{u.user_name}</span>
        {u.seat && <span className="text-[11.5px] text-subtle">{SEAT_LABEL[u.seat] || u.seat}</span>}
        <UpdateStatusBadge status={u.status} />
        {u.progress_pct != null && <Badge tone="neutral">{u.progress_pct}%</Badge>}
        <span className="ml-auto text-[11.5px] text-subtle">
          {showDate ? date(u.update_date) : relative(u.updated_at)}
        </span>
      </div>
      <UpdateBody u={u} />
    </div>
  );
}

/** Self-reported progress beside task completion - the two numbers an owner compares. */
function ProgressPair({ reported, tasks }: { reported: number | null; tasks: any }) {
  const gap = reported != null && tasks?.pct != null ? reported - tasks.pct : null;
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <p className="label-cap">Reported</p>
        <div className="mt-1 flex items-center gap-2">
          <Meter value={reported ?? 0} className="flex-1" tone="brand" />
          <span className="text-[12.5px] tabular text-ink w-9 text-right">{reported != null ? `${reported}%` : '—'}</span>
        </div>
      </div>
      <div>
        <p className="label-cap" title="Share of this project's tasks marked done">Tasks done</p>
        <div className="mt-1 flex items-center gap-2">
          <Meter value={tasks?.pct ?? 0} className="flex-1" tone={gap != null && gap > 25 ? 'warning' : 'positive'} />
          <span className="text-[12.5px] tabular text-ink w-9 text-right">{tasks?.pct != null ? `${tasks.pct}%` : '—'}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-subtle tabular">
          {tasks?.total ? `${tasks.done}/${tasks.total} tasks` : 'No tasks linked'}
          {tasks?.overdue ? <span className="text-[var(--negative)]"> · {tasks.overdue} overdue</span> : null}
          {tasks?.blocked ? <span className="text-[var(--negative)]"> · {tasks.blocked} blocked</span> : null}
        </p>
      </div>
      {gap != null && gap > 25 && (
        <p className="col-span-2 text-[11.5px] text-[var(--warning)]">
          Reported progress is {gap} points ahead of the tasks - worth a question.
        </p>
      )}
    </div>
  );
}

/* ================================================================ TAB */
export function ProjectUpdatesTab({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const { user } = useAuth();
  const [day, setDay] = useState('');
  const [mineOnly, setMineOnly] = useState(user?.role !== 'owner');
  const [filing, setFiling] = useState<any>(null);

  const toFile = useQuery({
    queryKey: ['project-updates-to-file'],
    queryFn: () => api.get('/projects/updates/to-file').then((r) => r.data),
  });
  const feed = useQuery({
    queryKey: ['project-updates-feed', day, mineOnly],
    queryFn: () => api.get('/projects/updates/feed', { ...(day ? { date: day } : {}), ...(mineOnly ? { mine: 'true' } : {}) })
      .then((r) => r.data),
  });

  const pending = toFile.data?.projects ?? [];
  const s = feed.data?.summary;

  return (
    <div className="space-y-4">
      {pending.length > 0 && (
        <Card>
          <CardHeader title="Your updates to file today" icon={<ClipboardList size={16} />}
            subtitle={`${pending.filter((p: any) => !p.update).length} of ${pending.length} still to file · reminder goes out at 6:30 PM`} />
          <div className="divide-y divide-[var(--line)]">
            {pending.map((p: any) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium text-ink truncate">{p.name}</span>
                  <span className="block text-[12px] text-subtle truncate">
                    {p.client_name} · {SEAT_LABEL[p.seat] || p.seat}
                    {p.owners?.length ? ` · reports to ${p.owners.map((o: any) => o.name).join(', ')}` : ''}
                  </span>
                </span>
                {p.update ? <UpdateStatusBadge status={p.update.status} /> : <Badge tone="warning" dot>Not filed</Badge>}
                <Button variant={p.update ? 'secondary' : 'primary'} size="sm"
                  icon={p.update ? <PencilLine size={14} /> : <Send size={14} />}
                  onClick={() => setFiling(p)}>
                  {p.update ? 'Edit' : 'File update'}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 p-3">
          <span className="flex items-center gap-2">
            <CalendarDays size={15} className="text-subtle" aria-hidden />
            <Input type="date" value={day || feed.data?.date || ''} onChange={(e) => setDay(e.target.value)}
              aria-label="Day" className="w-[160px]" />
          </span>
          <Checkbox label="Only projects I own" checked={mineOnly} onChange={setMineOnly} />
          {day && <Button variant="ghost" size="sm" onClick={() => setDay('')}>Back to today</Button>}
        </div>
      </Card>

      {s && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Active projects" value={s.projects} />
          <Tile label="Updates filed" value={`${s.filed}/${s.expected}`} tone={s.missing ? 'warning' : 'positive'} />
          <Tile label="On track" value={s.on_track} tone="positive" />
          <Tile label="At risk" value={s.at_risk} tone={s.at_risk ? 'warning' : undefined} />
          <Tile label="Blocked" value={s.blocked} tone={s.blocked ? 'negative' : undefined} />
          <Tile label="No update" value={s.no_update} tone={s.no_update ? 'warning' : undefined} />
        </div>
      )}

      {feed.error ? <ErrorState error={feed.error} retry={feed.refetch} />
        : feed.isLoading ? <Card><TableSkeleton rows={4} cols={3} /></Card>
          : !feed.data?.projects?.length ? (
            <Card>
              <EmptyState icon={<Crown size={20} />} title={mineOnly ? 'You do not own any active projects' : 'No active projects'}
                message={mineOnly ? 'Untick "Only projects I own" to see every project you can view.'
                  : 'Active projects show up here with their manager\'s and lead\'s daily update.'} />
            </Card>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {feed.data.projects.map((p: any) => <FeedCard key={p.id} p={p} onOpen={() => onOpenProject(p.id)} />)}
            </div>
          )}

      {filing && (
        <ProjectUpdateModal project={filing} existing={filing.update} previous={filing.previous}
          onClose={() => setFiling(null)} />
      )}
    </div>
  );
}

function FeedCard({ p, onOpen }: { p: any; onOpen: () => void }) {
  const tone = p.status_today ? UPDATE_STATUS[p.status_today].tone : 'neutral';
  const filed = p.seats.filter((s: any) => s.update);
  return (
    <Card className={cx('flex flex-col border-l-[3px]',
      tone === 'negative' ? 'border-l-[var(--negative)]' : tone === 'warning' ? 'border-l-[var(--warning)]'
        : tone === 'positive' ? 'border-l-[var(--positive)]' : 'border-l-[var(--line-strong)]')}>
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <button onClick={onOpen} className="min-w-0 text-left cursor-pointer">
            <p className="font-medium text-ink truncate hover:underline">{p.name}</p>
            <p className="text-[12.5px] text-subtle truncate">
              {p.client_name}{p.end_date ? ` · due ${date(p.end_date)}` : ''}
            </p>
          </button>
          <UpdateStatusBadge status={p.status_today} />
        </div>

        <ProgressPair reported={p.reported_progress} tasks={p.tasks} />

        {filed.map((s: any) => <ProjectUpdateCard key={s.user_id} update={{ ...s.update, user_name: s.name, avatar_url: s.avatar_url }} />)}
        {p.other_updates?.map((u: any) => <ProjectUpdateCard key={u.id} update={u} />)}

        {p.unstaffed ? (
          <p className="flex items-center gap-1.5 text-[12.5px] text-[var(--warning)]">
            <CircleSlash size={13} aria-hidden /> No manager or lead seated - nobody is filing for this project.
          </p>
        ) : p.missing.length > 0 && (
          <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-subtle">
            <span>Not filed yet:</span>
            {p.missing.map((m: any) => (
              <Badge key={m.user_id} tone="warning">{m.name} · {m.seat === 'manager' ? 'Manager' : 'Lead'}</Badge>
            ))}
          </p>
        )}

        {p.owners?.length > 0 && (
          <p className="border-t border-line pt-2.5 text-[11.5px] text-subtle truncate">
            <Crown size={11} className="mr-1 inline-block -mt-px" aria-hidden />
            Owners: {p.owners.map((o: any) => o.name).join(', ')}
          </p>
        )}
      </div>
    </Card>
  );
}

const Tile = ({ label, value, tone }: { label: string; value: any; tone?: 'positive' | 'warning' | 'negative' }) => (
  <div className="rounded-lg border border-line bg-raised p-3">
    <p className="label-cap">{label}</p>
    <p className={cx('mt-1 text-[20px] font-semibold tabular',
      tone ? TONE_TEXT[tone] : 'text-ink')}>{value}</p>
  </div>
);

/* ======================================================= DRAWER HISTORY */
export function ProjectUpdateHistory({ projectId }: { projectId: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['project-updates', projectId],
    queryFn: () => api.get(`/projects/${projectId}/updates`).then((r) => r.data),
  });

  if (error) return <div className="p-5"><ErrorState error={error} retry={refetch} /></div>;
  if (isLoading) return <div className="p-5"><TableSkeleton rows={4} cols={2} /></div>;
  if (!data?.length) {
    return (
      <div className="p-5">
        <EmptyState icon={<ClipboardList size={20} />} title="No updates filed yet"
          message="The project manager and team lead file one each working day." />
      </div>
    );
  }

  const days: Record<string, any[]> = {};
  for (const u of data) (days[u.update_date] ||= []).push(u);

  return (
    <div className="p-5 space-y-5">
      {Object.entries(days).map(([d, list]) => (
        <section key={d}>
          <p className="label-cap mb-2">{date(d, 'long')}</p>
          <div className="space-y-2">{list.map((u) => <ProjectUpdateCard key={u.id} update={u} />)}</div>
        </section>
      ))}
    </div>
  );
}

/* ========================================================= OWNER PICKER */
/** Checkbox list of the people allowed to own a project. */
export function OwnerChecklist({ people, value, onChange }: {
  people: any[]; value: string[]; onChange: (ids: string[]) => void;
}) {
  const eligible = people.filter((u) => OWNER_ROLES.includes(u.role));
  if (!eligible.length) return <p className="text-[12.5px] text-subtle">No Owners or Managers in this workspace yet.</p>;
  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      {eligible.map((u) => (
        <Checkbox key={u.id} checked={value.includes(u.id)}
          label={<span>{u.name} <span className="text-subtle text-[12px]">· {titleCase(u.role)}</span></span>}
          onChange={(on) => onChange(on ? [...value, u.id] : value.filter((id) => id !== u.id))} />
      ))}
    </div>
  );
}

export function EditOwnersModal({ project, onClose }: { project: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ids, setIds] = useState<string[]>(project.owners?.map((o: any) => o.user_id) ?? []);
  const { data: people = [] } = useQuery({
    queryKey: ['directory'],
    queryFn: () => api.get('/users/directory').then((r) => r.data),
    staleTime: 300_000,
  });

  const save = useMutation({
    mutationFn: () => api.put(`/projects/${project.id}/owners`, { user_ids: ids }),
    onSuccess: () => {
      toast.success('Owners updated.');
      qc.invalidateQueries({ queryKey: ['project', project.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      invalidateUpdates(qc, project.id);
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Modal open onClose={onClose} title={`Owners of ${project.name}`}
      subtitle="Owners receive every daily update on this project. Owners and Managers only; at least one."
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!ids.length} onClick={() => save.mutate()}>
            Save owners
          </Button>
        </>
      )}>
      <OwnerChecklist people={people} value={ids} onChange={setIds} />
    </Modal>
  );
}
