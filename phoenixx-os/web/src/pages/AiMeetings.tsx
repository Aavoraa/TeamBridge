import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, CalendarClock, CalendarPlus, Check, CheckCircle2, CircleDot, Clock, Copy, FileText, Film, Link2, ListChecks, Mic,
  RefreshCw, Search, ShieldCheck, Sparkles, Users2, Video, X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date as fmtDate } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select,
  Skeleton, Tabs, Textarea, cx, useToast,
} from '../components/ui';

/**
 * AI Meetings: internal video meetings connected to the rest of the CRM.
 * This file holds the dashboard, scheduling, joining, the lists and the
 * meeting page. The live room (video) is added on top of the meeting page.
 */

type Meeting = any;

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz(),
});
const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: tz() });
const isNow = (m: Meeting) => m.status === 'live'
  || (m.status === 'scheduled' && Date.parse(m.scheduled_at) <= Date.now() && Date.parse(m.scheduled_at) + m.duration_minutes * 60_000 > Date.now());

const STATUS: Record<string, { label: string; tone: any }> = {
  scheduled: { label: 'Scheduled', tone: 'info' },
  live: { label: 'Live now', tone: 'negative' },
  completed: { label: 'Ended', tone: 'neutral' },
  ended: { label: 'Ended', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const RESPONSE: Record<string, { label: string; tone: any }> = {
  accepted: { label: 'Going', tone: 'positive' },
  declined: { label: 'Not going', tone: 'negative' },
  pending: { label: 'No response', tone: 'neutral' },
};

export default function AiMeetings() {
  const { pathname } = useLocation();
  const { id, token } = useParams();
  if (token) return <OpenLink token={token} />;
  if (id) return <MeetingPage id={id} />;
  if (pathname.endsWith('/schedule')) return <SchedulePage />;
  if (pathname.endsWith('/join')) return <JoinPage />;
  if (pathname.endsWith('/upcoming')) return <ListPage tab="upcoming" />;
  if (pathname.endsWith('/history')) return <ListPage tab="history" />;
  return <Dashboard />;
}

function useDirectory() {
  return useQuery({ queryKey: ['ai-meetings', 'directory'], queryFn: () => api.get<any>('/ai-meetings/directory').then((r) => r.data), staleTime: 60_000 });
}

// =================================================================== dashboard
function Dashboard() {
  const { can, user } = useAuth();
  const sees = ['owner', 'super_admin', 'manager'].includes(user?.role || '');
  const navigate = useNavigate();
  const [instant, setInstant] = useState(false);
  const q = useQuery({
    queryKey: ['ai-meetings', 'dashboard'],
    queryFn: () => api.get<any>('/ai-meetings/dashboard').then((r) => r.data),
    refetchInterval: 60_000,
  });
  const canCreate = can('meetings', 'create');
  const d = q.data;

  return (
    <div>
      <PageHeader
        title="AI Meetings"
        subtitle="Internal video meetings, connected to your projects and tasks."
        actions={canCreate && (
          <>
            <Button variant="primary" icon={<Video size={15} />} onClick={() => setInstant(true)}>Create instant meeting</Button>
            <Button icon={<CalendarPlus size={15} />} onClick={() => navigate('/ai-meetings/schedule')}>Schedule meeting</Button>
          </>
        )}
      />
      {q.isLoading && <div className="grid gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div>}
      {q.isError && <ErrorState error={q.error} retry={q.refetch} />}
      {d && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <Stat label="This week" value={d.upcoming.length} sub="upcoming meetings" to="/ai-meetings/upcoming" />
            <Stat label="Invitations" value={d.invitations.length} sub="waiting for your answer" />
            <Stat label="Attendance" value={d.attendance.invited ? `${Math.round((d.attendance.attended / d.attendance.invited) * 100)}%` : '—'}
              sub={d.attendance.invited ? `${d.attendance.attended} of ${d.attendance.invited} invites, last 14 days` : 'no finished meetings yet'} />
            {d.pending_analyses != null && <Stat label="AI analyses" value={d.pending_analyses} sub="being processed" to="/meeting-intel?tab=processing" />}
            {d.pending_approvals != null && <Stat label="Task approvals" value={d.pending_approvals} sub="proposed tasks to review" to="/meeting-intel?tab=pending" tone={d.pending_approvals ? 'warning' : undefined} />}
          </div>

          {d.live.length > 0 && (
            <Card>
              <CardHeader title={<span className="flex items-center gap-2"><CircleDot size={14} className="text-[var(--negative)]" />Happening now</span>} />
              <div className="divide-y divide-line">{d.live.map((m: Meeting) => <Row key={m.id} m={m} />)}</div>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Invitations" empty="No invitations waiting for you." list={d.invitations} respond onChanged={() => q.refetch()} />
            <Section title="Upcoming" empty="Nothing scheduled this week." list={d.upcoming} action={<Link to="/ai-meetings/upcoming" className="text-[13px] text-[var(--brand)] hover:underline">All upcoming</Link>} />
            <Section title="Meetings you host" empty="You are not hosting anything coming up." list={d.mine} />
            <Section title="Recently ended" empty="No meetings in the last two weeks." list={d.recent} action={<Link to="/ai-meetings/history" className="text-[13px] text-[var(--brand)] hover:underline">History</Link>} />
          </div>
          {sees && <Overview />}
        </div>
      )}
      <InstantMeeting open={instant} onClose={() => setInstant(false)} />
    </div>
  );
}

// --------------------------------------------------------------- overview
/** Owner: the whole company. Manager: meetings they or their direct reports host or attend. */
function Overview() {
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ['ai-meetings', 'overview', days],
    queryFn: () => api.get<any>(`/ai-meetings/overview?days=${days}`).then((r) => r.data),
    retry: false,
  });
  const [allPeople, setAllPeople] = useState(false);
  if (q.isError) return null;
  const d = q.data;
  const pct = (n: number | null) => (n == null ? '—' : `${n}%`);
  return (
    <section className="space-y-3 pt-2" aria-label="Meetings overview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">{d?.scope === 'company' ? 'Company meetings' : "Your team's meetings"}</h2>
          <p className="text-[12.5px] text-subtle">{d?.scope === 'company' ? 'Every meeting in the workspace.' : 'Meetings you or the people who report to you host or attend.'}</p>
        </div>
        <Select aria-label="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="!w-auto">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
      </div>
      {!d ? <Skeleton className="h-40" /> : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <Stat label="Held" value={d.totals.completed} sub={`${d.totals.hours} hours in meetings`} />
            <Stat label="Coming up" value={d.totals.upcoming} sub="in the next 7 days" />
            <Stat label="Participation" value={pct(d.totals.attendance_rate)} sub={d.totals.invited ? `${d.totals.attended} of ${d.totals.invited} invites attended` : 'no finished meetings'} />
            <Stat label="Not started" value={d.totals.missed} sub="scheduled, nobody joined" tone={d.totals.missed ? 'warning' : undefined} />
            <Stat label="Cancelled" value={d.totals.cancelled} sub={`in the last ${d.days} days`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="By department" />
              {d.by_department.length === 0 ? <p className="px-4 pb-4 text-[13px] text-subtle">No meetings in this period.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead><tr className="text-left text-[11.5px] uppercase tracking-wide text-subtle">
                      <th className="px-4 py-2 font-medium">Department</th><th className="px-2 py-2 font-medium text-right">Held</th>
                      <th className="px-2 py-2 font-medium text-right">Coming up</th><th className="px-2 py-2 font-medium text-right">Not started</th>
                      <th className="px-4 py-2 font-medium text-right">Participation</th>
                    </tr></thead>
                    <tbody className="divide-y divide-line">
                      {d.by_department.map((x: any) => (
                        <tr key={x.department}>
                          <td className="px-4 py-2 text-ink">
                            {x.department === 'No department' ? <span className="text-subtle">No department</span>
                              : <Link to={`/ai-meetings/history?department=${encodeURIComponent(x.department)}`} className="hover:underline">{x.department}</Link>}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{x.completed}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{x.upcoming}</td>
                          <td className={cx('px-2 py-2 text-right tabular-nums', x.missed && 'text-[var(--warning)]')}>{x.missed}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{pct(x.attendance_rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="Who takes part" action={d.participation.length > 6 && (
                <button type="button" onClick={() => setAllPeople((v) => !v)} className="text-[13px] text-[var(--brand)] hover:underline cursor-pointer">{allPeople ? 'Show fewer' : `All ${d.participation.length}`}</button>
              )} />
              {d.participation.length === 0 ? <p className="px-4 pb-4 text-[13px] text-subtle">Nobody was invited to a finished meeting in this period.</p> : (
                <ul className="divide-y divide-line">
                  {(allPeople ? d.participation : d.participation.slice(0, 6)).map((p: any) => (
                    <li key={p.user_id} className="flex items-center gap-3 px-4 py-2">
                      <Avatar name={p.name} size={26} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] text-ink">{p.name}</p>
                        <p className="truncate text-[12px] text-subtle">{[p.designation, p.department].filter(Boolean).join(' · ') || '—'}</p>
                      </div>
                      <span className="text-[12px] text-subtle tabular-nums">{p.attended}/{p.invited}</span>
                      <span className={cx('w-12 text-right text-[13px] font-medium tabular-nums', p.attendance_rate < 50 ? 'text-[var(--warning)]' : 'text-ink')}>{pct(p.attendance_rate)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="px-4 py-2 text-[11.5px] text-subtle border-t border-line">Lowest attendance first. Counts finished meetings people were invited to.</p>
            </Card>

            {d.summaries && (
              <Card>
                <CardHeader title="AI summaries" icon={<Sparkles size={15} className="text-[var(--brand)]" />}
                  action={<Link to="/meeting-intel" className="text-[13px] text-[var(--brand)] hover:underline">All</Link>} />
                {d.summaries.length === 0 ? <p className="px-4 pb-4 text-[13px] text-subtle">No analysed meetings in this period.</p> : (
                  <ul className="divide-y divide-line">
                    {d.summaries.map((s: any) => (
                      <li key={s.id} className="px-4 py-2.5">
                        <Link to={`/meeting-intel/${s.id}`} className="text-[13.5px] font-medium text-ink hover:underline">{s.title}</Link>
                        <span className="ml-2 text-[12px] text-subtle">{s.meeting_date ? fmtDate(s.meeting_date) : fmtDate(s.created_at)}</span>
                        {s.overview && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{s.overview}</p>}
                        <p className="mt-0.5 text-[12px] text-subtle">
                          {s.decisions.length ? `${s.decisions.length} decision${s.decisions.length > 1 ? 's' : ''} · ` : ''}
                          {s.approved} task{s.approved === 1 ? '' : 's'} approved{s.pending ? ` · ${s.pending} waiting` : ''}
                          {s.live_meeting_id && <> · <Link to={`/ai-meetings/m/${s.live_meeting_id}`} className="text-[var(--brand)] hover:underline">meeting</Link></>}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {d.approvals && (
              <Card>
                <CardHeader title="Waiting for task approval" action={<Link to="/meeting-intel?tab=pending" className="text-[13px] text-[var(--brand)] hover:underline">Approval dashboard</Link>} />
                {d.approvals.length === 0 ? <p className="px-4 pb-4 text-[13px] text-subtle">Nothing waiting. Every proposed task has been decided.</p> : (
                  <ul className="divide-y divide-line">
                    {d.approvals.map((a: any) => (
                      <li key={a.id}>
                        <Link to={`/meeting-intel/${a.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken">
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{a.title}</span>
                          <span className="text-[12px] text-subtle">{a.meeting_date ? fmtDate(a.meeting_date) : fmtDate(a.created_at)}</span>
                          <Badge tone="warning">{a.pending} to review</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, sub, to, tone }: { label: string; value: any; sub: string; to?: string; tone?: 'warning' }) {
  const body = (
    <Card className={cx('px-3.5 py-3 h-full', to && 'hover:bg-sunken transition-colors')}>
      <p className="text-[11.5px] uppercase tracking-wide text-subtle">{label}</p>
      <p className={cx('text-[22px] font-semibold', tone === 'warning' ? 'text-[var(--warning)]' : 'text-ink')}>{value}</p>
      <p className="text-[12px] text-subtle">{sub}</p>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

function Section({ title, empty, list, action, respond, onChanged }: {
  title: string; empty: string; list: Meeting[]; action?: React.ReactNode; respond?: boolean; onChanged?: () => void;
}) {
  return (
    <Card>
      <CardHeader title={title} action={action} />
      {!list.length ? <div className="px-4 py-6"><EmptyState compact icon={<CalendarClock size={18} />} title={empty} /></div>
        : <div className="divide-y divide-line">{list.map((m) => <Row key={m.id} m={m} respond={respond} onChanged={onChanged} />)}</div>}
    </Card>
  );
}

function Row({ m, respond, onChanged }: { m: Meeting; respond?: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const answer = async (response: 'accepted' | 'declined') => {
    try { await api.post(`/ai-meetings/${m.id}/respond`, { response }); onChanged?.(); } catch (e: any) { toast.error(e?.message); }
  };
  const now = isNow(m);
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <Link to={`/ai-meetings/m/${m.id}`} className="min-w-0 flex-1 group">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-ink group-hover:text-[var(--brand)] truncate">{m.title}</span>
          {now ? <Badge tone="negative">Now</Badge> : m.status !== 'scheduled' && <Badge tone={STATUS[m.status]?.tone}>{STATUS[m.status]?.label}</Badge>}
          {m.recurrence && <Badge tone="neutral"><RefreshCw size={11} /> {m.recurrence}</Badge>}
        </div>
        <p className="text-[12.5px] text-subtle mt-0.5">
          {when(m.scheduled_at)} · {m.duration_minutes} min · {m.host_name || 'No host'} · {m.invited_count} invited
          {m.project_name ? ` · ${m.project_name}` : ''}{m.department ? ` · ${m.department}` : ''}
        </p>
      </Link>
      {respond && (
        <div className="flex gap-1.5 shrink-0">
          <Button size="sm" icon={<Check size={13} />} onClick={() => answer('accepted')}>Accept</Button>
          <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => answer('declined')}>Decline</Button>
        </div>
      )}
    </div>
  );
}

function InstantMeeting({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Meeting | null>(null);
  useEffect(() => { if (open) { setTitle(''); setMade(null); } }, [open]);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post<Meeting>('/ai-meetings/instant', { title: title.trim() || undefined });
      setMade(r.data);
      qc.invalidateQueries({ queryKey: ['ai-meetings'] });
    } catch (e: any) { toast.error(e?.message || 'Could not create the meeting'); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={made ? 'Your meeting is ready' : 'Create an instant meeting'} size="sm"
      footer={made ? (
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => navigate(`/ai-meetings/m/${made.id}`)}>Open meeting</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Video size={15} />} loading={busy} onClick={create}>Create</Button>
        </>
      )}>
      {made ? (
        <div className="space-y-2">
          <p className="text-[13.5px] text-muted">Share this link with colleagues. Anyone in your workspace who has it can join.</p>
          <CopyLink url={made.join_url} />
        </div>
      ) : (
        <Field label="Title (optional)"><Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Quick sync" /></Field>
      )}
    </Modal>
  );
}

function CopyLink({ url }: { url: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2">
      <Link2 size={15} className="text-subtle shrink-0" />
      <span className="text-[13px] text-ink truncate flex-1" title={url}>{url}</span>
      <Button size="sm" icon={<Copy size={13} />} onClick={() => navigator.clipboard?.writeText(url).then(() => toast.success('Link copied'), () => toast.error('Copy failed - select the link instead'))}>Copy</Button>
    </div>
  );
}

// ================================================================== schedule
type FormState = {
  title: string; description: string; agenda: string; date: string; time: string; duration_minutes: number;
  host_id: string; participant_ids: string[]; departments: string[]; department: string;
  project_id: string; client_id: string; access: 'invited' | 'workspace';
  recording_allowed: boolean; transcription_allowed: boolean; recurrence: string; recurrence_until: string;
};

const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const nextHalfHour = () => { const d = new Date(Date.now() + 30 * 60_000); d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0); return d.toTimeString().slice(0, 5); };

function SchedulePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const toast = useToast();
  const dir = useDirectory();
  const [f, setF] = useState<FormState>({
    title: '', description: '', agenda: '', date: todayLocal(), time: nextHalfHour(), duration_minutes: 30,
    host_id: '', participant_ids: [], departments: [], department: '', project_id: new URLSearchParams(useLocation().search).get('project_id') || '', client_id: '',
    access: 'invited', recording_allowed: false, transcription_allowed: false, recurrence: '', recurrence_until: '',
  });
  // A project chosen from its page brings its client along, once the directory has loaded.
  useEffect(() => {
    if (f.project_id && !f.client_id && dir.data?.projects) {
      const p = dir.data.projects.find((x: any) => x.id === f.project_id);
      if (p?.client_id) setF((cur) => ({ ...cur, client_id: p.client_id }));
    }
  }, [dir.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post<Meeting>('/ai-meetings', {
        ...f,
        host_id: f.host_id || user?.id,
        department: f.department || null, project_id: f.project_id || null, client_id: f.client_id || null,
        recurrence: f.recurrence || null, recurrence_until: f.recurrence ? f.recurrence_until || null : null,
        description: f.description || null, agenda: f.agenda || null,
      });
      qc.invalidateQueries({ queryKey: ['ai-meetings'] });
      toast.success(r.data.occurrence_ids?.length > 1 ? `${r.data.occurrence_ids.length} meetings scheduled. Invitations sent.` : 'Meeting scheduled. Invitations sent.');
      navigate(`/ai-meetings/m/${r.data.id}`);
    } catch (e: any) {
      setError(e instanceof ApiError && e.details?.length ? e.details.map((d: any) => d.message).join('. ') : e?.message || 'Could not schedule the meeting');
    } finally { setBusy(false); }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="Schedule a meeting" subtitle="Invitations go out through the CRM's notifications as soon as you schedule." />
      {dir.isLoading ? <Skeleton className="h-96" /> : dir.isError ? <ErrorState error={dir.error} retry={dir.refetch} /> : (
        <Card className="p-4 sm:p-5">
          <MeetingForm f={f} setF={setF} dir={dir.data} />
          {error && <p className="mt-4 flex gap-2 rounded-md bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]" role="alert"><AlertCircle size={15} className="mt-0.5 shrink-0" />{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
            <Button variant="primary" icon={<CalendarPlus size={15} />} loading={busy}
              disabled={f.title.trim().length < 2 || !f.date || !f.time || (!!f.recurrence && !f.recurrence_until)} onClick={submit}>
              Schedule and invite
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function MeetingForm({ f, setF, dir, editing }: { f: FormState; setF: (f: FormState) => void; dir: any; editing?: boolean }) {
  const set = (patch: Partial<FormState>) => setF({ ...f, ...patch });
  return (
    <div className="space-y-4">
      <Field label="Meeting title" required><Input value={f.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} placeholder="Project weekly review" /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Date" required><Input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        <Field label="Start time" required><Input type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} /></Field>
        <Field label="Duration">
          <Select value={f.duration_minutes} onChange={(e) => set({ duration_minutes: Number(e.target.value) })}>
            {[15, 30, 45, 60, 90, 120, 180].map((n) => <option key={n} value={n}>{n < 60 ? `${n} minutes` : `${n / 60} hour${n > 60 ? 's' : ''}`}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Description"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <Field label="Agenda" hint="One point per line"><Textarea rows={3} value={f.agenda} onChange={(e) => set({ agenda: e.target.value })} /></Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Host">
          <Select value={f.host_id} onChange={(e) => set({ host_id: e.target.value })}>
            <option value="">Me</option>
            {dir.people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Department (of the meeting)">
          <Input list="ai-meeting-departments" value={f.department} maxLength={80} onChange={(e) => set({ department: e.target.value })} placeholder="Delivery" />
          <datalist id="ai-meeting-departments">{dir.departments.map((d: string) => <option key={d} value={d} />)}</datalist>
        </Field>
        <Field label="Project">
          <Select value={f.project_id} onChange={(e) => {
            const p = dir.projects.find((x: any) => x.id === e.target.value);
            set({ project_id: e.target.value, client_id: p?.client_id || f.client_id });
          }}>
            <option value="">None</option>
            {dir.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Client">
          <Select value={f.client_id} onChange={(e) => set({ client_id: e.target.value })}>
            <option value="">None</option>
            {dir.clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>

      {!editing && <PeoplePicker dir={dir} selected={f.participant_ids} departments={f.departments}
        onChange={(participant_ids, departments) => set({ participant_ids, departments })} />}

      <Field label="Who can join">
        <div className="grid gap-2 sm:grid-cols-2">
          {([['invited', 'Invited people only', 'The link works only for people on the invite list'], ['workspace', 'Anyone in the workspace with the link', 'Colleagues who open the link are added']] as const).map(([v, l, s]) => (
            <button key={v} type="button" onClick={() => set({ access: v })}
              className={cx('rounded-lg border p-2.5 text-left cursor-pointer transition-colors', f.access === v ? 'border-[var(--brand)] bg-brand-soft' : 'border-line hover:bg-sunken')}>
              <p className="text-[13.5px] font-medium text-ink">{l}</p><p className="text-[12px] text-subtle">{s}</p>
            </button>
          ))}
        </div>
      </Field>

      <div className="rounded-lg border border-line p-3 space-y-2">
        <p className="text-[13px] font-medium text-ink flex items-center gap-1.5"><ShieldCheck size={15} /> Recording and transcription</p>
        <p className="text-[12.5px] text-subtle">If allowed, the host can start recording or transcription during the meeting. Every participant is told before they join and must agree; nothing is ever recorded without the host starting it.</p>
        <Toggle checked={f.transcription_allowed} onChange={(v) => set({ transcription_allowed: v })} label="Allow transcription (needed for AI summaries and tasks)" />
        <Toggle checked={f.recording_allowed} onChange={(v) => set({ recording_allowed: v })} label="Allow video recording" />
      </div>

      {!editing && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Repeats">
            <Select value={f.recurrence} onChange={(e) => set({ recurrence: e.target.value })}>
              <option value="">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </Select>
          </Field>
          {f.recurrence && <Field label="Until" required hint="Up to 26 meetings"><Input type="date" value={f.recurrence_until} min={f.date} onChange={(e) => set({ recurrence_until: e.target.value })} /></Field>}
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2.5 text-[13.5px] text-ink cursor-pointer">
      <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function PeoplePicker({ dir, selected, departments, onChange }: {
  dir: any; selected: string[]; departments: string[]; onChange: (ids: string[], deps: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const sel = new Set(selected);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return dir.people.filter((p: any) => !t || `${p.name} ${p.designation || ''} ${p.department || ''}`.toLowerCase().includes(t));
  }, [q, dir.people]);
  const fromDeps = dir.people.filter((p: any) => p.department && departments.includes(p.department) && !sel.has(p.id)).length;
  return (
    <Field label="Participants" hint={`${selected.length} people${departments.length ? ` + ${fromDeps} from ${departments.join(', ')}` : ''}`}>
      <div className="rounded-lg border border-line">
        {dir.departments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
            <span className="text-[12px] text-subtle self-center mr-1">Whole department:</span>
            {dir.departments.map((d: string) => {
              const on = departments.includes(d);
              return (
                <button key={d} type="button" onClick={() => onChange(selected, on ? departments.filter((x) => x !== d) : [...departments, d])}
                  className={cx('rounded-full border px-2.5 py-0.5 text-[12.5px] cursor-pointer', on ? 'border-[var(--brand)] bg-brand-soft text-[var(--brand)]' : 'border-line text-muted hover:bg-sunken')}>
                  {on && <Check size={11} className="inline -mt-0.5 mr-0.5" />}{d}
                </button>
              );
            })}
          </div>
        )}
        <div className="relative border-b border-line">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people"
            className="w-full bg-transparent py-2 pl-8 pr-3 text-[13.5px] text-ink outline-none" />
        </div>
        <div className="max-h-56 overflow-y-auto">
          {shown.map((p: any) => (
            <label key={p.id} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-sunken cursor-pointer">
              <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={sel.has(p.id)} aria-label={`Invite ${p.name}`}
                onChange={(e) => onChange(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id), departments)} />
              <Avatar name={p.name} url={p.avatar_url} size={22} />
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{p.name}</span>
              <span className="text-[12px] text-subtle truncate">{[p.designation, p.department].filter(Boolean).join(' · ')}</span>
            </label>
          ))}
          {!shown.length && <p className="px-3 py-3 text-[13px] text-subtle">No one matches “{q}”.</p>}
        </div>
      </div>
    </Field>
  );
}

// ====================================================================== join
function JoinPage() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const q = useQuery({ queryKey: ['ai-meetings', 'dashboard'], queryFn: () => api.get<any>('/ai-meetings/dashboard').then((r) => r.data) });
  const go = () => {
    const m = value.trim().match(/\/ai-meetings\/j\/([\w-]+)/) || value.trim().match(/^([\w-]{16,})$/);
    if (!m) { setError('Paste the meeting link you were sent.'); return; }
    navigate(`/ai-meetings/j/${m[1]}`);
  };
  return (
    <div className="max-w-2xl">
      <PageHeader title="Join a meeting" subtitle="Paste a meeting link, or pick a meeting that is happening now." />
      <Card className="p-4">
        <Field label="Meeting link" error={error}>
          <div className="flex gap-2">
            <Input value={value} onChange={(e) => { setValue(e.target.value); setError(''); }} placeholder="https://…/ai-meetings/j/…"
              onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
            <Button variant="primary" onClick={go} disabled={!value.trim()}>Continue</Button>
          </div>
        </Field>
      </Card>
      <Card className="mt-4">
        <CardHeader title="Happening now" />
        {q.isLoading ? <div className="p-4"><Skeleton className="h-12" /></div>
          : !q.data?.live.length ? <div className="px-4 py-6"><EmptyState compact icon={<Video size={18} />} title="No meetings in progress" message="Meetings you are invited to show here while they run." /></div>
            : <div className="divide-y divide-line">{q.data.live.map((m: Meeting) => <Row key={m.id} m={m} />)}</div>}
      </Card>
    </div>
  );
}

function OpenLink({ token }: { token: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<Meeting>(`/ai-meetings/link/${token}`)
      .then((r) => navigate(`/ai-meetings/m/${r.data.id}`, { replace: true }))
      .catch((e) => setError(e?.status === 404 ? 'This link does not work. It may have been replaced by the host, or belong to another workspace.' : e?.message || 'Could not open this meeting.'));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!error) return <div className="p-8"><Skeleton className="h-32" /></div>;
  return <Card className="max-w-lg"><EmptyState icon={<AlertCircle size={20} />} title="Cannot open this meeting" message={error} action={<Link to="/ai-meetings/join"><Button>Back to Join</Button></Link>} /></Card>;
}

// ===================================================================== lists
function ListPage({ tab }: { tab: 'upcoming' | 'history' }) {
  const { user } = useAuth();
  const dir = useDirectory();
  const [search, setSearch] = useState('');
  // ?department= arrives from the overview's department table.
  const [department, setDepartment] = useState(() => new URLSearchParams(window.location.search).get('department') || '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recorded, setRecorded] = useState(false);
  const [inTranscripts, setInTranscripts] = useState(false);
  const history = tab === 'history';
  const params: Record<string, string> = { tab, search, department };
  if (history) {
    if (from) params.from = from;
    if (to) params.to = to;
    if (recorded) params.recorded = '1';
    if (inTranscripts && search.trim()) params.in_transcripts = '1';
  }
  const q = useQuery({
    queryKey: ['ai-meetings', 'list', params],
    queryFn: () => api.get<Meeting[]>('/ai-meetings', params).then((r) => r.data),
  });
  const isOwner = ['owner', 'super_admin'].includes(user?.role || '');
  return (
    <div>
      <PageHeader title={tab === 'upcoming' ? 'Upcoming meetings' : 'Meeting history'}
        subtitle={isOwner ? 'Every meeting in the workspace.' : 'Meetings you host or are invited to, and your team\'s.'} />
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search meetings" className="pl-8" />
        </div>
        {(dir.data?.departments?.length ?? 0) > 0 && (
          <Select value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full sm:w-52" aria-label="Department">
            <option value="">All departments</option>
            {dir.data.departments.map((d: string) => <option key={d} value={d}>{d}</option>)}
          </Select>
        )}
        {history && (
          <>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" className="w-full sm:w-40" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" className="w-full sm:w-40" />
            <label className="inline-flex items-center gap-1.5 text-[13px] text-muted cursor-pointer">
              <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={recorded} onChange={(e) => setRecorded(e.target.checked)} /> With a recording
            </label>
            <label className="inline-flex items-center gap-1.5 text-[13px] text-muted cursor-pointer" title="Also find meetings where these words were said (meetings whose transcript you may read)">
              <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={inTranscripts} onChange={(e) => setInTranscripts(e.target.checked)} /> Search what was said
            </label>
          </>
        )}
      </div>
      {q.isLoading ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} retry={q.refetch} /> : !q.data?.length ? (
        <Card><EmptyState icon={<CalendarClock size={20} />} title={tab === 'upcoming' ? 'No upcoming meetings' : 'No past meetings yet'}
          message={tab === 'upcoming' ? 'Schedule one, or create an instant meeting.' : 'Finished meetings appear here with their attendance.'} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {q.data.map((m) => (
            <Link key={m.id} to={`/ai-meetings/m/${m.id}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-sunken sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-ink truncate">{m.title}</span>
                  {isNow(m) ? <Badge tone="negative">Now</Badge> : <Badge tone={STATUS[m.status]?.tone}>{STATUS[m.status]?.label}</Badge>}
                </div>
                <p className="text-[12.5px] text-subtle">{when(m.scheduled_at)} · {history && m.actual_minutes ? `ran ${m.actual_minutes} min` : `${m.duration_minutes} min`} · Host {m.host_name || '—'}{m.department ? ` · ${m.department}` : ''}{m.project_name ? ` · ${m.project_name}` : ''}</p>
              </div>
              <div className="flex gap-3 text-[12.5px] text-muted shrink-0">
                <span><Users2 size={13} className="inline -mt-0.5" /> {m.invited_count} invited</span>
                {tab === 'upcoming' ? <span>{m.accepted_count} going</span> : <span>{m.attended_count} attended</span>}
                {history && <>
                  {m.recordings_count > 0 && <span title="Recording available"><Film size={13} className="inline -mt-0.5" /></span>}
                  {m.has_transcript && <span title="Transcript available"><FileText size={13} className="inline -mt-0.5" /></span>}
                  {m.ai_status && <Badge tone={AI_STATUS[m.ai_status]?.tone}>{AI_STATUS[m.ai_status]?.label}</Badge>}
                  {m.tasks_extracted > 0 && (
                    <span title="Tasks found · approved · rejected"><CheckCircle2 size={13} className="inline -mt-0.5" /> {m.tasks_extracted} · {m.tasks_approved} · {m.tasks_rejected}</span>
                  )}
                </>}
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

// ============================================================== meeting page
function MeetingPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const location = useLocation();
  // ?t=41 means "play the recording from 0:41": open the Recording tab.
  const [tab, setTab] = useState(() => (new URLSearchParams(location.search).get('t') ? 'recording' : 'overview'));
  useEffect(() => { if (new URLSearchParams(location.search).get('t')) setTab('recording'); }, [location.search]);
  const [modal, setModal] = useState<'' | 'edit' | 'invite' | 'cancel'>('');
  const q = useQuery({ queryKey: ['ai-meetings', 'meeting', id], queryFn: () => api.get<Meeting>(`/ai-meetings/${id}`).then((r) => r.data) });
  const set = (m: Meeting) => { qc.setQueryData(['ai-meetings', 'meeting', id], m); qc.invalidateQueries({ queryKey: ['ai-meetings', 'dashboard'] }); };

  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;
  if (q.isError) return <ErrorState error={q.error} retry={q.refetch} />;
  const m = q.data;
  const cancelled = !!m.cancelled_at;
  const respond = async (response: 'accepted' | 'declined') => {
    try { set((await api.post<Meeting>(`/ai-meetings/${m.id}/respond`, { response })).data); } catch (e: any) { toast.error(e?.message); }
  };
  // Recording, transcript and AI tabs, for meetings that could have produced them.
  const hasOutput = (m.recording_allowed || m.transcription_allowed) && m.status !== 'scheduled' && !cancelled;
  const attendanceBy = new Map((m.attendance || []).map((a: any) => [a.user_id, a]));

  return (
    <div className="space-y-4">
      <div>
        <Link to="/ai-meetings" className="text-[13px] text-muted hover:text-ink">← AI Meetings</Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-[21px] font-semibold text-ink">{m.title}</h1>
          {isNow(m) && !cancelled ? <Badge tone="negative">Happening now</Badge> : <Badge tone={STATUS[m.status]?.tone}>{STATUS[m.status]?.label}</Badge>}
          {m.recurrence && <Badge tone="neutral"><RefreshCw size={11} /> Repeats {m.recurrence}</Badge>}
        </div>
        <p className="text-[13px] text-subtle mt-0.5">{when(m.scheduled_at)} – {timeOnly(new Date(Date.parse(m.scheduled_at) + m.duration_minutes * 60_000).toISOString())} · Hosted by {m.host_name}
          {m.actual_minutes ? ` · ran ${m.actual_minutes} min` : ''}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {!cancelled && m.status !== 'completed' && (
          <Link to={`/ai-meetings/room/${m.id}`}>
            <Button variant="primary" icon={<Video size={15} />}>{isNow(m) ? 'Join now' : 'Join meeting'}</Button>
          </Link>
        )}
        {!cancelled && m.my_response && !m.is_host && m.status === 'scheduled' && (
          <>
            <Button icon={<Check size={14} />} variant={m.my_response === 'accepted' ? 'accent' : 'secondary'} onClick={() => respond('accepted')}>Going</Button>
            <Button icon={<X size={14} />} variant={m.my_response === 'declined' ? 'danger' : 'ghost'} onClick={() => respond('declined')}>Not going</Button>
          </>
        )}
        {m.can_manage && !cancelled && m.status === 'scheduled' && (
          <>
            <Button icon={<CalendarClock size={14} />} onClick={() => setModal('edit')}>Reschedule or edit</Button>
            <Button icon={<Users2 size={14} />} onClick={() => setModal('invite')}>Invite people</Button>
            <Button variant="ghost" icon={<X size={14} />} onClick={() => setModal('cancel')}>Cancel meeting</Button>
          </>
        )}
      </div>

      {cancelled && <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-muted">Cancelled {fmtDate(m.cancelled_at)}{m.cancel_reason ? ` — ${m.cancel_reason}` : ''}.</p>}

      <div className="overflow-x-auto">
        <Tabs active={tab} onChange={setTab} tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'participants', label: 'Participants', count: m.attendees.length },
          ...(hasOutput ? [
            { id: 'recording', label: 'Recording', count: m.recordings_count || undefined },
            { id: 'transcript', label: 'Transcript' },
            { id: 'summary', label: 'AI summary' },
            { id: 'actions', label: 'Action items', count: m.tasks_extracted || undefined },
            { id: 'approved', label: 'Approved tasks', count: m.tasks_approved || undefined },
          ] : []),
        ]} />
      </div>

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-4 space-y-4">
            {m.description && <div><p className="label-cap mb-1">Description</p><p className="text-[13.5px] text-ink whitespace-pre-wrap">{m.description}</p></div>}
            <div><p className="label-cap mb-1">Agenda</p>{m.agenda ? <p className="text-[13.5px] text-ink whitespace-pre-wrap">{m.agenda}</p> : <p className="text-[13px] text-subtle">No agenda added.</p>}</div>
            {m.join_url && !cancelled && <div><p className="label-cap mb-1">Meeting link</p><CopyLink url={m.join_url} />
              {m.can_manage && <button type="button" onClick={async () => { try { set((await api.post<Meeting>(`/ai-meetings/${m.id}/rotate-link`)).data); toast.info('A new link was created; the old one no longer works.'); } catch (e: any) { toast.error(e?.message); } }}
                className="mt-1.5 text-[12.5px] text-[var(--brand)] hover:underline cursor-pointer">Replace this link</button>}
            </div>}
          </Card>
          <Card className="p-4 space-y-2.5 text-[13px]">
            <Info label="Project">{m.project_name || '—'}</Info>
            <Info label="Client">{m.client_name || '—'}</Info>
            <Info label="Department">{m.department || '—'}</Info>
            <Info label="Who can join">{m.access === 'workspace' ? 'Anyone in the workspace with the link' : 'Invited people only'}</Info>
            <Info label="Responses">{m.accepted_count} going · {m.declined_count} not going · {m.invited_count - m.accepted_count - m.declined_count} no response</Info>
            <Info label="Transcription"><span className="inline-flex items-center gap-1">{m.transcription_allowed ? <><Mic size={13} /> Allowed, with consent</> : 'Off'}</span></Info>
            <Info label="Recording">{m.recording_allowed ? 'Allowed, with consent' : 'Off'}</Info>
            {m.transcription_allowed && <Link to="/meeting-intel" className="inline-flex items-center gap-1 text-[var(--brand)] hover:underline"><Sparkles size={13} /> AI summary and tasks after the meeting</Link>}
          </Card>
          {hasOutput && <Outcome m={m} onOpen={setTab} />}
        </div>
      )}

      {tab === 'recording' && hasOutput && <RecordingsCard meetingId={m.id} />}
      {['transcript', 'summary', 'actions', 'approved'].includes(tab) && hasOutput && <MeetingRecord m={m} view={tab} />}

      {tab === 'participants' && (
        <Card className="divide-y divide-line">
          {m.attendees.map((a: any) => (
            <div key={a.user_id} className="flex items-center gap-3 px-4 py-2.5">
              <Avatar name={a.name} url={a.avatar_url} size={30} />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-ink truncate">{a.name}{a.role === 'host' && <Badge tone="brand" className="ml-2">Host</Badge>}</p>
                <p className="text-[12px] text-subtle truncate">{[a.designation, a.department].filter(Boolean).join(' · ') || a.email}
                  {a.invited_via?.startsWith('department:') ? ` · via ${a.invited_via.slice(11)}` : a.invited_via === 'link' ? ' · joined by link' : ''}</p>
              </div>
              {m.status === 'scheduled' ? <Badge tone={RESPONSE[a.response]?.tone}>{RESPONSE[a.response]?.label}</Badge>
                : attendanceBy.get(a.user_id) ? (
                  <span className="text-right text-[12.5px]">
                    <Badge tone="positive">Attended</Badge>
                    <span className="block text-subtle">{(attendanceBy.get(a.user_id) as any).minutes} min{(attendanceBy.get(a.user_id) as any).connections > 1 ? ` · rejoined ${(attendanceBy.get(a.user_id) as any).connections - 1}×` : ''}</span>
                  </span>
                ) : a.attended ? <Badge tone="positive">Attended</Badge> : <Badge tone="neutral">Did not join</Badge>}
              {m.can_manage && a.role !== 'host' && m.status === 'scheduled' && !cancelled && (
                <button type="button" aria-label={`Remove ${a.name}`} className="text-subtle hover:text-[var(--negative)] cursor-pointer p-1"
                  onClick={async () => { try { set((await api.del<Meeting>(`/ai-meetings/${m.id}/attendees/${a.user_id}`)).data); } catch (e: any) { toast.error(e?.message); } }}>
                  <X size={15} />
                </button>
              )}
            </div>
          ))}
        </Card>
      )}

      {modal === 'edit' && <EditMeeting m={m} onClose={() => setModal('')} onSaved={set} />}
      {modal === 'invite' && <InvitePeople m={m} onClose={() => setModal('')} onSaved={set} />}
      {modal === 'cancel' && <CancelMeeting m={m} onClose={() => setModal('')} onSaved={set} />}
    </div>
  );
}

const AI_STATUS: Record<string, { label: string; tone: any }> = {
  uploading: { label: 'Receiving', tone: 'neutral' }, queued: { label: 'Queued', tone: 'neutral' },
  transcribing: { label: 'Transcribing', tone: 'info' }, analyzing: { label: 'Analysing', tone: 'info' },
  review: { label: 'Tasks to review', tone: 'warning' }, completed: { label: 'Reviewed', tone: 'positive' },
  failed: { label: 'AI failed', tone: 'negative' },
};

/** Overview: what came out of the meeting, with a way into each tab. */
function Outcome({ m, onOpen }: { m: Meeting; onOpen: (tab: string) => void }) {
  const item = (icon: React.ReactNode, label: string, value: React.ReactNode, tab: string) => (
    <button type="button" onClick={() => onOpen(tab)} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sunken cursor-pointer">
      <span className="text-subtle">{icon}</span>
      <span className="w-28 shrink-0 text-subtle">{label}</span>
      <span className="text-ink">{value}</span>
    </button>
  );
  return (
    <Card className="p-3 lg:col-span-2 text-[13px]">
      <p className="label-cap px-2 pb-1">What came out of this meeting</p>
      <div className="grid gap-0.5 sm:grid-cols-2">
        {item(<Film size={14} />, 'Recording', m.recordings_count ? `${m.recordings_count} available` : 'None', 'recording')}
        {item(<FileText size={14} />, 'Transcript', m.has_transcript ? 'Available' : m.ai_status ? AI_STATUS[m.ai_status]?.label : 'None', 'transcript')}
        {item(<Sparkles size={14} />, 'AI summary', m.has_summary ? 'Available' : m.ai_status ? AI_STATUS[m.ai_status]?.label : 'None', 'summary')}
        {item(<ListChecks size={14} />, 'Tasks', m.tasks_extracted ? `${m.tasks_extracted} found · ${m.tasks_approved} approved · ${m.tasks_rejected} rejected` : 'None found', 'actions')}
      </div>
    </Card>
  );
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(q)})`, 'ig'));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded bg-[color-mix(in_srgb,var(--warning)_35%,transparent)] px-0.5 text-ink">{p}</mark> : p))}</>;
}
const clockOf = (s: number | null | undefined) => {
  if (s == null) return '';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600); const mm = Math.floor((t % 3600) / 60); const ss = t % 60;
  return h ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
const ITEM_STATUS: Record<string, { label: string; tone: any }> = {
  proposed: { label: 'Waiting for approval', tone: 'warning' }, approving: { label: 'Being approved', tone: 'info' },
  approved: { label: 'Approved', tone: 'positive' }, rejected: { label: 'Rejected', tone: 'neutral' },
  cancelled_in_meeting: { label: 'Called off in the meeting', tone: 'neutral' },
};

/** Transcript, AI summary, action items and approved tasks - one request, four tabs. */
function MeetingRecord({ m, view }: { m: Meeting; view: string }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['ai-meetings', 'record', m.id],
    queryFn: () => api.get<any>(`/ai-meetings/${m.id}/record`).then((r) => r.data),
    retry: false,
    refetchInterval: (query) => (['queued', 'transcribing', 'analyzing'].includes(query.state.data?.ai?.status) ? 15_000 : false),
  });
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.isError) return <Card className="p-4 text-[13.5px] text-muted flex gap-2"><ShieldCheck size={16} className="mt-0.5 shrink-0" />{(q.error as any)?.message || 'You cannot see this.'}</Card>;
  const r = q.data;
  const play = m.recordings_count ? (s: number | null) => s != null && navigate(`/ai-meetings/m/${m.id}?t=${Math.floor(s)}`) : null;
  if (!r.ai) {
    return (
      <Card className="p-4 text-[13.5px] text-muted">
        No transcript for this meeting. One is made when the host starts recording in a meeting that allows transcription.
      </Card>
    );
  }
  const busy = ['uploading', 'queued', 'transcribing', 'analyzing'].includes(r.ai.status);
  const note = busy ? <p className="mb-3 rounded-md bg-sunken px-3 py-2 text-[13px] text-muted">{AI_STATUS[r.ai.status]?.label}… this page updates by itself.</p>
    : r.ai.status === 'failed' ? <p className="mb-3 rounded-md bg-negative-soft px-3 py-2 text-[13px] text-[var(--negative)]">{r.ai.error || 'AI processing failed.'}</p> : null;

  if (view === 'transcript') return <>{note}<TranscriptView lines={r.transcript} play={play} /></>;
  if (view === 'summary') return <>{note}<SummaryView summary={r.summary} open={r.open_items} /></>;
  if (view === 'actions') {
    return (
      <>
        {note}
        <Card>
          <CardHeader title="Action items the AI found" action={r.can_review && r.ai.status === 'review' && (
            <Link to={`/meeting-intel/${r.ai.id}`}><Button size="sm" variant="primary">Review in the approval dashboard</Button></Link>
          )} />
          {!r.items.length ? <p className="px-4 pb-4 text-[13px] text-subtle">{busy ? 'Not analysed yet.' : 'No tasks were given out in this meeting.'}</p> : (
            <ul className="divide-y divide-line">
              {r.items.map((it: any) => (
                <li key={it.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-ink">{it.title}</span>
                    <Badge tone={ITEM_STATUS[it.status]?.tone}>{ITEM_STATUS[it.status]?.label || it.status}</Badge>
                    <Badge tone="neutral">{it.confidence} confidence</Badge>
                  </div>
                  <p className="mt-1 text-[12.5px] text-muted">
                    For {it.assignee_display || (it.assignee_name ? `“${it.assignee_name}” (not matched)` : 'nobody named')}
                    {it.assigned_by_name ? ` · from ${it.assigned_by_name}` : ''}
                    {it.due_date ? ` · due ${fmtDate(it.due_date)}` : it.deadline_text ? ` · “${it.deadline_text}”` : ''}
                    {it.priority ? ` · ${it.priority} priority` : ''}
                    {it.project_name || it.client_name ? ` · ${it.project_name || it.client_name}` : ''}
                    {it.decided_by_name && it.status !== 'proposed' ? ` · ${it.status === 'rejected' ? 'rejected' : 'approved'} by ${it.decided_by_name}` : ''}
                  </p>
                  {it.quote && (
                    <p className="mt-1.5 rounded-md border-l-2 border-[var(--brand)] bg-sunken px-3 py-1.5 text-[12.5px] text-muted">
                      {it.start_seconds != null && (play
                        ? <button type="button" onClick={() => play(it.start_seconds)} className="mr-1.5 font-mono text-[11.5px] text-[var(--brand)] hover:underline cursor-pointer">{clockOf(it.start_seconds)}</button>
                        : <span className="mr-1.5 font-mono text-[11.5px] text-subtle">{clockOf(it.start_seconds)}</span>)}
                      “{it.quote}”
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  }
  // approved
  return (
    <Card>
      <CardHeader title="Tasks created from this meeting" />
      {!r.approved_tasks.length ? <p className="px-4 pb-4 text-[13px] text-subtle">No tasks have been approved from this meeting yet.</p> : (
        <ul className="divide-y divide-line">
          {r.approved_tasks.map((t: any) => (
            <li key={t.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <Link to={`/action-items?open=${t.id}`} className="text-[14px] font-medium text-ink hover:underline">{t.title}</Link>
                <p className="text-[12.5px] text-subtle">
                  {t.owner_name || 'Unassigned'}{t.due_date ? ` · due ${fmtDate(t.due_date)}` : ''}
                  {t.approved_by_name ? ` · approved by ${t.approved_by_name}` : ''}{t.approved_at ? ` on ${fmtDate(t.approved_at)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {t.said_at != null && play && <button type="button" onClick={() => play(t.said_at)} className="text-[12.5px] text-[var(--brand)] hover:underline cursor-pointer"><Clock size={12} className="inline -mt-0.5" /> {clockOf(t.said_at)}</button>}
                <Badge tone={t.completed_at ? 'positive' : 'info'}>{t.completed_at ? 'Done' : String(t.status || '').replace(/_/g, ' ')}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TranscriptView({ lines, play }: { lines: any[]; play: ((s: number | null) => void) | null }) {
  const [q, setQ] = useState('');
  const [speaker, setSpeaker] = useState('');
  const speakers = useMemo(() => [...new Set(lines.map((l) => l.speaker).filter(Boolean))] as string[], [lines]);
  const needle = q.trim().toLowerCase();
  const shown = lines.filter((l) => (!speaker || l.speaker === speaker) && (!needle || String(l.text).toLowerCase().includes(needle)));
  if (!lines.length) return <Card className="p-4 text-[13.5px] text-subtle">The transcript is empty.</Card>;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" className="pl-8" aria-label="Search the transcript" />
        </div>
        {speakers.length > 1 && (
          <Select value={speaker} onChange={(e) => setSpeaker(e.target.value)} className="w-full sm:w-52" aria-label="Speaker">
            <option value="">Everyone</option>
            {speakers.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
          </Select>
        )}
        {(needle || speaker) && <span className="text-[12.5px] text-subtle">{shown.length} of {lines.length} lines</span>}
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-2">
        {!shown.length && <p className="p-3 text-[13px] text-subtle">No line matches.</p>}
        {shown.map((l, idx) => (
          <div key={l.i ?? idx} className="flex gap-3 rounded px-2 py-1.5 text-[13.5px] hover:bg-sunken">
            {l.start != null && (play
              ? <button type="button" onClick={() => play(l.start)} title="Play the recording from here" className="w-12 shrink-0 text-left font-mono text-[11.5px] text-[var(--brand)] hover:underline cursor-pointer">{clockOf(l.start)}</button>
              : <span className="w-12 shrink-0 font-mono text-[11.5px] text-subtle">{clockOf(l.start)}</span>)}
            <p className="min-w-0">{l.speaker && <span className="font-medium text-ink">{l.speaker}: </span>}<span className="text-muted"><Highlight text={String(l.text)} q={q.trim()} /></span></p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SummaryView({ summary: s, open: x }: { summary: any; open: any }) {
  if (!s) return <Card className="p-4 text-[13.5px] text-subtle">No summary yet.</Card>;
  const list = (label: string, items?: string[]) => (items?.length ? (
    <div key={label}>
      <p className="label-cap mb-1">{label}</p>
      <ul className="space-y-1 text-[13px] text-muted">{items.map((t, i) => <li key={i} className="flex gap-1.5"><span className="text-subtle">·</span>{t}</li>)}</ul>
    </div>
  ) : null);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card className="p-4 space-y-3">
        <p className="flex items-center gap-1.5 text-[14px] font-semibold text-ink"><Sparkles size={15} className="text-[var(--brand)]" /> Summary</p>
        {s.overview && <p className="text-[13.5px] leading-relaxed text-ink">{s.overview}</p>}
        {s.participants?.length > 0 && (
          <p className="text-[13px] text-muted"><span className="label-cap mr-2">Participants</span>
            {s.participants.map((p: any) => `${p.name}${p.host ? ' (host)' : ''}${p.attended ? '' : ' (did not join)'}`).join(', ')}</p>
        )}
        {list('Decisions', s.decisions)}{list('Conclusions', s.conclusions)}{list('Updates', s.updates)}
        {list('Problems', s.problems)}{list('Client discussions', s.client_discussions)}{list('Topics', s.topics)}
      </Card>
      <Card className="p-4 space-y-3">
        <p className="text-[14px] font-semibold text-ink">Still open</p>
        {x ? <>
          {list('Risks raised', x.risks)}{list('Issues that keep coming up', x.repeated_issues)}{list('Pending decisions', x.pending_decisions)}
          {list('Unresolved issues', x.unresolved_issues)}{list('Tasks with nobody assigned', x.unassigned_tasks)}{list('Unclear deadlines', x.unclear_deadlines)}
          {list('Follow-up meetings needed', x.follow_up_meetings)}{list('Follow-ups needed', x.follow_ups)}
        </> : null}
        {x && !Object.values(x).some((v: any) => v?.length) && <p className="text-[13px] text-subtle">Nothing left open.</p>}
      </Card>
    </div>
  );
}

const TRANSCRIPT_STATUS: Record<string, string> = {
  recording: 'Being recorded now.',
  waiting: 'Waiting for the last audio files from the video service.',
  queued: 'Queued for transcription.',
  transcribing: 'Transcribing…',
  analyzing: 'Transcribed. The AI is writing the summary and proposed tasks.',
  review: 'Ready: the summary and proposed tasks are waiting for review.',
  completed: 'Reviewed.',
  failed: 'Transcription stopped with a problem.',
};

/** Recordings and the transcript for people on the meeting (the API decides who may see them). */
function RecordingsCard({ meetingId }: { meetingId: string }) {
  const toast = useToast();
  // ?t=41 (from a proposed task's "Play the recording at 0:41"): start the first video there.
  const startAt = Number(new URLSearchParams(useLocation().search).get('t')) || 0;
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['ai-meetings', 'recordings', meetingId],
    queryFn: () => api.get<any>(`/ai-meetings/${meetingId}/recordings`).then((r) => r.data),
    retry: false,
    // Signed links last an hour; refresh well before, and while a transcript is moving.
    refetchInterval: (query) => (['recording', 'waiting', 'queued', 'transcribing', 'analyzing'].includes(query.state.data?.transcript?.status) ? 15_000 : 30 * 60_000),
  });
  if (q.isLoading) return <Skeleton className="h-32 lg:col-span-2" />;
  if (q.isError) return null; // not on the meeting: nothing to show
  const { recordings, transcript, can_delete: canDelete } = q.data;
  if (!recordings.length && !transcript) {
    return <Card className="p-4 lg:col-span-2 text-[13px] text-subtle">Nothing was recorded in this meeting.</Card>;
  }
  const remove = async (id: string) => {
    if (!window.confirm('Delete this recording? The video file is removed for everyone and cannot be recovered.')) return;
    try { await api.del(`/ai-meetings/${meetingId}/recordings/${id}`); q.refetch(); toast.info('Recording deleted'); } catch (e: any) { toast.error(e?.message); }
  };
  return (
    <Card className="p-4 space-y-4 lg:col-span-2">
      {recordings.length > 0 && (
        <div className="space-y-3">
          <p className="label-cap">Recordings</p>
          {recordings.map((r: any, idx: number) => (
            <div key={r.id} className="space-y-1.5">
              {r.url ? (
                <video controls preload="metadata" src={r.url} className="w-full max-h-[420px] rounded-lg bg-black" aria-label="Meeting recording"
                  ref={idx === 0 && startAt ? (el) => { if (el && !el.dataset.sought) { el.scrollIntoView({ block: 'center' }); } } : undefined}
                  onLoadedMetadata={idx === 0 && startAt ? (e) => {
                    const v = e.currentTarget;
                    if (!v.dataset.sought) { v.currentTime = Math.min(startAt, Math.max(0, (v.duration || startAt) - 1)); v.dataset.sought = '1'; }
                  } : undefined} />
              ) : (
                <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-muted">
                  {r.status === 'failed' ? `This recording failed${r.error ? `: ${r.error}` : ''}.` : 'Still being written by the video service. It appears here when it is ready.'}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-subtle">
                <span>{r.file_started_at ? when(r.file_started_at) : when(r.created_at)}</span>
                {r.duration_seconds ? <span>{Math.round(r.duration_seconds / 60)} min</span> : null}
                {r.started_by_name && <span>Started by {r.started_by_name}</span>}
                {canDelete && r.status !== 'starting' && r.status !== 'active' && (
                  <button type="button" onClick={() => remove(r.id)} className="text-[var(--negative)] hover:underline cursor-pointer">Delete recording</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {transcript && (
        <div>
          <p className="label-cap mb-1">Transcript</p>
          <p className="text-[13.5px] text-ink">{TRANSCRIPT_STATUS[transcript.status] || transcript.status}{transcript.error ? ` ${transcript.error}` : ''}</p>
          {transcript.ai_meeting_id && can('meeting_intelligence', 'view') && (
            <Link to={`/meeting-intel/${transcript.ai_meeting_id}`} className="mt-1 inline-flex items-center gap-1 text-[13px] text-[var(--brand)] hover:underline">
              <Sparkles size={13} /> Open transcript, summary and proposed tasks
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}

const Info = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-3"><span className="w-28 shrink-0 text-subtle">{label}</span><span className="text-ink min-w-0">{children}</span></div>
);

function ScopeChoice({ m, scope, setScope }: { m: Meeting; scope: string; setScope: (s: string) => void }) {
  if (!m.series_id) return null;
  return (
    <Field label="Apply to">
      <Select value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="occurrence">Only this meeting</option>
        <option value="series">This and all later meetings in the series</option>
      </Select>
    </Field>
  );
}

function EditMeeting({ m, onClose, onSaved }: { m: Meeting; onClose: () => void; onSaved: (m: Meeting) => void }) {
  const dir = useDirectory();
  const toast = useToast();
  const start = new Date(m.scheduled_at);
  const local = new Date(start.getTime() - start.getTimezoneOffset() * 60_000).toISOString();
  const [f, setF] = useState<FormState>({
    title: m.title, description: m.description || '', agenda: m.agenda || '', date: local.slice(0, 10), time: local.slice(11, 16),
    duration_minutes: m.duration_minutes, host_id: m.host_id || '', participant_ids: [], departments: [], department: m.department || '',
    project_id: m.project_id || '', client_id: m.client_id || '', access: m.access, recording_allowed: m.recording_allowed,
    transcription_allowed: m.transcription_allowed, recurrence: '', recurrence_until: '',
  });
  const [scope, setScope] = useState('occurrence');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch<Meeting>(`/ai-meetings/${m.id}`, {
        title: f.title, description: f.description || null, agenda: f.agenda || null, date: f.date, time: f.time,
        duration_minutes: f.duration_minutes, host_id: f.host_id || m.host_id, department: f.department || null,
        project_id: f.project_id || null, client_id: f.client_id || null, access: f.access,
        recording_allowed: f.recording_allowed, transcription_allowed: f.transcription_allowed, scope,
      });
      onSaved(r.data); toast.success('Saved. Attendees were told about any change of time.'); onClose();
    } catch (e: any) { toast.error(e?.message || 'Could not save'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Reschedule or edit" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} disabled={f.title.trim().length < 2}>Save changes</Button></>}>
      {dir.data ? <div className="space-y-4"><ScopeChoice m={m} scope={scope} setScope={setScope} /><MeetingForm f={f} setF={setF} dir={dir.data} editing /></div> : <Skeleton className="h-64" />}
    </Modal>
  );
}

function InvitePeople({ m, onClose, onSaved }: { m: Meeting; onClose: () => void; onSaved: (m: Meeting) => void }) {
  const dir = useDirectory();
  const toast = useToast();
  const already = new Set(m.attendees.map((a: any) => a.user_id));
  const [ids, setIds] = useState<string[]>([]);
  const [deps, setDeps] = useState<string[]>([]);
  const [scope, setScope] = useState('occurrence');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>(`/ai-meetings/${m.id}/invite`, { participant_ids: ids, departments: deps, scope });
      onSaved(r.data.meeting);
      toast.success(r.data.added ? `${r.data.added} invited${r.data.already_invited ? `, ${r.data.already_invited} already were` : ''}.` : 'Everyone selected was already invited.');
      onClose();
    } catch (e: any) { toast.error(e?.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Invite people" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ids.length && !deps.length} onClick={save}>Send invitations</Button></>}>
      {dir.data ? (
        <div className="space-y-3">
          <ScopeChoice m={m} scope={scope} setScope={setScope} />
          <PeoplePicker dir={{ ...dir.data, people: dir.data.people.filter((p: any) => !already.has(p.id)) }} selected={ids} departments={deps}
            onChange={(a, b) => { setIds(a); setDeps(b); }} />
        </div>
      ) : <Skeleton className="h-64" />}
    </Modal>
  );
}

function CancelMeeting({ m, onClose, onSaved }: { m: Meeting; onClose: () => void; onSaved: (m: Meeting) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState('occurrence');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { onSaved((await api.post<Meeting>(`/ai-meetings/${m.id}/cancel`, { reason: reason || undefined, scope })).data); toast.info('Cancelled. Attendees have been told.'); onClose(); }
    catch (e: any) { toast.error(e?.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Cancel this meeting?" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Keep it</Button><Button variant="danger" loading={busy} onClick={go}>Cancel meeting</Button></>}>
      <div className="space-y-3">
        <ScopeChoice m={m} scope={scope} setScope={setScope} />
        <Field label="Reason (sent to attendees)"><Textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

