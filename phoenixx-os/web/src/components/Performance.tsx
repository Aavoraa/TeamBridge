import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  BookOpen, CheckCircle2, ChevronDown, ChevronRight, Info, RefreshCw, Star, TrendingDown, TrendingUp, Users2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, monthLabel, num, titleCase } from '../lib/format';
import {
  AvatarWithName, Badge, Button, Card, CardHeader, Drawer, EmptyState, ErrorState, Field, Input, Meter,
  Select, StatusBadge, Table, TableSkeleton, TD, TH, THead, TR, Textarea, useToast, cx,
} from './ui';

/**
 * Performance scorecards (v2). The server computes every number; this file
 * only lays them out - and, through the "How it's calculated" notes, explains
 * them in plain language with the workspace's live weights.
 */

const BAND_UI: Record<string, { label: string; tone: any }> = {
  outstanding: { label: 'Outstanding', tone: 'positive' },
  strong: { label: 'Strong', tone: 'positive' },
  meets: { label: 'Meets expectations', tone: 'info' },
  needs_improvement: { label: 'Needs improvement', tone: 'warning' },
  concern: { label: 'Concern', tone: 'negative' },
};

export function BandBadge({ band, provisional }: { band?: string | null; provisional?: boolean }) {
  if (!band) return <Badge tone="neutral">{provisional ? 'Provisional' : 'Not enough data'}</Badge>;
  const ui = BAND_UI[band];
  return <Badge tone={ui.tone} dot>{ui.label}</Badge>;
}

const scoreTone = (s?: number | null) => (s == null ? 'neutral' : s >= 75 ? 'positive' : s >= 60 ? 'brand' : s >= 45 ? 'warning' : 'negative');
const fmt = (s?: number | null) => (s == null ? '—' : num(s, 1));

function Stars({ value }: { value?: number | null }) {
  if (!value) return <span className="text-subtle text-[12.5px]">not rated</span>;
  return (
    <span className="flex items-center gap-0.5" aria-label={`${value} out of 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} size={12} className={i < value ? 'fill-[var(--accent-bg)] text-[var(--accent-bg)]' : 'text-line-strong'} />
      ))}
    </span>
  );
}

/** Each pillar's raw inputs as one readable sentence. */
function describeInputs(p: any): string {
  const i = p.inputs || {};
  switch (p.key) {
    case 'delivery':
      return `${i.on_time} on time, ${i.late} late, ${i.overdue} overdue of ${i.judged} judged task(s)`
        + `${i.not_yet_due ? ` · ${i.not_yet_due} not yet due (left out)` : ''} · priority-weighted ${i.weighted_earned} of ${i.weighted_possible}`;
    case 'quality':
      return `${i.first_time_pass} of ${i.reviewed} reviewed task(s) passed first time · ${i.rework_rounds} rework round(s)`;
    case 'reporting':
      return `Daily update filed on ${i.days_filed} of ${i.days_expected} working day(s) with open tasks`;
    case 'attendance':
      return `${i.attendance_pct}% present over ${i.working_days} working day(s) · ${i.unexcused_late} unexcused late arrival(s) · punctuality ${i.punctuality_pct}%`;
    case 'process':
      return `${i.sop_runs} SOP run(s)${i.avg_adherence_pct != null ? ` at ${i.avg_adherence_pct}% adherence` : ''} · ${i.acknowledged} of ${i.sops_to_acknowledge} SOP(s) acknowledged`;
    case 'own_work':
      return `Your own delivery ${fmt(i.delivery)} and quality ${fmt(i.quality)}`;
    case 'team_delivery':
    case 'team_discipline':
      return i.direct_reports
        ? `${i.scored} of ${i.direct_reports} direct report(s) had data${i.members?.length ? `: ${i.members.map((m: any) => `${m.name} ${m.score}`).join(', ')}` : ''}`
        : 'No direct reports';
    case 'project_health':
      return i.projects_managed
        ? `${i.projects_managed} project(s) managed · health ${fmt(i.health_pct)} · your update filed ${i.update_days_filed} of ${i.update_days_expected} day(s)`
        : 'No active project where you hold the manager seat';
    case 'responsiveness':
      return i.decisions ? `${i.decisions} decision(s), average ${i.avg_hours}h to decide · ${i.within_24h} within 24h` : 'No approvals or sign-offs decided';
    case 'escalations':
      return `${i.escalations} escalation(s) raised to you · team of ${i.team_size}`;
    default:
      return '';
  }
}

const NEEDS: Record<string, (m: any) => string> = {
  delivery: (m) => `needs ${m.delivery}+ tasks due and judged`,
  quality: (m) => `needs ${m.quality}+ tasks reviewed by someone else`,
  reporting: (m) => `needs ${m.reporting}+ working days with open tasks`,
  attendance: (m) => `needs ${m.attendance}+ working days`,
  process: () => 'needs an SOP run or an SOP to acknowledge',
  own_work: () => 'needs own delivery or quality data',
  team_delivery: () => 'needs a direct report with data',
  team_discipline: () => 'needs a direct report with data',
  project_health: (m) => `needs a managed project active ${m.project_days}+ working days`,
  responsiveness: (m) => `needs ${m.responsiveness}+ decisions`,
  escalations: () => 'needs a team or a managed project',
};

/* ================================================================== TAB */
export function PerformanceTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can, user } = useAuth();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const [notes, setNotes] = useState(false);

  const list = useQuery({
    queryKey: ['performance', month],
    queryFn: () => api.get('/hr/performance', { month }).then((r) => r.data),
  });
  const mine = useQuery({
    queryKey: ['scorecard', month, 'me'],
    queryFn: () => api.get('/hr/performance/scorecard', { month }).then((r) => r.data),
  });
  const config = useQuery({ queryKey: ['performance-config'], queryFn: () => api.get('/hr/performance/config').then((r) => r.data) });

  const generate = useMutation({
    mutationFn: () => api.post('/hr/performance/generate', { month }),
    onSuccess: (res: any) => {
      toast.success(`${res.data.generated} scorecard(s) computed from source records.`);
      qc.invalidateQueries({ queryKey: ['performance'] });
      qc.invalidateQueries({ queryKey: ['scorecard'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });
  const others = (list.data ?? []).filter((r: any) => r.user_id !== user?.id);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" className="w-[150px]">
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </Select>
        <Button variant="ghost" icon={<BookOpen size={15} />} onClick={() => setNotes(true)}>How it's calculated</Button>
        {can('hr_performance', 'create') && (
          <Button className="ml-auto" icon={<RefreshCw size={15} className={generate.isPending ? 'animate-spin' : ''} />}
            loading={generate.isPending} onClick={() => generate.mutate()}>
            Recompute scorecards
          </Button>
        )}
      </div>

      {mine.data?.card && (
        <MyScorecard data={mine.data} minSample={config.data?.min_sample}
          onOpen={() => setOpen({ id: user!.id, name: 'Your scorecard' })} />
      )}

      {list.error ? <ErrorState error={list.error} retry={list.refetch} />
        : list.isLoading ? <Card><TableSkeleton cols={7} /></Card>
          : others.length > 0 ? (
            <Card>
              <CardHeader title={user?.role === 'manager' ? 'Your team' : 'Everyone'} icon={<Users2 size={16} />}
                subtitle={`${monthLabel(month)} · stored scorecards · click a row for the full breakdown`} />
              <Table>
                <THead>
                  <tr>
                    <TH width="56px" align="right">Rank</TH>
                    <TH>Person</TH>
                    <TH align="right" width="90px">System</TH>
                    <TH width="110px">Rating</TH>
                    <TH align="right" width="90px">Overall</TH>
                    <TH width="170px">Band</TH>
                    <TH width="190px">Weakest area</TH>
                    <TH width="120px">Status</TH>
                  </tr>
                </THead>
                <tbody>
                  {others.map((r: any, i: number) => {
                    const weakest = (r.pillars || []).filter((p: any) => p.score != null)
                      .sort((a: any, b: any) => a.score - b.score)[0];
                    return (
                      <TR key={r.id} onClick={() => setOpen({ id: r.user_id, name: r.user_name })}>
                        <TD align="right"><span className="tabular text-subtle">{r.rank != null ? i + 1 : '—'}</span></TD>
                        <TD>
                          <span className="flex items-center gap-2">
                            <AvatarWithName name={r.user_name} url={r.avatar_url} sub={r.designation || titleCase(r.user_role)} size={28} />
                            {r.scorecard_kind === 'manager' && <Badge tone="accent">Manager</Badge>}
                          </span>
                        </TD>
                        <TD align="right"><span className="tabular">{fmt(r.system_score)}</span></TD>
                        <TD><Stars value={r.manager_rating} /></TD>
                        <TD align="right"><span className="tabular font-semibold">{fmt(r.overall_score)}</span></TD>
                        <TD><BandBadge band={r.band} provisional={r.overall_score != null} /></TD>
                        <TD>
                          {weakest ? (
                            <span className="text-[12.5px]">
                              <span className="text-ink">{weakest.label}</span>
                              <span className={cx('ml-1.5 tabular', weakest.score < 60 ? 'text-[var(--negative)]' : 'text-subtle')}>{fmt(weakest.score)}</span>
                            </span>
                          ) : <span className="text-subtle text-[12.5px]">—</span>}
                        </TD>
                        <TD><StatusBadge status={r.status} /></TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
            </Card>
          ) : (list.data?.length ?? 0) === 0 && can('hr_performance', 'create') ? (
            <Card>
              <EmptyState icon={<TrendingUp size={20} />} title={`No stored scorecards for ${monthLabel(month)}`}
                message="Scorecards are stored automatically on the 1st for the month before. Compute them now to rate and review."
                action={<Button variant="primary" loading={generate.isPending} onClick={() => generate.mutate()}>Compute scorecards</Button>} />
            </Card>
          ) : null}

      {open && <ScorecardDrawer userId={open.id} name={open.name} month={month} self={open.id === user?.id}
        onClose={() => setOpen(null)} onNotes={() => setNotes(true)} />}
      {notes && <HowItWorks onClose={() => setNotes(false)} />}
    </>
  );
}

/* ======================================================== MY SCORECARD */
function MyScorecard({ data, minSample, onOpen }: { data: any; minSample?: any; onOpen: () => void }) {
  const c = data.card;
  const provisional = !c.band && c.overall_score != null;
  return (
    <Card className="mb-4">
      <div className="grid gap-4 p-4 md:grid-cols-[220px_1fr]">
        <div>
          <p className="label-cap">Your score · {monthLabel(data.period.month)}</p>
          <p className={cx('mt-1 text-[40px] leading-none font-semibold tabular',
            c.overall_score == null ? 'text-subtle' : 'text-ink')}>{fmt(c.overall_score)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <BandBadge band={c.band} provisional={provisional} />
            <Badge tone="neutral">{c.kind === 'manager' ? 'Manager card' : 'Employee card'}</Badge>
          </div>
          <p className="mt-2 text-[12px] text-subtle leading-relaxed">
            {data.period.inProgress ? `Month to date, up to ${date(data.period.to)}. ` : ''}
            {data.review?.manager_rating ? `Includes your manager's ${data.review.manager_rating}/5 rating.` : 'Not rated yet - this is the system score alone.'}
            {provisional && ' Too little of the card has data yet, so no band is given.'}
          </p>
          <Button size="sm" className="mt-3" onClick={onOpen}>See full breakdown</Button>
        </div>
        <div className="space-y-2.5">
          {c.pillars.map((p: any) => (
            <div key={p.key}>
              <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="text-ink">{p.label} <span className="text-subtle">· {p.weight}%</span></span>
                <span className="tabular text-muted">
                  {p.score != null ? fmt(p.score) : <span className="text-subtle">not enough data</span>}
                </span>
              </div>
              <Meter value={p.score ?? 0} tone={scoreTone(p.score)} className="mt-1" />
              {p.score == null && minSample && <p className="mt-0.5 text-[11px] text-subtle">{NEEDS[p.key]?.(minSample)}</p>}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/* ====================================================== FULL BREAKDOWN */
function ScorecardDrawer({ userId, name, month, self, onClose, onNotes }: {
  userId: string; name: string; month: string; self: boolean; onClose: () => void; onNotes: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['scorecard', month, userId],
    queryFn: () => api.get('/hr/performance/scorecard', { month, user_id: userId }).then((r) => r.data),
  });
  const { data: config } = useQuery({ queryKey: ['performance-config'], queryFn: () => api.get('/hr/performance/config').then((r) => r.data) });
  const { data: history } = useQuery({
    queryKey: ['performance-history', userId],
    queryFn: () => api.get(`/hr/performance/history/${userId}`).then((r) => r.data),
  });

  const ack = useMutation({
    mutationFn: () => api.post(`/hr/performance/${data.review.id}/acknowledge`, {}),
    onSuccess: () => {
      toast.success('Review acknowledged.');
      qc.invalidateQueries({ queryKey: ['scorecard'] });
      qc.invalidateQueries({ queryKey: ['performance'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const c = data?.card;
  const review = data?.review;

  return (
    <Drawer open onClose={onClose} width="max-w-3xl"
      title={c ? `${self ? 'Your scorecard' : c.user.name} · ${monthLabel(month)}` : name}
      subtitle={c ? `${c.kind === 'manager' ? 'Manager' : 'Employee'} card · ${data.period.inProgress ? `month to date, to ${date(data.period.to)}` : `${date(data.period.from)} – ${date(data.period.to)}`}` : undefined}
      footer={(
        <>
          <Button variant="ghost" icon={<BookOpen size={15} />} onClick={onNotes}>How it's calculated</Button>
          {self && review?.status === 'submitted' && (
            <Button variant="primary" icon={<CheckCircle2 size={15} />} loading={ack.isPending} onClick={() => ack.mutate()}>
              Acknowledge review
            </Button>
          )}
        </>
      )}>
      {error ? <div className="p-5"><ErrorState error={error} retry={refetch} /></div>
        : isLoading ? <div className="p-5"><TableSkeleton rows={5} cols={2} /></div>
          : !c ? <div className="p-5"><EmptyState title="Not scored" message={data?.reason || 'No scorecard for this person.'} /></div>
            : (
              <div className="p-5 space-y-5">
                <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                  <Box label="Overall" value={fmt(c.overall_score)} strong />
                  <Box label="System score" value={fmt(c.system_score)} sub={`${c.coverage_pct}% of the card has data`} />
                  <Box label="Manager rating" value={review?.manager_rating ? `${review.manager_rating}/5` : '—'}
                    sub={`${data.weights.rating_share}% of overall`} />
                  <div className="rounded-lg bg-sunken p-3">
                    <p className="label-cap">Band</p>
                    <div className="mt-1.5"><BandBadge band={c.band} provisional={c.overall_score != null} /></div>
                  </div>
                </div>

                <p className="flex gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-[12.5px] text-muted">
                  <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    Overall = system score × {100 - data.weights.rating_share}% + rating × 20 × {data.weights.rating_share}%.
                    {c.system_score != null && review?.manager_rating
                      ? ` Here: ${fmt(c.system_score)} × ${(100 - data.weights.rating_share) / 100} + ${review.manager_rating * 20} × ${data.weights.rating_share / 100} = ${fmt(c.overall_score)}.`
                      : ' Until a rating is given, overall equals the system score.'}
                  </span>
                </p>

                <section className="space-y-2">
                  <p className="label-cap">The areas, and what moved them</p>
                  {c.pillars.map((p: any) => <PillarRow key={p.key} p={p} minSample={config?.min_sample} />)}
                </section>

                {history?.length > 1 && (
                  <section>
                    <p className="label-cap mb-2">Trend</p>
                    <ResponsiveContainer width="100%" height={170}>
                      <LineChart data={history.map((h: any) => ({ ...h, label: monthLabel(h.period_month).split(' ')[0] }))}
                        margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                        <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={32} />
                        <Tooltip contentStyle={{ background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                        <Line type="monotone" dataKey="overall_score" name="Overall" stroke="#1e40af" strokeWidth={2} dot={{ r: 2.5 }} />
                        <Line type="monotone" dataKey="system_score" name="System" stroke="#15803d" strokeWidth={1.5} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                    <TrendNote history={history} />
                  </section>
                )}

                <ReviewSection data={data} month={month} />
              </div>
            )}
    </Drawer>
  );
}

function TrendNote({ history }: { history: any[] }) {
  const s = history.map((h) => h.overall_score).filter((x) => x != null);
  if (s.length < 3) return null;
  const [a, b, c] = s.slice(-3);
  if (c < b && b < a) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[12px] text-[var(--warning)]">
        <TrendingDown size={13} aria-hidden /> Down two months running - worth a conversation.
      </p>
    );
  }
  return null;
}

function PillarRow({ p, minSample }: { p: any; minSample?: any }) {
  const [open, setOpen] = useState(p.score != null && p.score < 75 && p.drivers?.length > 0);
  return (
    <div className="rounded-lg border border-line bg-raised">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 p-3 text-left cursor-pointer">
        {open ? <ChevronDown size={15} className="text-subtle shrink-0" /> : <ChevronRight size={15} className="text-subtle shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-[13.5px] font-medium text-ink">{p.label}</span>
            <span className="text-[11.5px] text-subtle">weight {p.weight}%</span>
          </span>
          <span className="block text-[12px] text-subtle truncate">{describeInputs(p)}</span>
        </span>
        <span className="w-28 shrink-0">
          {p.score != null ? (
            <span className="flex items-center gap-2">
              <Meter value={p.score} tone={scoreTone(p.score)} className="flex-1" />
              <span className="tabular text-[13px] text-ink w-9 text-right">{fmt(p.score)}</span>
            </span>
          ) : <span className="text-[12px] text-subtle">not enough data</span>}
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2.5 text-[12.5px] space-y-1.5">
          {p.score == null && minSample && <p className="text-subtle">Not scored: {NEEDS[p.key]?.(minSample)}. Its weight is shared across the scored areas.</p>}
          {p.drivers?.length > 0 && (
            <div>
              <p className="label-cap mt-1 mb-1">What pulled it down</p>
              <ul className="space-y-1">
                {p.drivers.map((d: any, i: number) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-[var(--negative)]">•</span>
                    <span>
                      {d.ref ? <a href={d.ref} className="text-ink hover:underline">{d.text}</a> : <span className="text-ink">{d.text}</span>}
                      {d.detail && <span className="text-subtle"> - {d.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.score != null && !p.drivers?.length && <p className="text-subtle">Nothing pulled this area down.</p>}
        </div>
      )}
    </div>
  );
}

function ReviewSection({ data, month }: { data: any; month: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const review = data.review;
  const [rating, setRating] = useState<number>(review?.manager_rating || 0);
  const [strengths, setStrengths] = useState(review?.strengths || '');
  const [improvements, setImprovements] = useState(review?.improvements || '');

  const save = useMutation({
    mutationFn: (status: 'draft' | 'submitted') => api.patch(`/hr/performance/${review.id}`, {
      manager_rating: rating || undefined, strengths: strengths || null, improvements: improvements || null, status,
    }),
    onSuccess: (_r: any, status) => {
      toast.success(status === 'submitted' ? 'Review submitted. They have been told.' : 'Draft saved.');
      qc.invalidateQueries({ queryKey: ['scorecard'] });
      qc.invalidateQueries({ queryKey: ['performance'] });
      qc.invalidateQueries({ queryKey: ['performance-history'] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (!review) {
    return (
      <p className="rounded-md border border-line px-3 py-2 text-[12.5px] text-subtle">
        This is a live computation. The review (rating and notes) opens once {monthLabel(month)}'s scorecards are stored -
        automatically on the 1st of next month, or with "Recompute scorecards".
      </p>
    );
  }

  return (
    <section className="space-y-3 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-2">
        <p className="label-cap">Review</p>
        <span className="flex items-center gap-2">
          <StatusBadge status={review.status} />
          {review.acknowledged_at && <span className="text-[11.5px] text-subtle">acknowledged {date(review.acknowledged_at)}</span>}
        </span>
      </div>
      {data.can_rate ? (
        <>
          <Field label="Your rating" hint={`${data.weights.rating_share}% of the overall · 1 = well below, 3 = as expected, 5 = exceptional`}>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} out of 5`} className="cursor-pointer p-0.5">
                  <Star size={24} className={cx('transition-colors duration-150',
                    n <= rating ? 'fill-[var(--accent-bg)] text-[var(--accent-bg)]' : 'text-line-strong hover:text-[var(--accent-bg)]')} />
                </button>
              ))}
              {rating > 0 && <span className="ml-2 text-[13px] text-muted">{rating} of 5</span>}
            </div>
          </Field>
          <Field label="What went well"><Textarea value={strengths} onChange={(e) => setStrengths(e.target.value)} rows={3} /></Field>
          <Field label="What to improve next month"><Textarea value={improvements} onChange={(e) => setImprovements(e.target.value)} rows={3} /></Field>
          <div className="flex justify-end gap-2">
            <Button loading={save.isPending && save.variables === 'draft'} onClick={() => save.mutate('draft')}>Save draft</Button>
            <Button variant="primary" disabled={!rating} loading={save.isPending && save.variables === 'submitted'}
              onClick={() => save.mutate('submitted')}>Submit review</Button>
          </div>
        </>
      ) : (
        <div className="space-y-2 text-[13px]">
          <p className="flex items-center gap-2"><span className="text-subtle w-28">Rating</span><Stars value={review.manager_rating} /></p>
          {review.strengths && <p><span className="text-subtle">What went well: </span>{review.strengths}</p>}
          {review.improvements && <p><span className="text-subtle">To improve: </span>{review.improvements}</p>}
          {!review.manager_rating && <p className="text-subtle">Waiting on the reviewer.</p>}
        </div>
      )}
    </section>
  );
}

const Box = ({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) => (
  <div className="rounded-lg bg-sunken p-3">
    <p className="label-cap">{label}</p>
    <p className={cx('mt-1 tabular text-ink', strong ? 'text-[24px] font-semibold' : 'text-[18px] font-semibold')}>{value}</p>
    {sub && <p className="text-[11px] text-subtle">{sub}</p>}
  </div>
);

/* ========================================================== THE NOTES */
const EMPLOYEE_ROWS: [string, string][] = [
  ['delivery', 'Tasks due this month that you own or are co-assigned to. On time = full credit, late = half, overdue and not done = none. Each task counts by priority: urgent ×3, high ×2, medium ×1, low ×0.5. Tasks not yet due are left out.'],
  ['quality', 'Of your tasks reviewed by someone else this month, the share validated first time with no "changes requested". Tasks you raised and closed yourself prove nothing, so they are left out.'],
  ['reporting', 'Working days on which you had at least one open task: on how many did you file a daily update? Today is not judged until it is over.'],
  ['attendance', '80% presence + 20% punctuality. Present or WFH = 1 day, half day = ½. A working day with no check-in counts as absent. Late arrivals count only if nobody excused them (no approved permission, no HR approval).'],
  ['process', '70% the average adherence of the SOP checklists you ran + 30% the share of published SOPs (for your service line) you have acknowledged.'],
];
const MANAGER_ROWS: [string, string][] = [
  ['own_work', 'Your own delivery and quality, measured exactly as on the employee card.'],
  ['team_delivery', 'The average delivery-and-quality score of your direct reports.'],
  ['project_health', 'Projects where you hold the manager seat: 60% how healthy the daily updates were (on track 100, at risk 50, blocked 0, worst update of each day) + 40% the share of working days you filed your own project update.'],
  ['responsiveness', 'Average time you took to decide task sign-offs, leave, late check-ins and reimbursements. 24 hours or less scores 100, falling evenly to 0 at 5 days.'],
  ['team_discipline', 'The average reporting-and-attendance score of your direct reports.'],
  ['escalations', 'Starts at 100. Each escalation raised to you costs 20 points, divided by the size of your team - so a big team is not punished for being big.'],
];

function HowItWorks({ onClose }: { onClose: () => void }) {
  const { data: cfg, isLoading } = useQuery({ queryKey: ['performance-config'], queryFn: () => api.get('/hr/performance/config').then((r) => r.data) });
  const w = cfg?.weights;
  const m = cfg?.min_sample;

  return (
    <Drawer open onClose={onClose} width="max-w-3xl" title="How performance is calculated"
      subtitle="Notes on the scorecard - every number on it comes from records already in the system">
      {isLoading || !cfg ? <div className="p-5"><TableSkeleton rows={6} cols={2} /></div> : (
        <div className="p-5 space-y-6 text-[13.5px] leading-relaxed text-ink">
          <Note title="1. The idea in one paragraph">
            <p>Everyone except the workspace Owner gets a scorecard each month, scored 0-100. It is split into a few
              <b> areas</b> (delivery, quality, ...). Each area is scored on its own from real records - tasks, sign-offs,
              daily updates, attendance, SOPs - then the areas are blended by <b>weight</b> into the <b>system score</b>.
              The only human input is the manager's 1-5 <b>rating</b>, which is {w.rating_share}% of the <b>overall</b>.</p>
          </Note>

          <Note title="2. The employee card">
            <WeightTable rows={EMPLOYEE_ROWS} weights={w.employee} labels={cfg.pillars} />
          </Note>

          <Note title="3. The manager card">
            <p className="mb-2 text-muted">Anyone with the Manager role, or anyone else with direct reports. It keeps their own work in view and adds how their team and projects did.</p>
            <WeightTable rows={MANAGER_ROWS} weights={w.manager} labels={cfg.pillars} />
          </Note>

          <Note title="4. From areas to the overall score">
            <Formula>system score = Σ (area score × area weight) ÷ Σ (weights of the areas that have data)</Formula>
            <Formula>overall = system score × {100 - w.rating_share}% + (rating × 20) × {w.rating_share}%</Formula>
            <p className="text-muted">A rating of 1 is worth 20, 3 is worth 60, 5 is worth 100. Until the manager rates, the overall equals the system score.</p>
          </Note>

          <Note title="5. Worked example">
            <p className="text-muted mb-2">An employee's month, with the default weights:</p>
            <Table>
              <THead><tr><TH>Area</TH><TH align="right" width="80px">Score</TH><TH align="right" width="80px">Weight</TH><TH align="right" width="110px">Score × weight</TH></tr></THead>
              <tbody>
                {[['Delivery', 80, 35], ['Quality', 90, 20], ['Reporting discipline', 70, 15], ['Attendance & punctuality', 95, 15], ['Process (SOP)', 60, 15]].map(([a, s, wt]) => (
                  <tr key={a as string} className="border-b border-line last:border-0">
                    <TD>{a}</TD><TD align="right">{s}</TD><TD align="right">{wt}%</TD><TD align="right">{num((s as number) * (wt as number) / 100, 2)}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-2">System score = 28 + 18 + 10.5 + 14.25 + 9 = <b>79.75</b>. The manager rates 4/5 (worth 80):
              overall = 79.75 × 0.8 + 80 × 0.2 = <b>79.8 → Strong</b>.</p>
            <p className="mt-1 text-muted">If quality had too few reviewed tasks, it would drop out and the other four would be
              re-weighted over 80 instead of 100: (28 + 10.5 + 14.25 + 9) ÷ 0.8 = 77.2.</p>
          </Note>

          <Note title="6. Fairness rules">
            <ul className="list-disc pl-5 space-y-1">
              <li><b>Not enough data is never zero.</b> An area is only scored with enough evidence - delivery {m.delivery}+ judged tasks,
                quality {m.quality}+ reviewed tasks, reporting {m.reporting}+ days, attendance {m.attendance}+ days, responsiveness
                {' '}{m.responsiveness}+ decisions, a project active {m.project_days}+ days. Otherwise it is left out and its weight is shared by the rest.</li>
              <li><b>No band on a thin card.</b> If less than {cfg.min_coverage}% of the card's weight has data, the score is shown as provisional with no band.</li>
              <li><b>Days off never count against anyone.</b> Weekly offs, company holidays and approved leave are not working days.</li>
              <li><b>Excused is excused.</b> A late arrival covered by an approved permission or approved by HR is not counted.</li>
              <li><b>The current month is month-to-date.</b> Work not yet due and today itself are not judged.</li>
              <li><b>Co-assigned work counts</b> for every person on it, not just the main owner.</li>
            </ul>
          </Note>

          <Note title="7. Bands">
            <div className="flex flex-wrap gap-2">
              {cfg.bands.map((b: any, i: number) => (
                <span key={b.id} className="flex items-center gap-1.5">
                  <BandBadge band={b.id} />
                  <span className="text-[12px] text-subtle tabular">{b.min}{i === 0 ? '+' : `-${cfg.bands[i - 1].min - 1}`}</span>
                </span>
              ))}
            </div>
          </Note>

          <Note title="8. Who sees what, and the monthly cycle">
            <ul className="list-disc pl-5 space-y-1">
              <li><b>Employees</b> see only their own scorecard - never anyone else's, and never a ranking.</li>
              <li><b>Managers</b> see their direct reports and the people on the projects they manage or lead, ranked.</li>
              <li><b>The Owner and HR</b> see everyone.</li>
              <li>A person is rated by their <b>reporting manager</b> (or the Owner / HR). Nobody rates themselves - a manager's card is rated by the Owner.</li>
              <li>On the <b>1st of each month at 9:30 AM</b> last month's scorecards are stored. The manager rates and submits; the person is told and <b>acknowledges</b>.</li>
              <li>"Recompute" refreshes the numbers any time and keeps the rating, notes and status.</li>
            </ul>
          </Note>

          {cfg.can_edit && <WeightEditor cfg={cfg} />}
        </div>
      )}
    </Drawer>
  );
}

const Note = ({ title, children }: { title: string; children: any }) => (
  <section>
    <h3 className="mb-2 text-[14.5px] font-semibold text-ink">{title}</h3>
    {children}
  </section>
);
const Formula = ({ children }: { children: any }) => (
  <p className="my-1.5 rounded-md bg-sunken px-3 py-2 mono text-[12.5px] text-ink">{children}</p>
);

function WeightTable({ rows, weights, labels }: { rows: [string, string][]; weights: any; labels: any }) {
  return (
    <Table>
      <THead><tr><TH width="200px">Area</TH><TH align="right" width="70px">Weight</TH><TH>How it is measured</TH></tr></THead>
      <tbody>
        {rows.map(([k, text]) => (
          <tr key={k} className="border-b border-line last:border-0 align-top">
            <TD className="font-medium">{labels[k]}</TD>
            <TD align="right"><span className="tabular">{weights[k]}%</span></TD>
            <TD><span className="text-[12.5px] text-muted">{text}</span></TD>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function WeightEditor({ cfg }: { cfg: any }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [w, setW] = useState(() => JSON.parse(JSON.stringify(cfg.weights)));
  const sum = (kind: 'employee' | 'manager') => Object.values(w[kind]).reduce((n: number, v: any) => n + Number(v || 0), 0);

  const save = useMutation({
    mutationFn: () => api.put('/hr/performance/config', w),
    onSuccess: () => {
      toast.success('Weights saved. Recompute to apply them to stored scorecards.');
      qc.invalidateQueries({ queryKey: ['performance-config'] });
      qc.invalidateQueries({ queryKey: ['scorecard'] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const set = (kind: string, key: string, v: string) => setW((x: any) => ({ ...x, [kind]: { ...x[kind], [key]: Number(v) } }));
  const valid = sum('employee') === 100 && sum('manager') === 100 && w.rating_share >= 0 && w.rating_share <= 50;

  return (
    <Note title="9. Change the weights (Owner and HR)">
      <div className="grid gap-4 sm:grid-cols-2">
        {(['employee', 'manager'] as const).map((kind) => (
          <div key={kind} className="rounded-lg border border-line p-3 space-y-2">
            <p className="flex justify-between text-[12.5px] font-medium">
              <span>{titleCase(kind)} card</span>
              <span className={cx('tabular', sum(kind) === 100 ? 'text-[var(--positive)]' : 'text-[var(--negative)]')}>{sum(kind)} / 100</span>
            </p>
            {Object.keys(cfg.defaults[kind]).map((k) => (
              <label key={k} className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="text-muted">{cfg.pillars[k]}</span>
                <Input type="number" min={0} max={100} value={w[kind][k]} onChange={(e) => set(kind, k, e.target.value)} className="w-20" />
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Manager rating share (%)" hint="0 to 50">
          <Input type="number" min={0} max={50} value={w.rating_share}
            onChange={(e) => setW((x: any) => ({ ...x, rating_share: Number(e.target.value) }))} className="w-24" />
        </Field>
        <Button onClick={() => setW(JSON.parse(JSON.stringify(cfg.defaults)))}>Reset to defaults</Button>
        <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>Save weights</Button>
      </div>
    </Note>
  );
}
